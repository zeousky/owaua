"""Run sefbot's own code for one owaua process.

The standalone sefbot keeps its Discord login. This module starts that same
source as a child process with no gateway connection, and exchanges one JSON
object per line. Owaua posts whatever the child asks it to post.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import platform
import re
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request
from pathlib import Path

log = logging.getLogger("owaua")

NODE_VERSION = "22.19.0"
NODE_DOWNLOAD_SECONDS = 120
NPM_INSTALL_SECONDS = 180


class SefbotUnavailable(RuntimeError):
    """The engine could not be started. The message is safe to show in Discord."""


def resolve_sefbot_root(project_root: Path) -> Path | None:
    """Find the sefbot tree: an override, the copy shipped beside owaua, then the local checkout."""
    override = os.getenv("SEFBOT_ROOT", "").strip()
    candidates = []
    if override:
        candidates.append(Path(override))
    candidates.append(project_root / "sefbot")
    candidates.append(Path.home() / "Downloads" / "opsef" / "ai-bot")
    for path in candidates:
        if (path / "src" / "host-stdio.js").is_file():
            return path
    return None


def _node_target() -> str | None:
    system = platform.system().lower()
    machine = platform.machine().lower()
    arch = {"x86_64": "x64", "amd64": "x64", "aarch64": "arm64", "arm64": "arm64"}.get(machine)
    if system == "linux" and arch:
        return f"linux-{arch}"
    if system == "darwin" and arch:
        return f"darwin-{arch}"
    return None


def _node_major(node: str) -> int | None:
    try:
        out = subprocess.check_output([node, "-v"], text=True, timeout=10).strip()
    except (subprocess.SubprocessError, OSError):
        return None
    number = out.lstrip("v").split(".", 1)[0]
    if not number.isdigit():
        return None
    return int(number)


def _system_node() -> str | None:
    found = shutil.which("node")
    if not found:
        return None
    major = _node_major(found)
    if major is None or major < 22:
        return None
    return found


def _runtime_node(data_dir: Path) -> str | None:
    target = _node_target()
    if target is None:
        return None
    binary = data_dir / "node-runtime" / f"node-v{NODE_VERSION}-{target}" / "bin" / "node"
    if binary.is_file() and _node_major(str(binary)):
        return str(binary)
    return None


def _download_node(data_dir: Path) -> str:
    target = _node_target()
    if target is None:
        raise SefbotUnavailable("this machine has no Node.js 22 or newer, and I can't download one for it")
    name = f"node-v{NODE_VERSION}-{target}"
    dest = data_dir / "node-runtime" / name
    binary = dest / "bin" / "node"
    if binary.is_file():
        return str(binary)
    url = f"https://nodejs.org/dist/v{NODE_VERSION}/{name}.tar.gz"
    archive = data_dir / "node-runtime" / f"{name}.tar.gz"
    archive.parent.mkdir(parents=True, exist_ok=True)
    try:
        urllib.request.urlretrieve(url, archive)
        with tarfile.open(archive, "r:gz") as packed:
            packed.extractall(archive.parent, filter="data")
    except (OSError, tarfile.TarError, urllib.error.URLError) as exc:
        raise SefbotUnavailable("I couldn't download Node.js, so sefbot didn't start") from exc
    finally:
        archive.unlink(missing_ok=True)
    if not binary.is_file():
        raise SefbotUnavailable("the Node.js download didn't include a usable node binary")
    return str(binary)


def _modules_ready(root: Path, node: str) -> bool:
    try:
        result = subprocess.run(
            [node, "--input-type=module", "-e", "await import('discord.js');"],
            cwd=root,
            timeout=30,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            check=False,
        )
    except (subprocess.SubprocessError, OSError) as exc:
        log.warning("sefbot module check failed: %s", type(exc).__name__)
        return False
    if result.returncode == 0:
        return True
    lines = (result.stderr or b"").decode(errors="replace").strip().splitlines()
    useful = [
        line.strip()
        for line in lines
        if line.strip() and not line.startswith("Node.js v") and not line.strip().startswith("at ")
    ]
    detail = " | ".join(useful[-3:])[:180] if useful else f"exit {result.returncode}"
    if not re.search(r"key|token|secret|bearer", detail, re.I):
        log.warning("sefbot module check failed: %s", detail)
    return False


def _node_env(node: str) -> dict[str, str]:
    """Put this Node's bin first so npm's `#!/usr/bin/env node` shebang can find it."""
    env = os.environ.copy()
    bin_dir = str(Path(node).resolve().parent)
    env["PATH"] = bin_dir + os.pathsep + env.get("PATH", "")
    return env


def _npm(root: Path, node: str, args: list[str]) -> bool:
    npm = Path(node).resolve().with_name("npm")
    if not npm.is_file():
        found = shutil.which("npm")
        if not found:
            raise SefbotUnavailable("Node.js is installed but npm is missing, so sefbot didn't start")
        npm = Path(found)
    try:
        with tempfile.TemporaryFile() as err:
            result = subprocess.run(
                [str(npm), *args],
                cwd=root,
                env=_node_env(node),
                timeout=NPM_INSTALL_SECONDS,
                stdout=subprocess.DEVNULL,
                stderr=err,
                check=False,
            )
            err.seek(0)
            tail = err.read()[-4000:].decode(errors="replace").strip().splitlines()
    except subprocess.TimeoutExpired:
        log.warning("sefbot npm %s timed out", args[0])
        return False
    except OSError as exc:
        log.warning("sefbot npm %s failed: %s", args[0], type(exc).__name__)
        return False
    if result.returncode != 0:
        useful = [
            line.strip()
            for line in tail
            if line.strip() and not line.startswith("Node.js v") and "key" not in line.lower()
        ]
        log.warning("sefbot npm %s failed: %s", args[0], (useful[-1][:180] if useful else "failed"))
        return False
    return True


def _install_modules(root: Path, node: str) -> None:
    args = ["ci", "--omit=dev"] if (root / "package-lock.json").is_file() else ["install", "--omit=dev"]
    if not _npm(root, node, args):
        raise SefbotUnavailable("sefbot's dependencies didn't install")


def _budget_value(root: Path) -> str:
    """Daily spend cap. Prefer the environment, then the standalone bot's own setting."""
    for key in ("DAILY_BUDGET_USD", "SEFBOT_DAILY_BUDGET_USD"):
        value = os.getenv(key, "").strip().strip("\"'")
        if value and all(character.isdigit() or character == "." for character in value):
            return value
    env_file = root / "config" / ".env"
    if not env_file.is_file():
        return ""
    try:
        lines = env_file.read_text(encoding="utf-8").splitlines()
    except OSError:
        return ""
    for line in lines:
        if not line.startswith("DAILY_BUDGET_USD="):
            continue
        value = line.split("=", 1)[1].strip().strip("\"'")
        if value and all(character.isdigit() or character == "." for character in value):
            return value
    return ""


