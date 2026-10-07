"""Last-N conversation memory in SQLite."""

from __future__ import annotations

import os
import re
import sqlite3
import threading
import time
import unicodedata
import hashlib
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
        self.path = path.resolve()
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.path.parent, 0o700)
        self._lock = threading.RLock()
        self._db: sqlite3.Connection | None = None
        self._settings: dict[str, str | None] = {}
        self._backup_before_migration()
        self._initialize()
        self._migrate()

    def _backup_before_migration(self) -> None:
        if not self.path.exists() or not self.path.stat().st_size:
            return
        source = sqlite3.connect(f"{self.path.as_uri()}?mode=ro", uri=True)
        try:
            if source.execute("PRAGMA user_version").fetchone()[0] >= 1:
                return
            backup_path = self.path.with_name(self.path.name + ".pre-v1.backup")
            if not backup_path.exists():
                with sqlite3.connect(backup_path) as target:
                    source.backup(target)
                os.chmod(backup_path, 0o600)
        finally:
            source.close()

    def _migrate(self) -> None:
        with self._lock, self._managed_connection() as db:
            db.execute("BEGIN IMMEDIATE")
            if db.execute("PRAGMA user_version").fetchone()[0] >= 1:
                return
            additions = {
                "durable_notes": {
                    "normalized": "TEXT NOT NULL DEFAULT ''",
                    "source_event": "TEXT NOT NULL DEFAULT ''",
                    "updated_at": "REAL NOT NULL DEFAULT 0",
                },
                "pending_notes": {
                    "attempts": "INTEGER NOT NULL DEFAULT 0",
                    "next_attempt": "REAL NOT NULL DEFAULT 0",
                    "quarantined": "INTEGER NOT NULL DEFAULT 0",
                },
            }
            for table, columns in additions.items():
                existing = {
                    row["name"] for row in db.execute(f"PRAGMA table_info({table})")
                }
                for name, definition in columns.items():
                    if name not in existing:
                        db.execute(
                            f"ALTER TABLE {table} ADD COLUMN {name} {definition}"
                        )
            for row in db.execute("SELECT id,content FROM durable_notes").fetchall():
                db.execute(
                    "UPDATE durable_notes SET normalized=?,updated_at=created_at WHERE id=?",
                    (self.normalize_note(row["content"]), row["id"]),
                )
            db.execute(
                "CREATE TABLE IF NOT EXISTS conversation_summaries ("
                "scope_id TEXT NOT NULL,user_id TEXT NOT NULL,server_id TEXT NOT NULL,"
                "content TEXT NOT NULL DEFAULT '',message_count INTEGER NOT NULL DEFAULT 0,"
                "last_id INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0,"
                "next_attempt REAL NOT NULL DEFAULT 0,quarantined INTEGER NOT NULL DEFAULT 0,"
                "PRIMARY KEY(scope_id,user_id))"
            )
            db.execute(
                "CREATE TRIGGER IF NOT EXISTS summary_progress AFTER INSERT ON messages BEGIN "
                "INSERT INTO conversation_summaries(scope_id,user_id,server_id,message_count) "
                "VALUES(NEW.scope_id,NEW.user_id,NEW.server_id,1) "
                "ON CONFLICT(scope_id,user_id) DO UPDATE SET message_count=message_count+1; END"
            )
            db.execute(
                "CREATE INDEX IF NOT EXISTS notes_normalized_idx ON durable_notes(user_id,server_id,normalized)"
            )
            db.execute("PRAGMA user_version=1")

    @staticmethod
    def normalize_note(text: str) -> str:
        return " ".join(
            re.findall(r"\w+", unicodedata.normalize("NFKC", text).casefold())
        )

    @staticmethod
    def contains_secret(text: str) -> bool:
        return bool(
            re.search(
                r"(?i)(?:\b(?:password|api[ _-]?key|secret|access[ _-]?token)\s*(?:[:=]|is)\s*\S+|"
                r"\b(?:sk-[a-zA-Z0-9_-]{12,}|ghp_[a-zA-Z0-9]{20,})|"
                r"[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{20,})",
                text,
            )
        )

    def _clear_summaries(self, db, user_id: str, server_id: str) -> None:
        db.execute(
            "UPDATE conversation_summaries SET content='',message_count=0,attempts=0,"
            "next_attempt=0,quarantined=0,last_id=COALESCE((SELECT max(id) FROM messages "
            "WHERE messages.scope_id=conversation_summaries.scope_id AND messages.user_id=?),0) "
            "WHERE user_id=? AND server_id=?",
            (user_id, user_id, server_id),
        )

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
        connection = sqlite3.connect(self.path, timeout=10, check_same_thread=False)
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
                CREATE TABLE IF NOT EXISTS durable_notes (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id TEXT NOT NULL,
                    server_id TEXT NOT NULL,
                    content TEXT NOT NULL,
                    source_channel TEXT NOT NULL,
                    created_at REAL NOT NULL,
                    UNIQUE(user_id, server_id, content)
                );
                CREATE INDEX IF NOT EXISTS notes_user_scope_idx ON durable_notes(user_id, server_id);
                CREATE TABLE IF NOT EXISTS pending_notes (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    event_id TEXT NOT NULL UNIQUE,
                    user_id TEXT NOT NULL,
                    server_id TEXT NOT NULL,
                    channel_id TEXT NOT NULL,
                    content TEXT NOT NULL,
                    user_epoch TEXT NOT NULL,
                    server_epoch TEXT NOT NULL,
                    created_at REAL NOT NULL
                );
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
        db.execute(
            "DELETE FROM messages WHERE unbounded=0 AND created_at<?",
            (time.time() - RETENTION_SECONDS,),
        )
        db.execute(
            "DELETE FROM messages WHERE id IN (SELECT id FROM messages WHERE unbounded=0 ORDER BY id DESC LIMIT -1 OFFSET ?)",
            (MAX_STORED_MESSAGES,),
        )
        db.execute(
            "UPDATE messages SET content=substr(content,1,?) WHERE unbounded=0 AND length(content)>?",
            (MAX_STORED_CHARS, MAX_STORED_CHARS),
        )
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
    def _generation(
        db: sqlite3.Connection, user_id: str, server_id: str
    ) -> tuple[str, str]:
        values = []
        for key in (f"memory_user_epoch:{user_id}", f"memory_server_epoch:{server_id}"):
            row = db.execute(
                "SELECT value FROM app_settings WHERE key=?", (key,)
            ).fetchone()
            values.append("0" if row is None else row[0])
        return tuple(values)

    def memory_generation(self, user_id: str, server_id: str) -> tuple[str, str]:
        with self._lock, self._managed_connection() as db:
            return self._generation(db, user_id, server_id)

    @staticmethod
    def _bump_generation(db: sqlite3.Connection, key: str) -> None:
        db.execute(
            "INSERT INTO app_settings(key,value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1",
            (key,),
        )

    def reserve_api_request(
        self,
        event_id: str,
        user_id: str,
        guild_id: str,
        *,
        limits: ApiLimits = API_LIMITS,
        now: float | None = None,
        expected_generation: tuple[str, str] | None = None,
        server_id: str = "",
    ) -> None:
        """Atomically reserve each provider attempt across users and instances."""
        with self._lock, self._managed_connection() as db:
            db.execute("BEGIN IMMEDIATE")
            if (
                expected_generation is not None
                and self._generation(db, user_id, server_id) != expected_generation
            ):
                raise BudgetExceeded("This request was cancelled by memory erasure")
            row = db.execute(
                "SELECT value FROM app_settings WHERE key='api_paused'"
            ).fetchone()
            if row is not None and row[0] == "1":
                raise BudgetExceeded("AI requests are paused by the owner")
            if db.execute(
                "SELECT 1 FROM api_usage WHERE event_id=?", (event_id,)
            ).fetchone():
                raise DuplicateRequest("Already charged this event")
            current = time.time() if now is None else now
            last = float(
                db.execute("SELECT last_time FROM api_totals WHERE id=1").fetchone()[0]
            )
            current = max(current, last)
            db.execute(
                "DELETE FROM api_usage WHERE created_at<=?",
                (current - limits.window_seconds,),
            )
            used = db.execute(
                "SELECT count(*) FROM api_usage WHERE user_id=? AND created_at>?",
                (user_id, current - limits.window_seconds),
            ).fetchone()[0]
            if limits.per_user and used >= limits.per_user:
                raise BudgetExceeded(
                    "AI request limit reached; try again later or DM ckazros / ckazros@owaua.com"
                )
            db.execute(
                "INSERT INTO api_usage VALUES (?, ?, ?, ?)",
                (event_id, user_id, guild_id, current),
            )
            db.execute(
                "UPDATE api_totals SET requests=requests+1,last_time=? WHERE id=1",
                (current,),
            )

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
                "SELECT 1 FROM full_image_generation_usage WHERE event_id=?",
                (event_id,),
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
            if (
                db.execute(
                    "SELECT 1 FROM app_settings WHERE key=?", (event_key,)
                ).fetchone()
                is not None
            ):
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
            db.execute(
                "INSERT INTO app_settings(key,value) VALUES (?, '1')", (event_key,)
            )
            return True

    def prune(self) -> None:
        with self._lock, self._managed_connection() as db:
            self._prune(db)

    def get_setting(self, key: str, default: str = "") -> str:
        with self._lock:
            if key in self._settings:
                cached = self._settings[key]
                return default if cached is None else cached
            if len(self._settings) >= 4096:
                self._settings.clear()
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
            if len(self._settings) >= 4096:
                self._settings.clear()
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
            if (
                expected_generation is not None
                and self._generation(db, user_id, server_id) != expected_generation
            ):
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
            db.execute("DELETE FROM durable_notes WHERE user_id=?", (user_id,))
            db.execute("DELETE FROM pending_notes WHERE user_id=?", (user_id,))
            db.execute("DELETE FROM conversation_summaries WHERE user_id=?", (user_id,))
            return db.execute(
                "DELETE FROM messages WHERE user_id=?", (user_id,)
            ).rowcount

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
            db.execute("DELETE FROM durable_notes WHERE server_id=?", (server_id,))
            db.execute("DELETE FROM pending_notes WHERE server_id=?", (server_id,))
            db.execute(
                "DELETE FROM conversation_summaries WHERE server_id=?", (server_id,)
            )
            return cursor.rowcount

    def reset_guild_api_usage(self, guild_id: str) -> int:
        """Delete all api_usage rows for a guild, resetting its rolling quota."""
        with self._lock, self._managed_connection() as db:
            cursor = db.execute("DELETE FROM api_usage WHERE guild_id = ?", (guild_id,))
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
            db.execute("DELETE FROM durable_notes WHERE server_id=?", (server_id,))
            db.execute("DELETE FROM pending_notes WHERE server_id=?", (server_id,))
            db.execute(
                "DELETE FROM conversation_summaries WHERE server_id=?", (server_id,)
            )
            for row in db.execute(
                "SELECT key FROM app_settings WHERE key LIKE ?",
                (f"channel_context:{server_id}:%",),
            ).fetchall():
                self._settings.pop(row["key"], None)
                db.execute("DELETE FROM app_settings WHERE key=?", (row["key"],))
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

    def channel_context_enabled(self, server_id: str, channel_id: str) -> bool:
        return (
            self.get_setting(f"channel_context:{server_id}:{channel_id}", "on") == "on"
        )

    def clear_channel_lines(self, channel_id: str) -> int:
        with self._lock, self._managed_connection() as db:
            return db.execute(
                "DELETE FROM channel_lines WHERE scope_id=?", (channel_id,)
            ).rowcount

    def notes_paused(self, user_id: str, server_id: str) -> bool:
        with self._lock:
            row = (
                self._connect()
                .execute(
                    "SELECT value FROM app_settings WHERE key=?",
                    (f"notes_paused:{server_id}:{user_id}",),
                )
                .fetchone()
            )
            return bool(row and row[0] == "1")

    def pause_notes(self, user_id: str, server_id: str, paused: bool) -> None:
        with self._lock, self._managed_connection() as db:
            db.execute("BEGIN IMMEDIATE")
            key = f"notes_paused:{server_id}:{user_id}"
            db.execute(
                "INSERT OR REPLACE INTO app_settings VALUES (?, ?)",
                (key, "1" if paused else "0"),
            )
            self._settings[key] = "1" if paused else "0"
            self._bump_generation(db, f"memory_user_epoch:{user_id}")
            db.execute(
                "DELETE FROM pending_notes WHERE user_id=? AND server_id=?",
                (user_id, server_id),
            )
            self._clear_summaries(db, user_id, server_id)

    def list_notes(self, user_id: str, server_id: str) -> list[dict]:
        with self._lock, self._managed_connection() as db:
            return [
                dict(row)
                for row in db.execute(
                    "SELECT id, content AS text, source_channel, source_event, created_at, updated_at FROM durable_notes "
                    "WHERE user_id=? AND server_id=? ORDER BY id DESC LIMIT 200",
                    (user_id, server_id),
                ).fetchall()
            ]

    def recall_notes(self, user_id: str, server_id: str, query: str) -> list[dict]:
        if self.notes_paused(user_id, server_id):
            return []
        notes = self.list_notes(user_id, server_id)
        query_normal = self.normalize_note(query)
        stop = {
            "the",
            "you",
            "what",
            "that",
            "this",
            "about",
            "have",
            "user",
            "their",
            "and",
            "with",
            "are",
        }
        terms = {t for t in query_normal.split() if len(t) > 2} - stop
        if re.search(
            r"(?:remember|know).{0,20}about me|who am i|my (?:notes|memory|profile)",
            query,
            re.I,
        ):
            return notes[:20]

        def score(note):
            normal = self.normalize_note(note["text"])
            tokens = set(normal.split()) - stop
            overlap = sum(
                1
                / max(
                    1, sum(t in self.normalize_note(n["text"]).split() for n in notes)
                )
                for t in terms & tokens
            )
            phrases = sum(
                2
                for a, b in zip(query_normal.split(), query_normal.split()[1:])
                if a not in stop and f"{a} {b}" in normal
            )
            return overlap + phrases

        relevant = sorted((n for n in notes if score(n) > 0), key=score, reverse=True)[
            :5
        ]
        preferences = [
            n
            for n in notes
            if re.search(
                r"\b(?:prefer|prefers|like|likes|dislike|dislikes|language|allerg(?:y|ic))\b",
                n["text"],
                re.I,
            )
        ]
        return (relevant + [n for n in preferences[:2] if n not in relevant])[:6]

    def edit_note(
        self, user_id: str, server_id: str, note_id: int, text: str | None
    ) -> bool:
        if text is not None and (not text.strip() or self.contains_secret(text)):
            return False
        with self._lock, self._managed_connection() as db:
            db.execute("BEGIN IMMEDIATE")
            if not db.execute(
                "SELECT 1 FROM durable_notes WHERE id=? AND user_id=? AND server_id=?",
                (note_id, user_id, server_id),
            ).fetchone():
                return False
            self._bump_generation(db, f"memory_user_epoch:{user_id}")
            db.execute(
                "DELETE FROM pending_notes WHERE user_id=? AND server_id=?",
                (user_id, server_id),
            )
            self._clear_summaries(db, user_id, server_id)
            if text is None:
                result = db.execute(
                    "DELETE FROM durable_notes WHERE id=? AND user_id=? AND server_id=?",
                    (note_id, user_id, server_id),
                )
            else:
                result = db.execute(
                    "UPDATE OR IGNORE durable_notes SET content=?, normalized=?, updated_at=? WHERE id=? AND user_id=? AND server_id=?",
                    (
                        text[:500],
                        self.normalize_note(text[:500]),
                        time.time(),
                        note_id,
                        user_id,
                        server_id,
                    ),
                )
            return result.rowcount == 1

    def forget_notes(self, user_id: str, server_id: str) -> int:
        with self._lock, self._managed_connection() as db:
            db.execute("BEGIN IMMEDIATE")
            self._bump_generation(db, f"memory_user_epoch:{user_id}")
            db.execute(
                "DELETE FROM pending_notes WHERE user_id=? AND server_id=?",
                (user_id, server_id),
            )
            self._clear_summaries(db, user_id, server_id)
            return db.execute(
                "DELETE FROM durable_notes WHERE user_id=? AND server_id=?",
                (user_id, server_id),
            ).rowcount

    def queue_note_extraction(
        self,
        event_id: str,
        user_id: str,
        server_id: str,
        channel_id: str,
        content: str,
        generation: tuple[str, str],
    ) -> None:
        if (
            not content.strip()
            or self.contains_secret(content)
            or self.notes_paused(user_id, server_id)
        ):
            return
        with self._lock, self._managed_connection() as db:
            db.execute("BEGIN IMMEDIATE")
            if self._generation(db, user_id, server_id) != generation:
                return
            db.execute(
                "INSERT OR IGNORE INTO pending_notes(event_id,user_id,server_id,channel_id,content,user_epoch,server_epoch,created_at) VALUES (?,?,?,?,?,?,?,?)",
                (
                    event_id,
                    user_id,
                    server_id,
                    channel_id,
                    content[:2000],
                    *generation,
                    time.time(),
                ),
            )
            db.execute(
                "DELETE FROM pending_notes WHERE id NOT IN (SELECT id FROM pending_notes ORDER BY id DESC LIMIT 512)"
            )

    def pending_note_batches(self) -> list[tuple]:
        with self._lock, self._managed_connection() as db:
            db.execute(
                "DELETE FROM pending_notes WHERE created_at<?",
                (time.time() - RETENTION_SECONDS,),
            )
            scopes = db.execute(
                "SELECT user_id,server_id FROM pending_notes WHERE quarantined=0 AND next_attempt<=strftime('%s','now') GROUP BY user_id,server_id HAVING count(*)>=6 OR min(created_at)<? ORDER BY min(created_at) LIMIT 1",
                (time.time() - 300,),
            ).fetchall()
            batches = []
            for scope in scopes:
                user, server = scope["user_id"], scope["server_id"]
                generation = self._generation(db, user, server)
                rows = [
                    dict(row)
                    for row in db.execute(
                        "SELECT * FROM pending_notes WHERE user_id=? AND server_id=? AND quarantined=0 AND next_attempt<=? ORDER BY id LIMIT 6",
                        (user, server, time.time()),
                    ).fetchall()
                ]
                rows = [
                    row
                    for row in rows
                    if (row["user_epoch"], row["server_epoch"]) == generation
                ]
                db.execute(
                    "DELETE FROM pending_notes WHERE user_id=? AND server_id=? AND (user_epoch!=? OR server_epoch!=?)",
                    (user, server, *generation),
                )
                if rows and not self.notes_paused(user, server):
                    batches.append((user, server, generation, rows))
            return batches

    def discard_note_batch(self, rows: list[dict]) -> None:
        with self._lock, self._managed_connection() as db:
            db.executemany(
                "DELETE FROM pending_notes WHERE id=?", [(row["id"],) for row in rows]
            )

    def apply_extracted_notes(
        self,
        user: str,
        server: str,
        generation: tuple[str, str],
        rows: list[dict],
        records: list,
    ) -> None:
        with self._lock, self._managed_connection() as db:
            db.execute("BEGIN IMMEDIATE")
            paused = db.execute(
                "SELECT value FROM app_settings WHERE key=?",
                (f"notes_paused:{server}:{user}",),
            ).fetchone()
            if self._generation(db, user, server) != generation or (
                paused and paused[0] == "1"
            ):
                return
            for record in records[:6]:
                if not isinstance(record, dict) or not isinstance(
                    record.get("text"), str
                ):
                    continue
                text = record["text"].strip()[:500]
                source = record.get("source")
                if (
                    not text
                    or self.contains_secret(text)
                    or type(source) is not int
                    or not 1 <= source <= len(rows)
                ):
                    continue
                normal = self.normalize_note(text)
                replaces = record.get("replaces")
                source_event = str(rows[source - 1].get("event_id", ""))
                if type(replaces) is int:
                    db.execute(
                        "UPDATE OR IGNORE durable_notes SET content=?,normalized=?,updated_at=?,source_event=?,source_channel=? "
                        "WHERE id=? AND user_id=? AND server_id=?",
                        (
                            text,
                            normal,
                            time.time(),
                            source_event,
                            rows[source - 1]["channel_id"],
                            replaces,
                            user,
                            server,
                        ),
                    )
                    continue
                if db.execute(
                    "SELECT 1 FROM durable_notes WHERE user_id=? AND server_id=? AND normalized=?",
                    (user, server, normal),
                ).fetchone():
                    continue
                db.execute(
                    "INSERT OR IGNORE INTO durable_notes(user_id,server_id,content,normalized,source_event,source_channel,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
                    (
                        user,
                        server,
                        text,
                        normal,
                        source_event,
                        rows[source - 1]["channel_id"],
                        time.time(),
                        time.time(),
                    ),
                )
            db.execute(
                "DELETE FROM durable_notes WHERE user_id=? AND server_id=? AND id NOT IN (SELECT id FROM durable_notes WHERE user_id=? AND server_id=? ORDER BY id DESC LIMIT 200)",
                (user, server, user, server),
            )
            db.executemany(
                "DELETE FROM pending_notes WHERE id=?", [(row["id"],) for row in rows]
            )

    def fail_note_batch(self, rows: list[dict], *, transient: bool) -> None:
        with self._lock, self._managed_connection() as db:
            for row in rows:
                attempt = int(row.get("attempts", 0)) + 1
                db.execute(
                    "UPDATE pending_notes SET attempts=?,next_attempt=?,quarantined=? WHERE id=?",
                    (
                        attempt,
                        time.time() + min(300, 30 * 2**attempt),
                        int(not transient or attempt >= 3),
                        row["id"],
                    ),
                )

    def background_status(self, user: str, server: str) -> tuple[int, int]:
        with self._lock, self._managed_connection() as db:
            row = db.execute(
                "SELECT count(*),coalesce(sum(quarantined),0) FROM pending_notes WHERE user_id=? AND server_id=?",
                (user, server),
            ).fetchone()
            summaries = db.execute(
                "SELECT coalesce(sum(quarantined),0) FROM conversation_summaries WHERE user_id=? AND server_id=?",
                (user, server),
            ).fetchone()[0]
            return int(row[0]), int(row[1]) + int(summaries)

    def conversation_summary(self, scope: str, user: str, server: str) -> str:
        if self.notes_paused(user, server):
            return ""
        with self._lock, self._managed_connection() as db:
            row = db.execute(
                "SELECT content FROM conversation_summaries WHERE scope_id=? AND user_id=? AND server_id=?",
                (scope, user, server),
            ).fetchone()
            return row[0] if row else ""

    def pending_summary(self):
        with self._lock, self._managed_connection() as db:
            rows = db.execute(
                "SELECT * FROM conversation_summaries WHERE message_count>=20 AND quarantined=0 AND next_attempt<=? ORDER BY next_attempt LIMIT 4",
                (time.time(),),
            ).fetchall()
            for row in rows:
                if self.notes_paused(row["user_id"], row["server_id"]):
                    continue
                messages = [
                    dict(m)
                    for m in db.execute(
                        "SELECT id,role,content FROM messages WHERE scope_id=? AND user_id=? AND id>? ORDER BY id DESC LIMIT 20",
                        (row["scope_id"], row["user_id"], row["last_id"]),
                    ).fetchall()
                ]
                if messages:
                    job = dict(row)
                    job["generation"] = self._generation(
                        db, row["user_id"], row["server_id"]
                    )
                    return job, list(reversed(messages)), job["generation"]
        return None

    def apply_summary(self, job, messages, generation, text: str) -> bool:
        user, server = job["user_id"], job["server_id"]
        with self._lock, self._managed_connection() as db:
            db.execute("BEGIN IMMEDIATE")
            if self._generation(db, user, server) != generation or self.notes_paused(
                user, server
            ):
                return False
            return (
                db.execute(
                    "UPDATE conversation_summaries SET content=?,message_count=max(0,message_count-?),last_id=?,attempts=0,next_attempt=0 "
                    "WHERE scope_id=? AND user_id=? AND last_id=?",
                    (
                        text[:2000],
                        job["message_count"],
                        messages[-1]["id"],
                        job["scope_id"],
                        user,
                        job["last_id"],
                    ),
                ).rowcount
                == 1
            )

    def fail_summary(self, job, *, transient: bool) -> None:
        attempt = int(job["attempts"]) + 1
        with self._lock, self._managed_connection() as db:
            db.execute("BEGIN IMMEDIATE")
            if (
                self._generation(db, job["user_id"], job["server_id"])
                != job["generation"]
            ):
                return
            db.execute(
                "UPDATE conversation_summaries SET attempts=?,next_attempt=?,quarantined=? WHERE scope_id=? AND user_id=? AND last_id=?",
                (
                    attempt,
                    time.time() + min(300, 30 * 2**attempt),
                    int(not transient or attempt >= 3),
                    job["scope_id"],
                    job["user_id"],
                    job["last_id"],
                ),
            )

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
