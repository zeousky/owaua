"""Last-N conversation memory in SQLite."""

from __future__ import annotations

import os
import sqlite3
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from security import API_LIMITS, ApiLimits, BudgetExceeded, DuplicateRequest

MAX_STORED_CHARS = 5700
MAX_STORED_MESSAGES = 10000
CONVERSATION_MESSAGES = 20
CHANNEL_LINE_CHARS = 180
CHANNEL_LINES_KEPT = 40
CHANNEL_CONTEXT_LINES = 12
RETENTION_SECONDS = 7 * 86400


class MemoryStore:
    """SQLite store with one reused connection, guarded by a lock."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.path.parent, 0o700)
        self._lock = threading.RLock()
        self._db: sqlite3.Connection | None = None
        self._settings: dict[str, str | None] = {}
        self._initialize()

    def close(self) -> None:
        with self._lock:
            connection = self._db
            self._db = None
            if connection is not None:
                try:
                    connection.close()
                except sqlite3.Error:
                    pass

    def __del__(self) -> None:
        try:
            self.close()
        except Exception:
            pass

    def _reset_connection(self) -> None:
        connection = self._db
        self._db = None
        if connection is not None:
            try:
                connection.close()
            except sqlite3.Error:
                pass

    def _connect(self) -> sqlite3.Connection:
        if self._db is not None:
            return self._db
        connection = sqlite3.connect(
            self.path, timeout=10, check_same_thread=False
        )
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA synchronous=FULL")
        connection.execute("PRAGMA busy_timeout=10000")
        connection.execute("PRAGMA max_page_count=32768")
        connection.execute("PRAGMA temp_store=MEMORY")
        connection.execute("PRAGMA cache_size=-4000")
        connection.execute("PRAGMA secure_delete=ON")
        self._db = connection
        return connection

    @contextmanager
    def _managed_connection(self) -> Iterator[sqlite3.Connection]:
        connection = self._connect()
        try:
            yield connection
            connection.commit()
        except BaseException:
            try:
                connection.rollback()
            except sqlite3.Error:
                self._reset_connection()
            raise

    def _initialize(self) -> None:
        with self._lock, self._managed_connection() as db:
            db.executescript(
                """
                CREATE TABLE IF NOT EXISTS messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    event_id TEXT NOT NULL UNIQUE,
                    scope_id TEXT NOT NULL,
                    user_id TEXT NOT NULL,
                    server_id TEXT NOT NULL DEFAULT '',
                    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
                    content TEXT NOT NULL,
                    unbounded INTEGER NOT NULL DEFAULT 0 CHECK (unbounded IN (0, 1)),
                    created_at REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS active_channels (
                    scope_id TEXT PRIMARY KEY,
                    enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
                    message_count INTEGER NOT NULL DEFAULT 0,
                    updated_at REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS app_settings (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS messages_conversation_idx
                    ON messages(scope_id, user_id, id);
                CREATE TABLE IF NOT EXISTS channel_lines (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    event_id TEXT NOT NULL UNIQUE,
                    scope_id TEXT NOT NULL,
                    server_id TEXT NOT NULL DEFAULT '',
                    user_id TEXT NOT NULL,
                    author TEXT NOT NULL,
                    content TEXT NOT NULL,
                    created_at REAL NOT NULL
                );
                CREATE INDEX IF NOT EXISTS channel_lines_scope_idx
                    ON channel_lines(scope_id, id);
                CREATE INDEX IF NOT EXISTS channel_lines_server_idx
                    ON channel_lines(server_id);
                CREATE INDEX IF NOT EXISTS channel_lines_user_idx
                    ON channel_lines(user_id);
                CREATE TABLE IF NOT EXISTS api_usage (
                    event_id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL,
                    guild_id TEXT NOT NULL,
                    created_at REAL NOT NULL
                );
                CREATE INDEX IF NOT EXISTS api_usage_time_idx ON api_usage(created_at);
                CREATE INDEX IF NOT EXISTS api_usage_user_time_idx
                    ON api_usage(user_id, created_at);
                CREATE TABLE IF NOT EXISTS api_totals (
                    id INTEGER PRIMARY KEY CHECK(id = 1),
                    requests INTEGER NOT NULL DEFAULT 0,
                    last_time REAL NOT NULL DEFAULT 0
                );
                INSERT OR IGNORE INTO api_totals(id) VALUES (1);
                CREATE TABLE IF NOT EXISTS full_image_generation_usage (
                    event_id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL,
                    created_at REAL NOT NULL
                );
                CREATE INDEX IF NOT EXISTS full_image_generation_usage_user_time_idx
                    ON full_image_generation_usage(user_id, created_at);
                """
            )
            columns = {
                str(row["name"])
                for row in db.execute("PRAGMA table_info(messages)").fetchall()
            }
            if "unbounded" not in columns:
                db.execute(
                    "ALTER TABLE messages ADD COLUMN unbounded INTEGER NOT NULL DEFAULT 0"
                )
            if "server_id" not in columns:
                db.execute(
                    "ALTER TABLE messages ADD COLUMN server_id TEXT NOT NULL DEFAULT ''"
                )
        os.chmod(self.path, 0o600)
        with self._lock, self._managed_connection() as db:
            self._prune(db)

    @staticmethod
    def _prune(db: sqlite3.Connection) -> None:
        db.execute("DELETE FROM messages WHERE unbounded=0 AND created_at<?", (time.time()-RETENTION_SECONDS,))
        db.execute("DELETE FROM messages WHERE id IN (SELECT id FROM messages WHERE unbounded=0 ORDER BY id DESC LIMIT -1 OFFSET ?)", (MAX_STORED_MESSAGES,))
        db.execute("UPDATE messages SET content=substr(content,1,?) WHERE unbounded=0 AND length(content)>?", (MAX_STORED_CHARS, MAX_STORED_CHARS))
        db.execute(
            "DELETE FROM messages WHERE id IN (SELECT id FROM "
            "(SELECT id, row_number() OVER (PARTITION BY scope_id,user_id ORDER BY id DESC) AS n FROM messages WHERE unbounded=0) WHERE n>?)",
            (CONVERSATION_MESSAGES,),
        )
        db.execute(
            "DELETE FROM channel_lines WHERE created_at<?",
            (time.time() - RETENTION_SECONDS,),
        )
        db.execute(
            "DELETE FROM channel_lines WHERE id IN (SELECT id FROM "
            "(SELECT id, row_number() OVER (PARTITION BY scope_id ORDER BY id DESC) AS n FROM channel_lines) WHERE n>?)",
            (CHANNEL_LINES_KEPT,),
        )

    @staticmethod
    def _generation(db: sqlite3.Connection, user_id: str, server_id: str) -> tuple[str, str]:
        values = []
        for key in (f"memory_user_epoch:{user_id}", f"memory_server_epoch:{server_id}"):
            row = db.execute("SELECT value FROM app_settings WHERE key=?", (key,)).fetchone()
            values.append("0" if row is None else row[0])
        return tuple(values)

    def memory_generation(self, user_id: str, server_id: str) -> tuple[str, str]:
        with self._lock, self._managed_connection() as db:
            return self._generation(db, user_id, server_id)

    @staticmethod
    def _bump_generation(db: sqlite3.Connection, key: str) -> None:
        db.execute("INSERT INTO app_settings(key,value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1", (key,))

    def reserve_api_request(
        self, event_id: str, user_id: str, guild_id: str,
        *, limits: ApiLimits = API_LIMITS, now: float | None = None,
        expected_generation: tuple[str, str] | None = None,
        server_id: str = "",
    ) -> None:
        """Charge before sending against the user's rolling request budget."""
        with self._lock, self._managed_connection() as db:
            db.execute("BEGIN IMMEDIATE")
            if expected_generation is not None and self._generation(db, user_id, server_id) != expected_generation:
                raise BudgetExceeded("This request was cancelled by memory erasure")
            row = db.execute("SELECT value FROM app_settings WHERE key='api_paused'").fetchone()
            if row is not None and row[0] == "1":
                raise BudgetExceeded("AI requests are paused by the owner")
            if db.execute("SELECT 1 FROM api_usage WHERE event_id=?", (event_id,)).fetchone():
                raise DuplicateRequest("Already charged this event")
            latest = db.execute(
                "SELECT max(created_at) AS last_time FROM api_usage WHERE user_id=?",
                (user_id,),
            ).fetchone()["last_time"]
            current = max(time.time() if now is None else now, latest or 0)
            used = db.execute(
                "SELECT count(*) FROM api_usage WHERE user_id=? AND created_at>?",
                (user_id, current - limits.window_seconds),
            ).fetchone()[0]
            if used >= limits.per_user:
                raise BudgetExceeded(
                    "AI request budget reached; try later or DM ckazros or email "
                    "ckazros@owaua.com to request more usage"
                )
            db.execute("INSERT INTO api_usage VALUES (?, ?, ?, ?)", (event_id, user_id, guild_id, current))

    def ensure_active_turn(
        self, user_id: str, server_id: str, expected_generation: tuple[str, str]
    ) -> None:
        """Reject a follow-up draft after erasure or an owner pause, without charging."""
        with self._lock, self._managed_connection() as db:
            if self._generation(db, user_id, server_id) != expected_generation:
                raise BudgetExceeded("This request was cancelled by memory erasure")
            row = db.execute(
                "SELECT value FROM app_settings WHERE key='api_paused'"
            ).fetchone()
            if row is not None and row[0] == "1":
                raise BudgetExceeded("AI requests are paused by the owner")

    def api_status(self, user_id: str | None = None) -> str:
        with self._lock, self._managed_connection() as db:
            if user_id is None:
                return f"API budget: {API_LIMITS.per_user} requests per user per 10 minutes"
            current = time.time()
            used = db.execute(
                "SELECT count(*) FROM api_usage WHERE user_id=? AND created_at>?",
                (user_id, current - API_LIMITS.window_seconds),
            ).fetchone()[0]
        return f"API budget: {used}/{API_LIMITS.per_user} requests for this user in 10 minutes"

    def reserve_full_image_generation(
        self, event_id: str, user_id: str, *, limit: int, now: float | None = None
    ) -> bool:
        """Reserve one of a full-mode user's daily image-generation slots."""
        if limit < 1:
            return False
        current = time.time() if now is None else now
        with self._lock, self._managed_connection() as db:
            db.execute("BEGIN IMMEDIATE")
            existing = db.execute(
                "SELECT 1 FROM full_image_generation_usage WHERE event_id=?", (event_id,)
            ).fetchone()
            if existing is not None:
                return True
            db.execute(
                "DELETE FROM full_image_generation_usage WHERE created_at<?",
                (current - 86400,),
            )
            used = db.execute(
                "SELECT count(*) FROM full_image_generation_usage WHERE user_id=?",
                (user_id,),
            ).fetchone()[0]
            if used >= limit:
                return False
            db.execute(
                "INSERT INTO full_image_generation_usage(event_id,user_id,created_at) VALUES (?, ?, ?)",
                (event_id, user_id, current),
            )
            return True

    def reserve_full_mode_prompt(
        self, event_id: str, user_id: str, *, limit: int, now: float | None = None
    ) -> bool:
        """Reserve one of a promoted full-mode user's lifetime prompts."""
        if limit < 1:
            return False
        current = time.time() if now is None else now
        key = f"full_mode_prompt:{user_id}"
        with self._lock, self._managed_connection() as db:
            db.execute("BEGIN IMMEDIATE")
            existing = db.execute(
                "SELECT value FROM app_settings WHERE key=?", (key,)
            ).fetchone()
            used = 0 if existing is None else int(existing[0])
            event_key = f"{key}:event:{event_id}"
            if db.execute(
                "SELECT 1 FROM app_settings WHERE key=?", (event_key,)
            ).fetchone() is not None:
                return True
            if used >= limit:
                return False
            db.execute(
                "INSERT INTO app_settings(key,value) VALUES (?, ?)",
                (key, str(used + 1)),
            ) if existing is None else db.execute(
                "UPDATE app_settings SET value=? WHERE key=?",
                (str(used + 1), key),
            )
            db.execute("INSERT INTO app_settings(key,value) VALUES (?, '1')", (event_key,))
            return True

    def prune(self) -> None:
        with self._lock, self._managed_connection() as db:
            self._prune(db)

    def get_setting(self, key: str, default: str = "") -> str:
        with self._lock:
            if key in self._settings:
                cached = self._settings[key]
                return default if cached is None else cached
            with self._managed_connection() as db:
                row = db.execute(
                    "SELECT value FROM app_settings WHERE key = ?", (key,)
                ).fetchone()
            if row is None:
                self._settings[key] = None
                return default
            value = str(row["value"])
            self._settings[key] = value
            return value

    def set_setting(self, key: str, value: str) -> None:
        with self._lock:
            with self._managed_connection() as db:
                db.execute(
                    """
                    INSERT INTO app_settings (key, value) VALUES (?, ?)
                    ON CONFLICT(key) DO UPDATE SET value = excluded.value
                    """,
                    (key, value),
                )
            self._settings[key] = value

    def append_message(
        self,
        *,
        event_id: str,
        scope_id: str,
        user_id: str,
        role: str,
        content: str,
        server_id: str = "",
        created_at: float | None = None,
        expected_generation: tuple[str, str] | None = None,
        unbounded: bool = False,
    ) -> bool:
        with self._lock, self._managed_connection() as db:
            db.execute("BEGIN IMMEDIATE")
            if expected_generation is not None and self._generation(db, user_id, server_id) != expected_generation:
                return False
            cursor = db.execute(
                """
                INSERT OR IGNORE INTO messages
                    (event_id, scope_id, user_id, server_id, role, content, unbounded, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    event_id,
                    scope_id,
                    user_id,
                    server_id,
                    role,
                    content if unbounded else content[:MAX_STORED_CHARS],
                    int(unbounded),
                    time.time() if created_at is None else created_at,
                ),
            )
            inserted = cursor.rowcount == 1
            if inserted and not unbounded:
                db.execute(
                    "DELETE FROM messages WHERE unbounded=0 AND scope_id=? AND user_id=? AND id NOT IN "
                    "(SELECT id FROM messages WHERE unbounded=0 AND scope_id=? AND user_id=? ORDER BY id DESC LIMIT ?)",
                    (scope_id, user_id, scope_id, user_id, CONVERSATION_MESSAGES),
                )
            return inserted

    def begin_user_turn(
        self,
        *,
        event_id: str,
        scope_id: str,
        user_id: str,
        server_id: str,
        content: str,
        created_at: float | None = None,
        unbounded: bool = False,
    ) -> tuple[tuple[str, str], bool]:
        """Record the user turn and return ``(generation, inserted)``."""
        with self._lock, self._managed_connection() as db:
            db.execute("BEGIN IMMEDIATE")
            generation = self._generation(db, user_id, server_id)
            cursor = db.execute(
                """
                INSERT OR IGNORE INTO messages
                    (event_id, scope_id, user_id, server_id, role, content, unbounded, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    event_id,
                    scope_id,
                    user_id,
                    server_id,
                    "user",
                    content if unbounded else content[:MAX_STORED_CHARS],
                    int(unbounded),
                    time.time() if created_at is None else created_at,
                ),
            )
            inserted = cursor.rowcount == 1
            if inserted and not unbounded:
                db.execute(
                    "DELETE FROM messages WHERE unbounded=0 AND scope_id=? AND user_id=? AND id NOT IN "
                    "(SELECT id FROM messages WHERE unbounded=0 AND scope_id=? AND user_id=? ORDER BY id DESC LIMIT ?)",
                    (scope_id, user_id, scope_id, user_id, CONVERSATION_MESSAGES),
                )
            return generation, inserted

    def erase_user_memory(self, user_id: str) -> int:
        with self._lock, self._managed_connection() as db:
            db.execute("BEGIN IMMEDIATE")
            self._bump_generation(db, f"memory_user_epoch:{user_id}")
            db.execute("DELETE FROM channel_lines WHERE user_id=?", (user_id,))
            return db.execute("DELETE FROM messages WHERE user_id=?", (user_id,)).rowcount

    def recent_messages(
        self, scope_id: str, user_id: str, *, limit: int | None
    ) -> list[dict[str, object]]:
        with self._lock, self._managed_connection() as db:
            query = """
                SELECT id, role, content, created_at
                FROM messages
                WHERE scope_id = ? AND user_id = ?
                  AND (unbounded = 1 OR created_at >= ?)
                ORDER BY id DESC
            """
            parameters: tuple[object, ...] = (
                scope_id,
                user_id,
                time.time() - RETENTION_SECONDS,
            )
            if limit is not None:
                query += " LIMIT ?"
                parameters += (limit,)
            rows = db.execute(query, parameters).fetchall()
        return [
            {
                "id": int(row["id"]),
                "role": str(row["role"]),
                "content": str(row["content"]),
                "created_at": float(row["created_at"]),
            }
            for row in reversed(rows)
        ]

    def erase_server_memory(self, server_id: str) -> int:
        with self._lock, self._managed_connection() as db:
            db.execute("BEGIN IMMEDIATE")
            self._bump_generation(db, f"memory_server_epoch:{server_id}")
            cursor = db.execute(
                "DELETE FROM messages WHERE server_id = ?", (server_id,)
            )
            db.execute("DELETE FROM channel_lines WHERE server_id = ?", (server_id,))
            return cursor.rowcount

    def reset_server_data(self, server_id: str) -> int:
        """Erase all persistent bot data that is scoped to one server."""
        with self._lock, self._managed_connection() as db:
            db.execute("BEGIN IMMEDIATE")
            self._bump_generation(db, f"memory_server_epoch:{server_id}")
            cursor = db.execute(
                "DELETE FROM messages WHERE server_id = ?", (server_id,)
            )
            db.execute("DELETE FROM channel_lines WHERE server_id = ?", (server_id,))
            language_key = f"response_language:guild:{server_id}"
            db.execute(
                "DELETE FROM app_settings WHERE key = ?",
                (language_key,),
            )
            self._settings.pop(language_key, None)
            return cursor.rowcount

    def record_channel_line(
        self,
        *,
        event_id: str,
        scope_id: str,
        server_id: str,
        user_id: str,
        author: str,
        content: str,
        created_at: float | None = None,
    ) -> bool:
        if not isinstance(content, str) or not isinstance(author, str):
            return False
        text = " ".join(content.split())[:CHANNEL_LINE_CHARS]
        name = " ".join(author.split())[:32]
        if not text or not scope_id:
            return False
        if not name:
            name = "someone"
        with self._lock, self._managed_connection() as db:
            db.execute("BEGIN IMMEDIATE")
            cursor = db.execute(
                """
                INSERT OR IGNORE INTO channel_lines
                    (event_id, scope_id, server_id, user_id, author, content, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    event_id,
                    scope_id,
                    server_id,
                    user_id,
                    name,
                    text,
                    time.time() if created_at is None else created_at,
                ),
            )
            inserted = cursor.rowcount == 1
            db.execute(
                "DELETE FROM channel_lines WHERE scope_id=? AND id NOT IN "
                "(SELECT id FROM channel_lines WHERE scope_id=? ORDER BY id DESC LIMIT ?)",
                (scope_id, scope_id, CHANNEL_LINES_KEPT),
            )
            return inserted

    def recent_channel_lines(
        self,
        scope_id: str,
        *,
        limit: int,
        exclude_event_id: str = "",
    ) -> list[dict[str, str]]:
        with self._lock, self._managed_connection() as db:
            query = """
                SELECT user_id, author, content
                FROM channel_lines
                WHERE scope_id = ? AND created_at >= ?
            """
            parameters: list[object] = [scope_id, time.time() - RETENTION_SECONDS]
            if exclude_event_id:
                query += " AND event_id != ?"
                parameters.append(exclude_event_id)
            query += " ORDER BY id DESC LIMIT ?"
            parameters.append(limit)
            rows = db.execute(query, parameters).fetchall()
        return [
            {
                "user_id": str(row["user_id"]),
                "author": str(row["author"]),
                "content": str(row["content"]),
            }
            for row in reversed(rows)
        ]

    def set_active_mode(self, scope_id: str, enabled: bool) -> None:
        with self._lock, self._managed_connection() as db:
            db.execute(
                """
                INSERT INTO active_channels
                    (scope_id, enabled, message_count, updated_at)
                VALUES (?, ?, 0, ?)
                ON CONFLICT(scope_id) DO UPDATE SET
                    enabled = excluded.enabled,
                    message_count = 0,
                    updated_at = excluded.updated_at
                """,
                (scope_id, int(enabled), time.time()),
            )

    def active_mode_status(self, scope_id: str) -> tuple[bool, int]:
        with self._lock, self._managed_connection() as db:
            row = db.execute(
                "SELECT enabled, message_count FROM active_channels WHERE scope_id = ?",
                (scope_id,),
            ).fetchone()
        if row is None:
            return False, 0
        return bool(row["enabled"]), int(row["message_count"])

    def record_active_message(self, scope_id: str, *, interval: int = 6) -> bool:
        if interval < 1:
            raise ValueError("interval must be at least 1")
        with self._lock, self._managed_connection() as db:
            cursor = db.execute(
                """
                UPDATE active_channels
                SET message_count = (message_count + 1) % ?, updated_at = ?
                WHERE scope_id = ? AND enabled = 1
                """,
                (interval, time.time(), scope_id),
            )
            if cursor.rowcount != 1:
                return False
            row = db.execute(
                "SELECT message_count FROM active_channels WHERE scope_id = ?",
                (scope_id,),
            ).fetchone()
            return row is not None and int(row["message_count"]) == 0