def prepare_runtime(project_root: Path, data_dir: Path) -> tuple[Path, str]:
    """Return the sefbot directory and a node binary, installing either when missing."""
    root = resolve_sefbot_root(project_root)
    if root is None:
        raise SefbotUnavailable("sefbot's code isn't on this machine")
    node = _system_node() or _runtime_node(data_dir)
    if node is None:
        node = _download_node(data_dir)
    if not _modules_ready(root, node):
        _install_modules(root, node)
    if not _modules_ready(root, node):
        raise SefbotUnavailable("sefbot's dependencies didn't install")
    return root, node


class SefbotHost:
    """One long-lived sefbot process for every server that has switched."""

    def __init__(self, project_root: Path, data_dir: Path) -> None:
        self.project_root = project_root
        self.data_dir = data_dir
        self.memory_path = data_dir / "sefbot-memory.sqlite"
        self._start_lock = asyncio.Lock()
        self._write_lock = asyncio.Lock()
        self._proc: asyncio.subprocess.Process | None = None
        self._reader: asyncio.Task[None] | None = None
        self._stderr: asyncio.Task[None] | None = None
        self._ready: asyncio.Future[None] | None = None
        self._pending: dict[str, asyncio.Future[dict[str, object]]] = {}
        self._actors: dict[str, object] = {}
        self.on_push = None

    async def ensure(self) -> None:
        async with self._start_lock:
            proc = self._proc
            ready = self._ready
            if (
                proc is not None
                and proc.returncode is None
                and ready is not None
                and ready.done()
                and not ready.cancelled()
                and ready.exception() is None
            ):
                return
            await self._start()

    async def _start(self) -> None:
        await self._stop_locked()
        root, node = await asyncio.to_thread(prepare_runtime, self.project_root, self.data_dir)
        self.memory_path.parent.mkdir(parents=True, exist_ok=True)
        env = _node_env(node)
        env["ALLOWED_USER_IDS"] = "*"
        env["SEFBOT_SQLITE"] = "builtin"
        env["MEMORY_DB_PATH"] = str(self.memory_path)
        env.pop("DISCORD_TOKEN", None)
        budget = _budget_value(root)
        if budget:
            env["DAILY_BUDGET_USD"] = budget
        self._proc = await asyncio.create_subprocess_exec(
            node,
            "src/host-stdio.js",
            cwd=root,
            env=env,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        loop = asyncio.get_running_loop()
        self._ready = loop.create_future()
        self._reader = asyncio.create_task(self._read_stdout())
        self._stderr = asyncio.create_task(self._read_stderr())
        try:
            await asyncio.wait_for(self._ready, NODE_DOWNLOAD_SECONDS)
        except asyncio.TimeoutError as exc:
            await self._stop_locked()
            raise SefbotUnavailable("sefbot didn't finish starting") from exc

    async def slash_commands(self) -> list[dict[str, object]]:
        await self.ensure()
        result = await self._request({"type": "commands"})
        commands = result.get("commands")
        if not isinstance(commands, list):
            return []
        return [item for item in commands if isinstance(item, dict)]

    async def handle_message(self, payload: dict[str, object], actor) -> None:
        await self._exchange({"type": "message", **payload}, actor)

    async def handle_interaction(self, payload: dict[str, object], actor) -> None:
        await self._exchange({"type": "interaction", **payload}, actor)

    async def _exchange(self, payload: dict[str, object], actor) -> None:
        await self.ensure()
        request_id = str(payload.get("id") or id(payload))
        payload = {**payload, "id": request_id}
        loop = asyncio.get_running_loop()
        done: asyncio.Future[dict[str, object]] = loop.create_future()
        self._pending[request_id] = done

        async def perform(action: dict[str, object]) -> None:
            token = str(action.get("token") or "")
            try:
                result = await actor(action)
            except Exception as exc:
                await self._send({"type": "ack", "token": token, "ok": False, "error": type(exc).__name__})
                return
            ack: dict[str, object] = {"type": "ack", "token": token, "ok": True}
            if isinstance(result, dict):
                if result.get("messageId"):
                    ack["messageId"] = str(result["messageId"])
                if result.get("channelId"):
                    ack["channelId"] = str(result["channelId"])
            await self._send(ack)

        self._actors[request_id] = perform
        try:
            await self._send(payload)
            result = await done
        finally:
            self._pending.pop(request_id, None)
            self._actors.pop(request_id, None)
        error = result.get("error")
        if error:
            raise SefbotUnavailable("sefbot couldn't finish that")

    async def stop(self) -> None:
        async with self._start_lock:
            await self._stop_locked()

    async def _stop_locked(self) -> None:
        proc = self._proc
        self._proc = None
        reader = self._reader
        stderr = self._stderr
        self._reader = None
        self._stderr = None
        if proc is not None and proc.returncode is None:
            proc.kill()
            try:
                await asyncio.wait_for(proc.wait(), 5)
            except asyncio.TimeoutError:
                pass
        for task in (reader, stderr):
            if task is not None and not task.done():
                task.cancel()
        for future in self._pending.values():
            if not future.done():
                future.set_exception(SefbotUnavailable("sefbot stopped"))
        self._pending.clear()
        self._actors.clear()
        ready = self._ready
        if ready is not None and not ready.done():
            ready.set_exception(SefbotUnavailable("sefbot stopped"))

    async def _send(self, payload: dict[str, object]) -> None:
        proc = self._proc
        if proc is None or proc.stdin is None or proc.returncode is not None:
            raise SefbotUnavailable("sefbot isn't running")
        encoded = json.dumps(payload, separators=(",", ":")).encode() + b"\n"
        async with self._write_lock:
            proc.stdin.write(encoded)
            await proc.stdin.drain()

    async def _request(self, payload: dict[str, object]) -> dict[str, object]:
        request_id = f"req-{id(payload)}-{len(self._pending)}"
        payload = {**payload, "id": request_id}
        loop = asyncio.get_running_loop()
        future: asyncio.Future[dict[str, object]] = loop.create_future()
        self._pending[request_id] = future
        try:
            await self._send(payload)
            return await asyncio.wait_for(future, 30)
        finally:
            self._pending.pop(request_id, None)

    async def _read_stdout(self) -> None:
        proc = self._proc
        if proc is None or proc.stdout is None:
            return
        while True:
            raw = await proc.stdout.readline()
            if not raw:
                # A replaced process closes the old pipe. Only the live process
                # should fail the requests that are still waiting.
                if self._proc is proc:
                    self._fail_pending("sefbot engine stopped")
                return
            try:
                message = json.loads(raw.decode())
            except json.JSONDecodeError:
                continue
            if not isinstance(message, dict):
                continue
            kind = message.get("type")
            if kind == "push":
                handler = self.on_push
                if handler is not None:
                    try:
                        await handler(message)
                    except Exception:
                        log.warning("sefbot dashboard update failed", exc_info=True)
                continue
            if kind == "ready":
                ready = self._ready
                if ready is not None and not ready.done():
                    ready.set_result(None)
                continue
            request_id = message.get("id")
            if not isinstance(request_id, str):
                continue
            if kind == "action":
                actor = self._actors.get(request_id)
                if actor is not None:
                    try:
                        await actor(message)
                    except Exception:
                        token = str(message.get("token") or "")
                        await self._send(
                            {"type": "ack", "token": token, "ok": False, "error": "action failed"}
                        )
                continue
            future = self._pending.get(request_id)
            if future is not None and not future.done() and kind in {"done", "commands"}:
                future.set_result(message)

    async def _read_stderr(self) -> None:
        proc = self._proc
        if proc is None or proc.stderr is None:
            return
        while True:
            raw = await proc.stderr.readline()
            if not raw:
                return
            text = raw.decode(errors="replace").strip()
            if text:
                log.info("sefbot: %s", text[:400])

    def _fail_pending(self, reason: str) -> None:
        ready = self._ready
        if ready is not None and not ready.done():
            ready.set_exception(SefbotUnavailable(reason))
        for future in self._pending.values():
            if not future.done():
                future.set_exception(SefbotUnavailable(reason))
        self._pending.clear()
