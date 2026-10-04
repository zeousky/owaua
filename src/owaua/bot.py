"""Owaua — a small Discord hangout bot."""

from __future__ import annotations

import asyncio
import base64
import io
import logging
import os
import random
import re
import time
from collections import OrderedDict, defaultdict, deque
from pathlib import Path
from typing import Awaitable, Callable

import aiohttp
import discord
import httpx
from dotenv import load_dotenv
from PIL import Image

from ask import (
    FULL_MODE_PROVIDERS,
    GEMINI_ONLY,
    LOCAL_AI_ONLY,
    MAX_ATTACHMENTS,
    LUNA_MODEL,
    OPENAI_API_KEY,
    PERSONAS,
    RANDOM_PERSONA,
    RANDOM_PERSONA_CHOICES,
    RUDDISH_LEVELS,
    ask,
    host_model_error,
    full_mode_provider_error,
    looks_like_decode_request,
    looks_like_repeat_request,
    normalize_persona,
    persona_label,
    persona_provider,
    sanitize_user_text,
    truncate,
    valid_persona,
)
from cloudflare import describe_protection
from memory import CHANNEL_CONTEXT_LINES, MemoryStore
from security import (OWNER_IDS, BLOCKED_USERS, ALLOWED_GUILDS, ALLOW_DMS,
                      MAX_INFLIGHT, MAX_INPUT_CHARS, MAX_REPLY_CHARS, MAX_TRACKED_USERS)
from music import (
    abandon_music_if_needed,
    configure_music_audit_log,
    handle_music_command,
    log_music_command,
    stop_music,
    unrestricted_music_guild,
)
from sefbot_host import SefbotHost, SefbotUnavailable

ROOT = Path(__file__).resolve().parents[2]
load_dotenv(os.getenv("OWAUA_ENV_FILE") or ROOT / ".env")

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
log = logging.getLogger("owaua")
logging.getLogger("httpx").setLevel(logging.WARNING)

DISCORD_TOKEN = os.getenv("DISCORD_TOKEN", "").strip().replace("\\_", "_")

MEMORY_DB = ROOT / "data" / "memory.sqlite3"
RATE_LIMIT_REQUESTS = 8
RATE_LIMIT_WINDOW = 60.0
COMMAND_COOLDOWN = 25.0
COOLDOWN_EXEMPT_USER_IDS = frozenset({1172433512364769342})
HELP_OWNER_ID = 1172433512364769342
COMMANDS = frozenset(
    {
        "!help",
        "!persona",
        "!human",
        "!language",
        "!music",
        "!memory",
        "!reset",
        "!pricing",
        "!security",
        "!shutdown",
        "!switch",
    }
)
AI_CREDITS_WARNING = (
    "my owner has ran out of credits, If you'd like to keep using them, "
    "you can donate at https://ko-fi.com/ckazros — the owner would appreciate it"
)
AI_CREDITS_EXHAUSTED = False
DISCORD_MESSAGE_LIMIT = 1900
ASK_TIMEOUT = 80.0
HANDLER_TIMEOUT = 140.0
MAX_HANDLERS = 16
FULL_MODE_GUILD_ID = 1535083112709496903
FULL_MODE_CHANNEL_ID = 1535083114219700227
FULL_MODE_CHANNEL_IDS = frozenset(
    {
        FULL_MODE_CHANNEL_ID,
        1549566630726602772,
    }
)
FULL_MODE_BLOCKED_USER_IDS = frozenset(
    {
        470617205667790868,
        836988339491962881,
    }
)
FULL_MODE_ENABLE_USER_IDS = frozenset({1172433512364769342})
FULL_MODE_ALLOWED_USER_IDS = frozenset(
    {
        1172433512364769342,
        1121021729649737813,
        1124004905292664985,
        1511064708764139536,
        932956672815689758,
        1439254983219482625,
        1391094791210536970,
    }
)
FULL_MODE_USAGE = (
    "usage: !full mode on|off, or !full mode "
    + "|".join(FULL_MODE_PROVIDERS)
)
PROMOTED_FULL_MODE_PROMPT_LIMIT = 8

HELP_TEXT = """**Owaua commands**
`!help` — show this command list
`!owner's note` — a note from the bot's owner
`!persona rudeish low|medium|high` (or `nerdish|flirty|irritating|cute|normal|random`) — view or switch your persona
`!human on|off` — talk like a person, or use the usual hangout-bot voice
`!language <full name>|reset` — this server's reply language and profile (Manage Server)
`!music help` — play a song in your voice channel
`!memory erase` — erase server memory (Manage Server required)
`!memory erase mine` — erase your own conversation history
`!reset all` — fully reset this bot in this server (Manage Server required)
`!switch bot` — run sefbot in this server, or switch back (Manage Server)

Each command has a 25s cooldown."""

OWNER_HELP_TEXT = """**Owaua commands**
`!help` — show this command list
`!owner's note` — a note from the bot's owner
`!persona rudeish low|medium|high` (or `nerdish|flirty|irritating|cute|normal|random`) — view or switch your persona
`!human on|off` — talk like a person, or use the usual hangout-bot voice
`!language <full name>|reset` — this server's reply language and profile (Manage Server)
`!music help` — play a song in your voice channel
`!memory erase` — erase server memory (Manage Server required)
`!memory erase mine` — erase your own conversation history
`!reset all` — fully reset this bot in this server (Manage Server required)
`!switch bot` — run sefbot in this server, or switch back (Manage Server)
`!security status|pause|resume` — API usage and emergency pause (bot owner only)
`!shutdown` — fully stop the bot (bot owner only)
`!pricing` — show model pricing (bot owner only)

Each command has a 25s cooldown."""

MODEL_PRICING = {
    "gpt-6-luna": (0.10, 0.50, "0.01 cached input"),
    "openai/gpt-6-luna": (0.10, 0.50, "0.01 cached input"),
    "openai/gpt-5.6-luna": (0.20, 1.20, "0.02 cached input"),
    "gpt-5.6-luna": (0.20, 1.20, "0.02 cached input"),
    "anthropic/claude-haiku-4-5": (1.00, 5.00, "provider pricing"),
    "deepseek-v4.1-flash": (0.30, 1.20, "provider pricing"),
    "zai/glm-5.3-flash": (0.50, 2.00, "provider pricing"),
    "openai/gpt-oss-20b": (0.075, 0.30, "0.0375 cached input"),
}


def _pricing_line(label: str, model: str) -> str:
    rates = MODEL_PRICING.get(model)
    if rates is None:
        return f"`{label}` `{model}` — input/output: unknown (check provider)"
    input_rate, output_rate, cache = rates
    return (
        f"`{label}` `{model}` — input ${input_rate:g}, output ${output_rate:g}; "
        f"{cache}"
    )


def pricing_text() -> str:
    """Owner-only price card. Every cloud reply is GPT-6 Luna."""
    return "\n".join(
        [
            "**Owaua model pricing**",
            "USD per 1M tokens under 272k. A web search is $0.01. A code session is $0.03.",
            _pricing_line("every reply", LUNA_MODEL),
            "Cached input is $0.01 per 1M. Hangout chat sends no tools.",
        ]
    )

OWNER_NOTE_TEXT = (
    "Hello, I hope you like my bot! I'm trying to keep it as simple as possible "
    "and don't pack it with useless features/commands. I spent a lot of time "
    "developing and (trying) to promote this bot, and I really hope you like it. "
    "I would also like to know what communities this bot is in, so if you see "
    "this message please DM me on Discord (ckazros) or on email (ckazros@owaua.com)"
)


def is_owner_note_command(content: str) -> bool:
    """Match `!owner's note`, including curly apostrophes from phones."""
    normalized = " ".join(
        content.strip()
        .replace("\u2019", "'")
        .replace("\u2018", "'")
        .casefold()
        .split()
    )
    return normalized == "!owner's note"


def switch_bot_request(text: str) -> str | None:
    """How `!switch bot` should change this server, or None when it is not that command."""
    parts = text.casefold().split()
    if not parts or parts[0] != "!switch":
        return None
    if len(parts) < 2 or parts[1] != "bot":
        return "usage"
    if len(parts) == 2:
        return "toggle"
    if len(parts) != 3:
        return "usage"
    choice = parts[2]
    if choice in {"sef", "sefbot", "on"}:
        return "sef"
    if choice in {"owaua", "off"}:
        return "owaua"
    return "usage"


def matched_command(text: str) -> str | None:
    """Return the prefix command name, if this message is one."""
    if is_owner_note_command(text):
        return "!owner's note"
    promoted_command = promoted_full_mode_command(text)
    if promoted_command is not None:
        return promoted_command
    name = text.split(maxsplit=1)[0].lower() if text else ""
    if name in COMMANDS:
        return name
    return None


def is_topgg_full_mode_command(content: str) -> bool:
    """Match the Top.gg full-mode command, including its on/off argument."""
    return promoted_full_mode_command(content) == "!topgg full mode"


def promoted_full_mode_command(content: str) -> str | None:
    normalized = " ".join(content.casefold().split())
    for prefix in ("!topgg", "!discordify"):
        if normalized == f"{prefix} full mode" or normalized in {
            f"{prefix} full mode on",
            f"{prefix} full mode off",
        }:
            return f"{prefix} full mode"
    return None


def is_full_mode_command(content: str) -> bool:
    """Match `!full` and `!full ...` after command_text normalization."""
    normalized = " ".join(content.casefold().split())
    return normalized == "!full" or normalized.startswith("!full ")


def full_mode_location(message: object) -> bool:
    """True only in the one guild's explicitly designated channels."""
    if LOCAL_AI_ONLY:
        return True
    guild = getattr(message, "guild", None)
    channel = getattr(message, "channel", None)
    return (
        getattr(guild, "id", None) == FULL_MODE_GUILD_ID
        and getattr(channel, "id", None) in FULL_MODE_CHANNEL_IDS
    )


def should_warn_for_ai_credits(
    message: object, normalized: str, bot_user: object | None
) -> bool:
    """Identify Owaua chat and AI-mode attempts before they can reach a provider."""
    if is_full_mode_command(normalized) or is_topgg_full_mode_command(normalized):
        return True

    # These names are not Owaua commands, but users may still try the older
    # chat-style spellings. Keep music, help, memory and other local commands
    # working without sending a credits notice.
    if re.match(
        r"^(?:!(?:ask|chat|ai|search)|,(?:ask|chat|people_search|container))(?:\s|$)",
        normalized,
        re.IGNORECASE,
    ):
        return True
    if matched_command(normalized) is not None:
        return False

    guild = getattr(message, "guild", None)
    if guild is None:
        return bool(normalized.strip() or getattr(message, "attachments", ()))
    mentions = getattr(message, "mentions", ())
    return bot_user is not None and bot_user in mentions


def full_mode_blocked(user_id: object) -> bool:
    return user_id in FULL_MODE_BLOCKED_USER_IDS or user_id in BLOCKED_USERS


def full_mode_can_enable(user_id: object) -> bool:
    if LOCAL_AI_ONLY:
        return not full_mode_blocked(user_id)
    return user_id in FULL_MODE_ENABLE_USER_IDS or full_mode_allowed(user_id)


def full_mode_allowed(user_id: object) -> bool:
    if LOCAL_AI_ONLY:
        return not full_mode_blocked(user_id)
    return user_id in FULL_MODE_ALLOWED_USER_IDS and not full_mode_blocked(user_id)


def full_mode_setting_key(user_id: object) -> str:
    return f"full_mode:{user_id}"


def full_mode_provider_setting_key(user_id: object) -> str:
    return f"full_mode_provider:{user_id}"


def topgg_full_mode_setting_key(user_id: object) -> str:
    return f"topgg_full_mode:{user_id}"


def discordify_full_mode_setting_key(user_id: object) -> str:
    return f"discordify_full_mode:{user_id}"


PERSONA_USAGE = (
    "usage: !persona rudeish low|medium|high, !persona nerdish, "
    "!persona flirty, !persona irritating, !persona cute, !persona normal, "
    "or !persona random"
)
HUMAN_USAGE = "usage: !human on or !human off"


def parse_persona_argument(argument: str) -> tuple[str | None, str | None]:
    """Return ``(persona, error)`` for ``!persona`` arguments."""
    text = " ".join(argument.casefold().replace("-", " ").split())
    if not text:
        return None, None
    if text == RANDOM_PERSONA:
        return RANDOM_PERSONA, None
    if text.startswith("rudeish"):
        if text == "rudeish":
            # Bare rudeish means the default (medium) level.
            return normalize_persona(text), None
        level = text.split(" ", 1)[1] if " " in text else ""
        if level in RUDDISH_LEVELS:
            return f"rudeish-{level}", None
        return None, PERSONA_USAGE
    if text in PERSONAS:
        return text, None
    return None, PERSONA_USAGE


def parse_human_argument(argument: str) -> tuple[str | None, str | None]:
    """Return ``(on|off, error)`` for ``!human`` arguments."""
    text = " ".join(argument.casefold().split())
    if not text:
        return None, None
    if text in {"on", "off"}:
        return text, None
    return None, HUMAN_USAGE


def parse_language_name(value: str) -> tuple[str | None, str | None]:
    """Validate a human-readable language name for ``!language``."""
    language = " ".join(value.split())
    if not language:
        return None, "usage: !language <full language name> | !language reset"
    if len(language) > 64 or not any(character.isalpha() for character in language):
        return None, "use a full language name, such as `!language hungarian`"
    if not all(character.isalpha() or character in " -'" for character in language):
        return None, "use a full language name, such as `!language hungarian`"
    compact = language.casefold().replace(" ", "")
    if re.fullmatch(r"[a-z]{2,3}(?:-[a-z]{2,4})?", compact):
        return None, "please type the full language name, not a short code like `hu`"
    return language, None


IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
LANGUAGE_ASSET_ALIASES = {
    "france": "french",
    "germany": "german",
    "greece": "greek",
    "hungary": "hungarian",
    "italy": "italian",
    "poland": "polish",
    "romania": "romanian",
    "ukraine": "ukrainian",
}
MAX_PROFILE_IMAGE_BYTES = 8 * 1024 * 1024
AVATAR_SIZE = 1024
BANNER_SIZE = (680, 240)
PROFILE_UPDATE_TIMEOUT = 20.0
DISCORD_RETRY_INITIAL_DELAY = 5.0
DISCORD_RETRY_MAX_DELAY = 300.0
PING_RESPONSE = "yeah?"


def language_asset_key(value: str) -> str:
    key = "".join(character for character in value.casefold() if character.isalpha())
    return LANGUAGE_ASSET_ALIASES.get(key, key)


def language_image_path(
    language: str,
    directories: tuple[str, ...],
    *,
    root: Path | None = None,
) -> Path | None:
    root = ROOT if root is None else root
    key = language_asset_key(language)
    if not key or key == "english":
        return None
    for relative in directories:
        directory = root if relative == "." else root / relative
        try:
            if not directory.is_dir():
                continue
            entries = list(directory.iterdir())
        except OSError:
            log.exception("Could not list profile images in %s", directory)
            continue
        for path in entries:
            try:
                if not path.is_file() or path.suffix.casefold() not in IMAGE_SUFFIXES:
                    continue
            except OSError:
                continue
            if language_asset_key(path.stem) == key:
                return path
    return None


def language_avatar_path(language: str, *, root: Path | None = None) -> Path | None:
    """Return the themed profile picture for a language, if one is shipped."""
    return language_image_path(language, ("pfps", "avatars", "."), root=root)


def language_banner_path(language: str, *, root: Path | None = None) -> Path | None:
    """Return the themed banner for a language, if one is shipped."""
    return language_image_path(language, ("banners",), root=root)


def looks_like_image(data: bytes) -> bool:
    if data.startswith(b"\x89PNG\r\n\x1a\n") or data.startswith(b"\xff\xd8\xff"):
        return True
    if data.startswith(b"GIF87a") or data.startswith(b"GIF89a"):
        return True
    return len(data) >= 12 and data.startswith(b"RIFF") and data[8:12] == b"WEBP"


def read_image_bytes(path: Path) -> bytes | None:
    try:
        if path.stat().st_size > MAX_PROFILE_IMAGE_BYTES:
            return None
        data = path.read_bytes()
    except OSError:
        log.exception("Could not read profile image %s", path)
        return None
    if not data or not looks_like_image(data):
        log.warning("Skipping invalid profile image %s", path)
        return None
    return data


def _cover_resize(image: Image.Image, size: tuple[int, int]) -> Image.Image:
    target_width, target_height = size
    scale = max(target_width / max(image.width, 1), target_height / max(image.height, 1))
    resized = image.resize(
        (max(target_width, round(image.width * scale)),
         max(target_height, round(image.height * scale))),
        Image.Resampling.LANCZOS,
    )
    left = max(0, (resized.width - target_width) // 2)
    top = max(0, (resized.height - target_height) // 2)
    return resized.crop((left, top, left + target_width, top + target_height))


def _save_jpeg(image: Image.Image, *, quality: int) -> bytes:
    converted = image.convert("RGB")
    output = io.BytesIO()
    converted.save(output, format="JPEG", quality=quality, optimize=True)
    return output.getvalue()


def prepare_avatar_bytes(data: bytes) -> bytes | None:
    if data.startswith((b"GIF87a", b"GIF89a")) and len(data) <= MAX_PROFILE_IMAGE_BYTES:
        return data
    try:
        with Image.open(io.BytesIO(data), formats=["PNG", "JPEG", "GIF", "WEBP"]) as image:
            if image.width * image.height > 16000000:
                return None
            image.load()
            square = _cover_resize(image.convert("RGB"), (AVATAR_SIZE, AVATAR_SIZE))
            for quality in (90, 80, 65):
                encoded = _save_jpeg(square, quality=quality)
                if len(encoded) <= MAX_PROFILE_IMAGE_BYTES:
                    return encoded
    except Exception as exc:
        log.warning("Could not prepare a profile picture: %s", exc)
        return None
    return None


def prepare_banner_bytes(data: bytes) -> bytes | None:
    try:
        with Image.open(io.BytesIO(data), formats=["PNG", "JPEG", "GIF", "WEBP"]) as image:
            if image.width * image.height > 16000000:
                return None
            image.load()
            banner = _cover_resize(image.convert("RGB"), BANNER_SIZE)
            for quality in (90, 80, 65):
                encoded = _save_jpeg(banner, quality=quality)
                if len(encoded) <= MAX_PROFILE_IMAGE_BYTES:
                    return encoded
    except Exception as exc:
        log.warning("Could not prepare a banner: %s", exc)
        return None
    return None


def profile_asset_payload(field: str, path: Path | None) -> dict[str, bytes | None]:
    if path is None:
        return {field: None}
    raw = read_image_bytes(path)
    if raw is None:
        return {}
    prepared = (
        prepare_avatar_bytes(raw) if field == "avatar" else prepare_banner_bytes(raw)
    )
    if prepared is None:
        log.warning("Skipping unusable %s image %s", field, path)
        return {}
    return {field: prepared}


def language_scope_key(message: object) -> str:
    guild = getattr(message, "guild", None)
    if guild is not None:
        return f"guild:{guild.id}"
    return f"dm:{getattr(message.channel, 'id', '')}"


def persona_setting_key(message: object) -> str:
    """Return the persistent persona key for the user issuing a message."""
    return f"persona:user:{getattr(getattr(message, 'author', None), 'id', '')}"


def random_persona_setting_key(message: object) -> str:
    """Return the hidden ``!persona random`` pick for a user.

    It is stored apart from the regular persona setting so that
    ``!persona`` can never reveal which voice ``random`` chose.
    """
    return f"persona_random:user:{getattr(getattr(message, 'author', None), 'id', '')}"


def human_setting_key(message: object) -> str:
    """Return the persistent human-voice key for the user issuing a message."""
    return f"human:user:{getattr(getattr(message, 'author', None), 'id', '')}"


def split_reply(text: str, limit: int = DISCORD_MESSAGE_LIMIT) -> list[str]:
    remaining = text.strip()
    if not remaining:
        return []
    chunks: list[str] = []
    while remaining:
        if len(remaining) <= limit:
            chunks.append(remaining)
            break
        window = remaining[:limit]
        break_at = max(window.rfind("\n\n"), window.rfind("\n"), window.rfind(" "))
        if break_at < limit // 2:
            break_at = limit
        chunks.append(remaining[:break_at].rstrip())
        remaining = remaining[break_at:].lstrip()
    return chunks


def referenced_message_context(
    message: object, bot_user_id: int | None = None, *, unbounded: bool = False
) -> str:
    """Quote the Discord message this one is a reply to, if it is cached."""
    reference = getattr(message, "reference", None)
    resolved = getattr(reference, "resolved", None)
    raw = getattr(resolved, "content", None)
    if not isinstance(raw, str):
        return ""
    if bot_user_id is not None:
        raw = raw.replace(f"<@{bot_user_id}>", " ").replace(
            f"<@!{bot_user_id}>", " "
        )
    quoted = sanitize_user_text(raw).strip()
    if not quoted:
        return ""
    if not unbounded:
        quoted = truncate(quoted)
    author = getattr(resolved, "author", None)
    speaker = (
        "you"
        if bot_user_id is not None and getattr(author, "id", None) == bot_user_id
        else "someone"
    )
    return f"(replying to {speaker}: {quoted})"


def command_text(content: str, bot_user_id: int | None = None) -> str:
    """Normalize a message so prefix commands still match after a ping."""
    text = content.replace("！", "!").strip()
    if bot_user_id is not None:
        text = text.replace(f"<@{bot_user_id}>", " ").replace(
            f"<@!{bot_user_id}>", " "
        )
    return " ".join(text.split())


def age_restricted_channel(channel: object) -> bool:
    return bool(getattr(channel, "nsfw", False))


def image_url(attachment: object) -> str | None:
    content_type = (getattr(attachment, "content_type", None) or "").lower()
    if content_type.startswith("image/"):
        url = getattr(attachment, "url", None)
        if isinstance(url, str) and url:
            return url
    return None


class MessageEventGuard:
    """Keep Discord redeliveries from reaching the reply path twice."""

    def __init__(self, *, ttl: float = 900.0) -> None:
        self.ttl = ttl
        self.capacity = 4096
        self._seen: OrderedDict[int, float] = OrderedDict()

    def claim(self, message_id: int, *, now: float | None = None) -> bool:
        current = time.monotonic() if now is None else now
        while self._seen:
            event_id, timestamp = next(iter(self._seen.items()))
            if current - timestamp < self.ttl:
                break
            self._seen.popitem(last=False)
        if message_id in self._seen:
            return False
        if len(self._seen) >= self.capacity:
            return False
        self._seen[message_id] = current
        return True


class PersonaBot(discord.Client):
    def __init__(self) -> None:
        intents = discord.Intents.default()
        intents.message_content = True
        super().__init__(
            intents=intents, allowed_mentions=discord.AllowedMentions.none()
        )
        self.memory = MemoryStore(MEMORY_DB)
        self.provider_http = httpx.AsyncClient(
            timeout=httpx.Timeout(60.0, connect=4.0),
            trust_env=False, follow_redirects=False,
            limits=httpx.Limits(
                max_connections=16,
                max_keepalive_connections=16,
                keepalive_expiry=120.0,
            ),
        )
        self.message_events = MessageEventGuard()
        self.conversation_locks: defaultdict[tuple[str, str], asyncio.Lock] = (
            defaultdict(asyncio.Lock)
        )
        self.rate_windows: defaultdict[int, deque[float]] = defaultdict(deque)
        self.command_used: dict[tuple[int, str], float] = {}
        self.music_tracks: dict[int, dict[str, object]] = {}
        self.response_languages: dict[str, str] = {}
        self.selected_persona = "rudeish"
        self.inflight_users: set[int] = set()
        self.handler_count = 0
        self.full_mode_users: set[int] = set()
        self.shutdown_requested = False
        self.active_handlers: set[asyncio.Task[object]] = set()

    def response_language(self, message: object) -> str:
        scope_key = language_scope_key(message)
        cached = self.response_languages.get(scope_key)
        if cached:
            return cached
        language = self.memory.get_setting(
            f"response_language:{scope_key}", "English"
        )
        if len(self.response_languages) >= MAX_TRACKED_USERS:
            self.response_languages.clear()
        self.response_languages[scope_key] = language
        return language

    def set_response_language(self, message: object, language: str) -> None:
        scope_key = language_scope_key(message)
        if len(self.response_languages) >= MAX_TRACKED_USERS:
            self.response_languages.clear()
        self.response_languages[scope_key] = language
        self.memory.set_setting(f"response_language:{scope_key}", language)

    def selected_persona_for(self, message: object) -> str:
        """Return the stored persona choice, preserving the random sentinel."""
        selected = normalize_persona(
            self.memory.get_setting(persona_setting_key(message), "rudeish")
        )
        if selected == "explicit":
            selected = "flirty"
        if selected != RANDOM_PERSONA and not valid_persona(selected):
            selected = normalize_persona("rudeish")
        return selected

    def available_random_personas(self) -> tuple[str, ...]:
        """Return the ``!persona random`` pool whose provider is configured."""
        available: list[str] = []
        for name in RANDOM_PERSONA_CHOICES:
            provider = persona_provider(name)
            problem = (
                full_mode_provider_error(provider)
                if provider == "groq"
                else host_model_error(provider)
            )
            if problem is None:
                available.append(name)
        return tuple(available)

    def random_persona_for(self, message: object) -> str:
        """Resolve the hidden persona locked in by ``!persona random``.

        The pick is stored once and reused, so a random user keeps a stable
        voice that is never shown back to them.
        """
        key = random_persona_setting_key(message)
        choices = self.available_random_personas()
        chosen = self.memory.get_setting(key, "")
        if chosen not in choices:
            if not choices:
                return normalize_persona("rudeish")
            chosen = random.choice(choices)
            self.memory.set_setting(key, chosen)
        return chosen

    def persona_for(self, channel: object, message: object | None = None) -> str:
        selected = normalize_persona(self.selected_persona)
        if selected == "explicit":
            selected = "flirty"
        if message is not None:
            if full_mode_blocked(getattr(getattr(message, "author", None), "id", None)):
                return "blocked"
            selected = self.selected_persona_for(message)
            if selected == RANDOM_PERSONA:
                selected = self.random_persona_for(message)
        return selected

    def human_mode_for(self, message: object) -> bool:
        """True only if this user has explicitly turned human voice on."""
        return self.memory.get_setting(human_setting_key(message), "0") == "1"

    @staticmethod
    def can_manage_settings(message: object) -> bool:
        if getattr(message, "guild", None) is None:
            return True
        permissions = getattr(message.author, "guild_permissions", None)
        return bool(getattr(permissions, "manage_guild", False))

    def sefbot_enabled(self, guild_id: int) -> bool:
        return self.memory.get_setting(f"bot_engine:{guild_id}", "") == "sef"

    def _sefbot_host(self) -> SefbotHost:
        host = getattr(self, "sefbot_host", None)
        if host is None:
            self.sefbot_host = host = SefbotHost(ROOT, ROOT / "data")
        if getattr(host, "on_push", None) is None:
            host.on_push = self._sefbot_push
        return host

    def _message_ref(self, message: object) -> dict[str, str] | None:
        message_id = getattr(message, "id", None)
        channel = getattr(message, "channel", None)
        channel_id = getattr(channel, "id", None)
        if message_id is None or channel_id is None:
            return None
        return {"messageId": str(message_id), "channelId": str(channel_id)}

    async def _sefbot_push(self, action: dict[str, object]) -> None:
        try:
            channel_id = int(str(action.get("channelId") or ""))
            message_id = int(str(action.get("messageId") or ""))
        except ValueError:
            return
        channel = self.get_channel(channel_id)
        if channel is None:
            channel = await self.fetch_channel(channel_id)
        message = await channel.fetch_message(message_id)
        text = action.get("content")
        body = text[:2000] if isinstance(text, str) and text else None
        embeds = self._sefbot_embeds(action)
        view = self._sefbot_view(action)
        kwargs: dict[str, object] = {}
        if body or not embeds:
            kwargs["content"] = body or "\u200b"
        if embeds:
            kwargs["embeds"] = embeds
        if view is not None:
            kwargs["view"] = view
        await message.edit(**kwargs)

    def _can_switch_bot(self, message: discord.Message) -> bool:
        if message.author.id in OWNER_IDS:
            return True
        return self.can_manage_settings(message)

    async def _prepare_sefbot(self) -> None:
        """Start the engine in the background so the first switch is not a cold boot."""
        try:
            await self._sefbot_host().ensure()
            log.info("sefbot engine ready")
        except SefbotUnavailable as exc:
            log.warning("sefbot engine is not ready: %s", exc)
        except Exception:
            log.warning("sefbot engine is not ready", exc_info=True)

    async def _sync_sefbot_commands(self, guild: discord.Guild | None, commands: list[dict[str, object]]) -> None:
        user = self.user
        http = getattr(self, "http", None)
        upsert = getattr(http, "bulk_upsert_guild_commands", None)
        if user is None or guild is None or not callable(upsert):
            return
        await upsert(user.id, guild.id, commands)

    def _sefbot_files(self, action: dict[str, object]) -> list[discord.File]:
        files: list[discord.File] = []
        raw_files = action.get("files")
        if not isinstance(raw_files, list):
            return files
        for item in raw_files[:10]:
            if not isinstance(item, dict):
                continue
            name = str(item.get("name") or "file").replace("/", "_").replace("\\", "_")[:80]
            encoded = item.get("data")
            if not isinstance(encoded, str) or not encoded:
                continue
            try:
                raw = base64.b64decode(encoded, validate=False)
            except (ValueError, TypeError):
                continue
            if not raw or len(raw) > 8 * 1024 * 1024:
                continue
            files.append(discord.File(io.BytesIO(raw), filename=name or "file"))
        return files

    async def _perform_sefbot_action(
        self,
        message: discord.Message,
        action: dict[str, object],
        state: dict[str, object],
    ) -> None:
        name = action.get("name")
        if name == "typing":
            trigger = getattr(message.channel, "trigger_typing", None)
            if callable(trigger):
                try:
                    await trigger()
                except (discord.HTTPException, discord.Forbidden):
                    return
            return
        if name == "defer":
            return
        content = action.get("content")
        text = content[:2000] if isinstance(content, str) else ""
        files = self._sefbot_files(action)
        embeds = self._sefbot_embeds(action)
        view = self._sefbot_view(action)
        posted = state.get("posted")
        if name == "edit" and posted is not None:
            kwargs: dict[str, object] = {}
            if text or not embeds:
                kwargs["content"] = text or "\u200b"
            if files:
                kwargs["attachments"] = files
            if embeds:
                kwargs["embeds"] = embeds
            if view is not None:
                kwargs["view"] = view
            await posted.edit(**kwargs)  # type: ignore[union-attr]
            return {"messageId": str(posted.id), "channelId": str(posted.channel.id)}
        body = text if text or embeds else ("\u200b" if not files else "")
        kwargs = {}
        if files:
            kwargs["files"] = files
        if embeds:
            kwargs["embeds"] = embeds
        if view is not None:
            kwargs["view"] = view
        if name == "send":
            sent = await message.channel.send(body, **kwargs)
            return self._message_ref(sent)
        reply = getattr(message, "reply", None)
        if callable(reply):
            sent = await reply(body, mention_author=False, **kwargs)
        else:
            sent = await message.channel.send(body, **kwargs)
        if state.get("posted") is None:
            state["posted"] = sent
        return self._message_ref(sent)

    def _sefbot_message_payload(self, message: discord.Message) -> dict[str, object]:
        user = self.user
        attachments = []
        for attachment in list(message.attachments)[:4]:
            url = getattr(attachment, "url", None)
            if not isinstance(url, str) or not url:
                continue
            attachments.append(
                {
                    "id": str(getattr(attachment, "id", "")),
                    "url": url,
                    "name": getattr(attachment, "filename", None) or "file",
                    "contentType": getattr(attachment, "content_type", None) or "",
                }
            )
        guild = message.guild
        return {
            "id": str(message.id),
            "guildId": "" if guild is None else str(guild.id),
            "channelId": str(message.channel.id),
            "userId": str(message.author.id),
            "username": getattr(message.author, "name", None) or "user",
            "displayName": self._speaker_name(message.author),
            "content": message.content,
            "mentioned": user is not None and user in message.mentions,
            "botUserId": None if user is None else str(user.id),
            "attachments": attachments,
        }

    async def _delegate_sefbot_message(self, message: discord.Message) -> None:
        state: dict[str, object] = {}

        async def actor(action: dict[str, object]) -> None:
            await self._perform_sefbot_action(message, action, state)

        try:
            await self._sefbot_host().handle_message(self._sefbot_message_payload(message), actor)
        except (SefbotUnavailable, Exception):
            log.warning(
                "sefbot message failed in guild %s",
                getattr(message.guild, "id", ""),
                exc_info=True,
            )
            if state.get("posted") is None:
                await self._reply(message, "sefbot couldn't answer that just now.")

    async def _run_sefbot_message(self, message: discord.Message) -> None:
        if not self.message_events.claim(message.id):
            return
        count = getattr(self, "handler_count", 0)
        if count >= MAX_HANDLERS:
            return
        self.handler_count = count + 1
        current_task = asyncio.current_task()
        active_handlers = getattr(self, "active_handlers", None)
        if active_handlers is None:
            self.active_handlers = active_handlers = set()
        if current_task is not None:
            active_handlers.add(current_task)
        try:
            await asyncio.wait_for(self._delegate_sefbot_message(message), timeout=HANDLER_TIMEOUT)
        except asyncio.TimeoutError:
            log.warning("sefbot handler exceeded deadline")
        finally:
            if current_task is not None:
                active_handlers.discard(current_task)
            self.handler_count -= 1

    async def _switch_bot_command(self, message: discord.Message, text: str) -> str:
        request = switch_bot_request(text)
        if message.guild is None:
            return "!switch bot only works in a server"
        if request == "usage" or request is None:
            return "usage: !switch bot [sef|owaua]"
        if not self._can_switch_bot(message):
            return "you need the Manage Server permission to switch this server"
        enabled = self.sefbot_enabled(message.guild.id)
        target = request
        if target == "toggle":
            target = "owaua" if enabled else "sef"
        key = f"bot_engine:{message.guild.id}"
        if target == "owaua":
            if not enabled and request != "toggle":
                return "this server is already running owaua"
            self.memory.set_setting(key, "owaua")
            try:
                await self._sync_sefbot_commands(message.guild, [])
            except (discord.HTTPException, discord.Forbidden):
                log.warning("could not remove sefbot slash commands in guild %s", message.guild.id)
            return "this server is back on owaua. mention me and I'll talk like usual."
        if enabled:
            return "this server is already running sefbot. `!switch bot` brings owaua back."
        try:
            host = self._sefbot_host()
            await host.ensure()
            commands = await host.slash_commands()
            await self._sync_sefbot_commands(message.guild, commands)
        except SefbotUnavailable as exc:
            return f"{exc}. this server is still on owaua."
        except Exception:
            log.warning("could not register sefbot slash commands in guild %s", message.guild.id)
            self.memory.set_setting(key, "sef")
            return (
                "this server is now running sefbot. mention me, or use comma commands like `,help`. "
                "slash commands couldn't be registered. `!switch bot` brings owaua back."
            )
        self.memory.set_setting(key, "sef")
        return (
            "this server is now running sefbot. mention me, or use comma commands like `,help`. "
            "`!switch bot` brings owaua back. other servers still run owaua."
        )

    def _sefbot_embeds(self, action: dict[str, object]) -> list[discord.Embed]:
        embeds: list[discord.Embed] = []
        raw = action.get("embeds")
        if not isinstance(raw, list):
            return embeds
        for item in raw:
            if isinstance(item, dict):
                embeds.append(discord.Embed.from_dict(item))
        return embeds

    def _sefbot_view(self, action: dict[str, object]) -> discord.ui.View | None:
        rows = action.get("components")
        if not isinstance(rows, list) or not rows:
            return None
        view = discord.ui.View(timeout=None)
        for row in rows:
            if not isinstance(row, dict):
                continue
            for component in row.get("components") or []:
                if not isinstance(component, dict) or int(component.get("type") or 2) != 2:
                    continue
                view.add_item(
                    discord.ui.Button(
                        label=str(component.get("label") or "button")[:80],
                        custom_id=str(component.get("custom_id") or "container")[:100],
                        style=discord.ButtonStyle(int(component.get("style") or 2)),
                        disabled=bool(component.get("disabled")),
                    )
                )
        return view if view.children else None

    async def _show_container_modal(self, interaction: discord.Interaction, action: dict[str, object]) -> None:
        modal = discord.ui.Modal(
            title=str(action.get("title") or "Run in the container")[:45],
            custom_id=str(action.get("custom_id") or "container:modal")[:100],
        )
        for row in action.get("components") or []:
            if not isinstance(row, dict):
                continue
            for field in row.get("components") or []:
                if not isinstance(field, dict) or int(field.get("type") or 0) != 4:
                    continue
                modal.add_item(
                    discord.ui.TextInput(
                        label=str(field.get("label") or "Code")[:45],
                        custom_id=str(field.get("custom_id") or "container:code")[:100],
                        style=discord.TextStyle.paragraph if int(field.get("style") or 2) == 2 else discord.TextStyle.short,
                        required=bool(field.get("required", True)),
                        max_length=min(int(field.get("max_length") or 1500), 4000),
                    )
                )

        async def on_submit(submitted: discord.Interaction) -> None:
            await self._forward_sefbot_component(submitted)

        modal.on_submit = on_submit  # type: ignore[method-assign]
        await interaction.response.send_modal(modal)

    async def _perform_interaction_action(self, interaction: discord.Interaction, action: dict[str, object]) -> None:
        name = action.get("name")
        if name == "modal":
            await self._show_container_modal(interaction, action)
            return
        if name == "defer":
            if not interaction.response.is_done():
                await interaction.response.defer()
            return
        if name == "typing":
            return
        content = action.get("content")
        text = content[:2000] if isinstance(content, str) else ""
        files = self._sefbot_files(action)
        embeds = self._sefbot_embeds(action)
        view = self._sefbot_view(action)
        body = text if text or embeds else "\u200b"
        extra: dict[str, object] = {}
        if files:
            extra["files"] = files
        if embeds:
            extra["embeds"] = embeds
        if view is not None:
            extra["view"] = view
        if name == "send" or (
            name == "reply" and interaction.type is discord.InteractionType.modal_submit
        ):
            sent = await interaction.followup.send(content=body, **extra)
            return self._message_ref(sent)
        if interaction.response.is_done():
            edit_extra = dict(extra)
            if files:
                edit_extra.pop("files", None)
                edit_extra["attachments"] = files
            await interaction.edit_original_response(content=body, **edit_extra)
            return
        await interaction.response.send_message(content=body, **extra)

    async def _forward_sefbot_component(self, interaction: discord.Interaction) -> None:
        guild = interaction.guild
        if guild is None or not self.sefbot_enabled(guild.id):
            return
        if not self.message_events.claim(interaction.id):
            return
        data = interaction.data if isinstance(interaction.data, dict) else {}
        custom_id = str(data.get("custom_id") or "")
        if interaction.type is discord.InteractionType.component and custom_id == "container:code":
            await self._show_container_modal(
                interaction,
                {
                    "title": "Run in the container",
                    "custom_id": "container:modal",
                    "components": [
                        {
                            "type": 1,
                            "components": [
                                {
                                    "type": 4,
                                    "custom_id": "container:code",
                                    "label": "What Luna should do",
                                    "style": 2,
                                    "required": True,
                                    "max_length": 1500,
                                }
                            ],
                        }
                    ],
                },
            )
            return
        if not interaction.response.is_done():
            try:
                await interaction.response.defer()
            except (discord.HTTPException, discord.Forbidden):
                return
        kind = "modal" if interaction.type is discord.InteractionType.modal_submit else "component"
        user = interaction.user
        payload = {
            "id": str(interaction.id),
            "kind": kind,
            "customId": custom_id,
            "alreadyDeferred": True,
            "data": data,
            "guildId": str(guild.id),
            "channelId": str(interaction.channel_id or ""),
            "userId": str(user.id),
            "username": getattr(user, "name", None) or "user",
            "displayName": self._speaker_name(user),
        }

        async def actor(action: dict[str, object]) -> None:
            await self._perform_interaction_action(interaction, action)

        try:
            await asyncio.wait_for(
                self._sefbot_host().handle_interaction(payload, actor),
                timeout=HANDLER_TIMEOUT,
            )
        except (SefbotUnavailable, Exception):
            log.warning("sefbot container interaction failed in guild %s", guild.id, exc_info=True)

    async def on_interaction(self, interaction: discord.Interaction) -> None:
        data = interaction.data if isinstance(interaction.data, dict) else {}
        name = str(data.get("name") or "").casefold()
        custom_id = str(data.get("custom_id") or "")
        is_credit_ai_interaction = (
            interaction.type is discord.InteractionType.application_command
            and name in {"people_search", "ask"}
        ) or (
            interaction.type in {
                discord.InteractionType.component,
                discord.InteractionType.modal_submit,
            }
            and custom_id.startswith("container:")
        )
        if AI_CREDITS_EXHAUSTED and is_credit_ai_interaction:
            try:
                await interaction.response.send_message(
                    AI_CREDITS_WARNING, ephemeral=True
                )
            except (discord.HTTPException, discord.Forbidden):
                return
            return
        if interaction.type is discord.InteractionType.component:
            await self._forward_sefbot_component(interaction)
            return
        if interaction.type is discord.InteractionType.modal_submit:
            return
        if interaction.type is not discord.InteractionType.application_command:
            return
        guild = interaction.guild
        if guild is None or not self.sefbot_enabled(guild.id):
            if guild is not None and not interaction.response.is_done():
                try:
                    await interaction.response.send_message(
                        "this server is running owaua. `!switch bot` turns on sefbot here.",
                        ephemeral=True,
                    )
                except (discord.HTTPException, discord.Forbidden):
                    return
            return
        if not self.message_events.claim(interaction.id):
            return
        try:
            if not interaction.response.is_done():
                await interaction.response.defer()
        except (discord.HTTPException, discord.Forbidden):
            return
        data = interaction.data if isinstance(interaction.data, dict) else {}
        resolved = data.get("resolved") if isinstance(data.get("resolved"), dict) else {}
        attachments = resolved.get("attachments") if isinstance(resolved, dict) else {}
        user = interaction.user
        payload = {
            "id": str(interaction.id),
            "commandName": data.get("name") or "",
            "guildId": str(guild.id),
            "channelId": str(interaction.channel_id or ""),
            "userId": str(user.id),
            "username": getattr(user, "name", None) or "user",
            "displayName": self._speaker_name(user),
            "options": data.get("options") or [],
            "resolvedAttachments": attachments if isinstance(attachments, dict) else {},
            "alreadyDeferred": True,
        }

        async def actor(action: dict[str, object]) -> None:
            await self._perform_interaction_action(interaction, action)

        try:
            await asyncio.wait_for(
                self._sefbot_host().handle_interaction(payload, actor),
                timeout=HANDLER_TIMEOUT,
            )
        except asyncio.TimeoutError:
            log.warning("sefbot interaction exceeded deadline")
        except (SefbotUnavailable, Exception):
            log.warning("sefbot interaction failed in guild %s", guild.id, exc_info=True)
            try:
                if interaction.response.is_done():
                    await interaction.edit_original_response(content="sefbot couldn't answer that just now.")
            except (discord.HTTPException, discord.Forbidden):
                return

    def full_mode_enabled_for(self, user_id: object) -> bool:
        try:
            parsed = int(user_id)
        except (TypeError, ValueError):
            return False
        if parsed in self.full_mode_users:
            return True
        if self.memory.get_setting(full_mode_setting_key(parsed), "") != "1":
            return False
        self.full_mode_users.add(parsed)
        return True

    def full_mode_provider_for(self, user_id: object) -> str:
        if GEMINI_ONLY:
            return "gemini"
        default_provider = "ollama" if LOCAL_AI_ONLY else "gpt"
        value = self.memory.get_setting(full_mode_provider_setting_key(user_id), default_provider)
        return value if value in FULL_MODE_PROVIDERS else default_provider

    def topgg_full_mode_granted_for(self, user_id: object) -> bool:
        return self.memory.get_setting(topgg_full_mode_setting_key(user_id), "") == "1"

    def promoted_full_mode_granted_for(self, user_id: object) -> bool:
        return (
            self.topgg_full_mode_granted_for(user_id)
            or self.memory.get_setting(discordify_full_mode_setting_key(user_id), "") == "1"
        )

    def promoted_full_mode_limited_for(self, user_id: object) -> bool:
        return (
            self.promoted_full_mode_granted_for(user_id)
            and not full_mode_allowed(user_id)
        )

    def full_mode_allowed_for(self, user_id: object) -> bool:
        return full_mode_allowed(user_id) or self.promoted_full_mode_granted_for(user_id)

    def set_full_mode_for(self, user_id: int, enabled: bool) -> None:
        if enabled:
            self.full_mode_users.add(user_id)
            self.memory.set_setting(full_mode_setting_key(user_id), "1")
            return
        self.full_mode_users.discard(user_id)
        self.memory.set_setting(full_mode_setting_key(user_id), "0")

    def full_mode_active(self, message: object) -> bool:
        if not full_mode_location(message):
            return False
        author = getattr(message, "author", None)
        user_id = getattr(author, "id", None)
        return self.full_mode_allowed_for(user_id) and self.full_mode_enabled_for(user_id)

    def admit_request(self, user_id: int) -> tuple[bool, int]:
        now = time.monotonic()
        if user_id not in self.rate_windows and len(self.rate_windows) >= MAX_TRACKED_USERS:
            self.rate_windows = defaultdict(deque, {key: value for key, value in self.rate_windows.items() if value and now-value[-1] < RATE_LIMIT_WINDOW})
            if len(self.rate_windows) >= MAX_TRACKED_USERS:
                return False, 60
        window = self.rate_windows[user_id]
        while window and now - window[0] >= RATE_LIMIT_WINDOW:
            window.popleft()
        if len(window) >= RATE_LIMIT_REQUESTS:
            retry_after = max(1, int(RATE_LIMIT_WINDOW - (now - window[0]) + 0.999))
            return False, retry_after
        window.append(now)
        return True, 0

    def admit_command(
        self, user_id: int, command: str, *, now: float | None = None
    ) -> tuple[bool, int]:
        current = time.monotonic() if now is None else now
        key = (user_id, command)
        last = self.command_used.get(key)
        if last is not None:
            elapsed = current - last
            if elapsed < COMMAND_COOLDOWN:
                retry_after = max(1, int(COMMAND_COOLDOWN - elapsed + 0.999))
                return False, retry_after
        if len(self.command_used) >= MAX_TRACKED_USERS:
            self.command_used = {key: value for key, value in self.command_used.items() if current-value < COMMAND_COOLDOWN}
            if len(self.command_used) >= MAX_TRACKED_USERS:
                return False, 25
        self.command_used[key] = current
        return True, 0

    async def on_ready(self) -> None:
        log.info("Logged in as %s; persona=%s", self.user, self.selected_persona)

    async def on_disconnect(self) -> None:
        if not self.is_closed():
            log.warning("Disconnected from Discord; waiting for gateway recovery")

    async def on_resumed(self) -> None:
        log.info("Discord gateway session resumed")

    async def setup_hook(self) -> None:
        self.maintenance_task = asyncio.create_task(self._maintain_memory())
        self.sefbot_prepare = asyncio.create_task(self._prepare_sefbot())
        reset_ids_raw = os.getenv("BOT_RESET_GUILD_QUOTA_IDS", "").strip()
        if reset_ids_raw:
            for raw_id in reset_ids_raw.split(","):
                raw_id = raw_id.strip()
                if not raw_id:
                    continue
                try:
                    guild_id = str(int(raw_id))
                except ValueError:
                    log.warning("BOT_RESET_GUILD_QUOTA_IDS: skipping invalid id %r", raw_id)
                    continue
                deleted = await asyncio.to_thread(self.memory.reset_guild_api_usage, guild_id)
                log.info("Startup quota reset for guild %s: deleted %d api_usage row(s)", guild_id, deleted)

    async def _maintain_memory(self) -> None:
        while True:
            await asyncio.sleep(3600)
            try:
                await asyncio.to_thread(self.memory.prune)
            except Exception:
                log.warning("Memory maintenance failed")

    async def on_voice_state_update(
        self,
        member: discord.Member,
        before: discord.VoiceState,
        after: discord.VoiceState,
    ) -> None:
        await abandon_music_if_needed(self, member, before, after)

    def _speaker_name(self, author: object) -> str:
        for attr in ("display_name", "global_name", "name"):
            value = getattr(author, attr, None)
            if value:
                return " ".join(str(value).split())[:32]
        return str(getattr(author, "id", "someone"))[:32]

    async def _remember_channel_text(
        self,
        *,
        event_id: str,
        scope_id: str,
        server_id: str,
        user_id: str,
        author: str,
        content: str,
        created_at: float,
    ) -> None:
        try:
            await asyncio.to_thread(
                self.memory.record_channel_line,
                event_id=event_id,
                scope_id=scope_id,
                server_id=server_id,
                user_id=user_id,
                author=author,
                content=content,
                created_at=created_at,
            )
        except Exception:
            log.exception("Could not store a channel line")

    async def _remember_channel_line(self, message: discord.Message) -> None:
        if message.guild is None:
            return
        raw_content = message.content
        if not isinstance(raw_content, str):
            return
        raw = sanitize_user_text(raw_content).strip()
        if not raw:
            return
        created = getattr(message, "created_at", None)
        stamp = created.timestamp() if created is not None else time.time()
        await self._remember_channel_text(
            event_id=f"line:{message.id}",
            scope_id=str(message.channel.id),
            server_id=str(message.guild.id),
            user_id=str(message.author.id),
            author=self._speaker_name(message.author),
            content=raw,
            created_at=stamp,
        )

    async def on_message(self, message: discord.Message) -> None:
        if message.author.bot or getattr(message, "webhook_id", None):
            return
        normalized = command_text(message.content, None if self.user is None else self.user.id)
        if self.shutdown_requested:
            return
        if AI_CREDITS_EXHAUSTED and should_warn_for_ai_credits(
            message, normalized, self.user
        ):
            await self._reply(message, AI_CREDITS_WARNING)
            return
        if normalized.casefold() == "!shutdown":
            if message.author.id in OWNER_IDS and self.message_events.claim(message.id):
                await self._shutdown()
            return
        blocked_user = full_mode_blocked(message.author.id)
        music_command = matched_command(normalized) == "!music"
        unrestricted_music = music_command and unrestricted_music_guild(message.guild)
        music_argument = normalized.split(maxsplit=1)[1].strip() if len(normalized.split(maxsplit=1)) == 2 else ""

        def audit_filtered(reason: str) -> None:
            if music_command:
                log_music_command(
                    message, music_argument, outcome="rejected", reason=reason
                )

        personal_erasure = normalized.casefold() == "!memory erase mine"
        if message.guild is None and not ALLOW_DMS and message.author.id not in OWNER_IDS and not personal_erasure:
            audit_filtered("direct_messages_disabled")
            return
        if message.guild is not None and ALLOWED_GUILDS and message.guild.id not in ALLOWED_GUILDS and not unrestricted_music:
            audit_filtered("guild_not_allowlisted")
            return
        if (
            message.guild is not None
            and self.sefbot_enabled(message.guild.id)
            and switch_bot_request(normalized) is None
        ):
            await self._run_sefbot_message(message)
            return
        if message.guild is not None:
            await self._remember_channel_line(message)
        if not unrestricted_music and len(message.content) > MAX_INPUT_CHARS:
            audit_filtered("message_too_long")
            return
        if (message.guild is not None and matched_command(normalized) is None
                and not (full_mode_location(message) and is_full_mode_command(normalized))
                and not (self.user is not None and self.user in message.mentions)):
            return
        if not self.message_events.claim(message.id):
            audit_filtered("duplicate_message")
            return
        count = getattr(self, "handler_count", 0)
        if not unrestricted_music and count >= MAX_HANDLERS:
            audit_filtered("handler_capacity")
            return
        self.handler_count = count + 1
        current_task = asyncio.current_task()
        active_handlers = getattr(self, "active_handlers", None)
        if active_handlers is None:
            self.active_handlers = active_handlers = set()
        if current_task is not None:
            active_handlers.add(current_task)
        try:
            if unrestricted_music:
                await self._handle_message(message)
            else:
                await asyncio.wait_for(self._handle_message(message), timeout=HANDLER_TIMEOUT)
        except asyncio.TimeoutError:
            log.warning("Message handler exceeded deadline")
            audit_filtered("handler_timeout")
        finally:
            if current_task is not None:
                active_handlers.discard(current_task)
            self.handler_count -= 1

    async def _shutdown(self) -> None:
        """Stop processing and close every resource without sending a reply."""
        if self.shutdown_requested:
            return
        self.shutdown_requested = True
        current_task = asyncio.current_task()
        for task in tuple(getattr(self, "active_handlers", ())):
            if task is not current_task and not task.done():
                task.cancel()
        await self.close()

    async def _handle_message(self, message: discord.Message) -> None:
        if message.author.bot:
            return

        text = command_text(
            message.content, None if self.user is None else self.user.id
        )
        parts = text.split(maxsplit=1)
        name = parts[0].lower() if parts else ""
        argument = parts[1].strip() if len(parts) == 2 else ""
        command = matched_command(text)
        if (
            command is None
            and full_mode_location(message)
            and is_full_mode_command(text)
        ):
            command = "!full"
        blocked_user = full_mode_blocked(message.author.id)
        full_mode = self.full_mode_active(message)
        unrestricted_music = (
            command == "!music" and unrestricted_music_guild(message.guild)
        )
        if command is not None:
            if not unrestricted_music:
                admitted, retry_after = self.admit_command(message.author.id, command)
                if not admitted:
                    await self._reply(message, f"slow down try again in {retry_after}s")
                    if command == "!music":
                        parts_for_audit = text.split(maxsplit=1)
                        log_music_command(
                            message,
                            parts_for_audit[1].strip() if len(parts_for_audit) == 2 else "",
                            outcome="rejected",
                            reason="command_cooldown",
                            response=f"slow down try again in {retry_after}s",
                        )
                    return
        if name == "!security":
            if message.author.id not in OWNER_IDS:
                return
            if argument.casefold() in {"pause", "resume"}:
                self.memory.set_setting("api_paused", "1" if argument.casefold() == "pause" else "0")
            await self._reply(message, self.memory.api_status(str(message.author.id)) + "; paused=" + self.memory.get_setting("api_paused", "0"))
            return
        if name == "!help":
            help_text = OWNER_HELP_TEXT if message.author.id == HELP_OWNER_ID else HELP_TEXT
            await self._reply(message, help_text)
            return
        if name == "!pricing":
            if message.author.id == HELP_OWNER_ID:
                await self._reply(message, pricing_text())
            return
        if is_owner_note_command(text):
            await self._reply(message, OWNER_NOTE_TEXT)
            return
        if command == "!full":
            await self._reply(message, self._full_mode_command(message, argument))
            return
        if command in {"!topgg full mode", "!discordify full mode"}:
            await self._reply(message, self._promoted_full_mode_command(message, command))
            return
        if name == "!persona":
            await self._reply(message, self._persona_command(message, argument))
            return
        if name == "!human":
            await self._reply(message, self._human_command(message, argument))
            return
        if name == "!language":
            await self._reply(
                message, await self._language_command(message, argument)
            )
            return
        if name == "!music":
            await self._reply(
                message, await handle_music_command(self, message, argument)
            )
            return
        if name == "!memory":
            await self._reply(message, await self._memory_command(message, argument))
            return
        if name == "!reset":
            await self._reply(message, await self._reset_command(message, argument))
            return
        if name == "!switch":
            await self._reply(message, await self._switch_bot_command(message, text))
            return

        is_dm = message.guild is None
        mentioned = self.user is not None and self.user in message.mentions
        if not (is_dm or mentioned):
            return

        prompt = message.content
        if self.user is not None:
            prompt = (
                prompt.replace(f"<@{self.user.id}>", "")
                .replace(f"<@!{self.user.id}>", "")
                .strip()
            )
        prompt = sanitize_user_text(prompt).strip()
        attachment_limit = MAX_ATTACHMENTS
        image_urls = [
            url
            for attachment in message.attachments[:attachment_limit]
            if (url := image_url(attachment))
        ]
        relaxed_guardrails = full_mode
        decode_now = not relaxed_guardrails and looks_like_decode_request(prompt)
        repeat_now = not relaxed_guardrails and looks_like_repeat_request(prompt)
        persona = self.persona_for(message.channel, message)
        use_history = (
            not full_mode
            and not LOCAL_AI_ONLY
            and not full_mode_blocked(message.author.id)
            and persona_provider(persona) == "gemini"
        )
        if decode_now or repeat_now:
            image_urls = []
        elif prompt or image_urls:
            quoted = referenced_message_context(
                message,
                None if self.user is None else self.user.id,
                unbounded=False,
            )
            if quoted:
                prompt = f"{quoted}\n{prompt}".strip()
                use_history = True
        if not prompt and not image_urls:
            if mentioned:
                await self._reply(message, PING_RESPONSE)
            return

        admitted, retry_after = self.admit_request(message.author.id)
        if not admitted:
            await self._reply(message, f"slow down try again in {retry_after}s")
            return
        scope_id = str(message.channel.id)
        user_id = str(message.author.id)
        channel_lines: list[dict[str, str]] = []
        if message.guild is not None and not full_mode:
            channel_lines = await asyncio.to_thread(
                self.memory.recent_channel_lines,
                scope_id,
                limit=CHANNEL_CONTEXT_LINES,
                exclude_event_id=f"line:{message.id}",
            )
        inflight = getattr(self, "inflight_users", None)
        if inflight is None:
            self.inflight_users = inflight = set()
        occupies_slot = True
        if occupies_slot:
            if message.author.id in inflight or len(inflight) >= MAX_INFLIGHT:
                return
            inflight.add(message.author.id)
        if full_mode and self.promoted_full_mode_limited_for(message.author.id):
            reserved = await asyncio.to_thread(
                self.memory.reserve_full_mode_prompt,
                str(message.id),
                str(message.author.id),
                limit=PROMOTED_FULL_MODE_PROMPT_LIMIT,
            )
            if not reserved:
                await self._reply(message, "full mode prompt limit reached")
                inflight.discard(message.author.id)
                return
        try:
            async with message.channel.typing():
                request = ask(
                        self.provider_http,
                        self.memory,
                        event_id=str(message.id),
                        scope_id=scope_id,
                        user_id=user_id,
                        server_id=(
                            str(message.guild.id)
                            if message.guild is not None
                            else ""
                        ),
                        prompt=prompt,
                        image_urls=image_urls,
                        persona=persona,
                        language=self.response_language(message),
                        created_at=message.created_at.timestamp(),
                        full_mode=full_mode,
                        full_mode_provider=(
                            self.full_mode_provider_for(message.author.id)
                            if full_mode
                            else ("ollama" if LOCAL_AI_ONLY else "gpt")
                        ),
                        provider_override=(
                            None if GEMINI_ONLY else ("groq" if blocked_user else None)
                        ),
                        use_history=use_history,
                        relaxed_guardrails=relaxed_guardrails,
                        human=not full_mode and self.human_mode_for(message),
                        channel_lines=channel_lines,
                    )
                answer = await asyncio.wait_for(request, timeout=ASK_TIMEOUT)
            if not answer:
                return
            await self._reply(message, answer)
            if message.guild is not None and not full_mode:
                await self._remember_channel_text(
                    event_id=f"line:assistant:{message.id}",
                    scope_id=scope_id,
                    server_id=str(message.guild.id),
                    user_id=user_id,
                    author="owaua",
                    content=answer,
                    created_at=time.time(),
                )
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("AI reply failed in channel %s", message.channel.id)
            await self._reply(message, "I couldn't reach the AI provider just now.")
        finally:
            if occupies_slot:
                inflight.discard(message.author.id)

    def _full_mode_command(self, message: discord.Message, requested: str) -> str:
        user_id = message.author.id
        if (
            full_mode_blocked(user_id)
            or not self.full_mode_allowed_for(user_id)
            and not full_mode_can_enable(user_id)
        ):
            return "you can't use this"
        text = " ".join(requested.casefold().split())
        if text in {"", "mode"}:
            return (
                "full mode on"
                if self.full_mode_enabled_for(user_id)
                else "full mode off"
            )
        if text == "mode on":
            provider = "gemini" if GEMINI_ONLY else "gpt"
            problem = full_mode_provider_error(provider)
            if problem is not None:
                return problem
            self.set_full_mode_for(user_id, True)
            self.memory.set_setting(full_mode_provider_setting_key(user_id), provider)
            return "full mode on"
        if text == "mode off":
            self.set_full_mode_for(user_id, False)
            return "full mode off"
        if text.startswith("mode "):
            provider = text[5:].strip()
            if provider in FULL_MODE_PROVIDERS:
                problem = full_mode_provider_error(provider)
                if problem is not None:
                    return problem
                self.memory.set_setting(
                    full_mode_provider_setting_key(user_id), provider
                )
                self.set_full_mode_for(user_id, True)
                return f"full mode on ({provider})"
        return FULL_MODE_USAGE

    def _promoted_full_mode_command(self, message: discord.Message, command: str) -> str:
        """Enable or disable a persistent, prompt-limited integration grant."""
        user_id = message.author.id
        if full_mode_blocked(user_id):
            return "you can't use this"
        normalized = command_text(
            message.content, None if self.user is None else self.user.id
        ).casefold()
        suffix = normalized.removeprefix(command).strip()
        setting_key = (
            topgg_full_mode_setting_key(user_id)
            if command == "!topgg full mode"
            else discordify_full_mode_setting_key(user_id)
        )
        if suffix == "off":
            self.memory.set_setting(setting_key, "0")
            if not self.promoted_full_mode_granted_for(user_id):
                self.set_full_mode_for(user_id, False)
            return "full mode off"
        provider = "gemini" if GEMINI_ONLY else "gpt"
        problem = full_mode_provider_error(provider)
        if problem is not None:
            return problem
        self.memory.set_setting(setting_key, "1")
        self.memory.set_setting(full_mode_provider_setting_key(user_id), provider)
        self.set_full_mode_for(user_id, True)
        return "full mode on"

    def _persona_command(self, message: discord.Message, requested: str) -> str:
        if not requested.strip():
            if full_mode_blocked(getattr(message.author, "id", None)):
                return "persona: blocked"
            selected = self.selected_persona_for(message)
            return f"persona: {persona_label(selected)}"
        persona, error = parse_persona_argument(requested)
        if error is not None:
            return error
        assert persona is not None
        if persona == RANDOM_PERSONA:
            choices = self.available_random_personas()
            if not choices:
                return host_model_error("gemini") or "no personas are configured"
            self.memory.set_setting(persona_setting_key(message), RANDOM_PERSONA)
            self.memory.set_setting(
                random_persona_setting_key(message), random.choice(choices)
            )
            self.memory.erase_user_memory(str(message.author.id))
            # Never reveal which persona was chosen.
            return "persona: random"
        provider = persona_provider(persona)
        problem = (
            full_mode_provider_error(provider)
            if provider == "groq"
            else host_model_error(provider)
        )
        if problem is not None:
            return problem
        self.memory.set_setting(persona_setting_key(message), persona)
        self.memory.erase_user_memory(str(message.author.id))
        return f"persona: {persona_label(persona)}"

    def _human_command(self, message: discord.Message, requested: str) -> str:
        if not requested.strip():
            return "human: on" if self.human_mode_for(message) else "human: off"
        setting, error = parse_human_argument(requested)
        if error is not None:
            return error
        assert setting is not None
        self.memory.set_setting(human_setting_key(message), "1" if setting == "on" else "0")
        return f"human {setting}"

    async def _bot_member(self, guild: discord.Guild) -> object | None:
        member = getattr(guild, "me", None)
        if member is not None:
            return member
        user = self.user
        if user is None:
            return None
        getter = getattr(guild, "get_member", None)
        if callable(getter):
            member = getter(user.id)
            if member is not None:
                return member
        fetcher = getattr(guild, "fetch_member", None)
        if not callable(fetcher):
            return None
        try:
            return await fetcher(user.id)
        except Exception:
            log.exception(
                "Could not fetch the bot member; guild=%s", getattr(guild, "id", "")
            )
            return None

    async def _try_member_edit(self, member: object, **fields: object) -> bool:
        if not fields:
            return False
        edit = getattr(member, "edit", None)
        if not callable(edit):
            return False
        try:
            await edit(**fields)
            return True
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log.warning(
                "Could not update this server’s profile (%s); guild=%s: %s",
                ", ".join(fields),
                getattr(getattr(member, "guild", None), "id", ""),
                exc,
            )
            return False

    async def _apply_guild_language_profile(
        self, guild: discord.Guild, language: str
    ) -> None:
        member = await self._bot_member(guild)
        if member is None:
            log.warning(
                "Cannot update this server’s profile picture; guild=%s",
                getattr(guild, "id", ""),
            )
            return
        avatar_fields = profile_asset_payload("avatar", language_avatar_path(language))
        banner_fields = profile_asset_payload("banner", language_banner_path(language))
        avatar_ok = await self._try_member_edit(member, **avatar_fields)
        banner_ok = await self._try_member_edit(member, **banner_fields)
        log.info(
            "Updated guild profile; guild=%s language=%s avatar=%s banner=%s",
            getattr(guild, "id", ""),
            language,
            avatar_ok and avatar_fields.get("avatar") is not None,
            banner_ok and banner_fields.get("banner") is not None,
        )

    async def _clear_guild_language_profile(self, guild: discord.Guild) -> None:
        member = await self._bot_member(guild)
        if member is None:
            log.warning(
                "Cannot reset this server’s profile picture; guild=%s",
                getattr(guild, "id", ""),
            )
            return
        avatar_ok = await self._try_member_edit(member, avatar=None)
        banner_ok = await self._try_member_edit(member, banner=None)
        log.info(
            "Reset guild profile; guild=%s avatar=%s banner=%s",
            getattr(guild, "id", ""),
            avatar_ok,
            banner_ok,
        )

    async def _language_command(self, message: discord.Message, argument: str) -> str:
        if not argument:
            return f"language: {self.response_language(message)}"
        if not self.can_manage_settings(message):
            return "you need the Manage Server permission to change server settings"
        if argument.casefold() == "reset":
            return await self._reset_language(message)
        language, error = parse_language_name(argument)
        if error is not None:
            return error
        assert language is not None
        self.set_response_language(message, language)
        if message.guild is not None:
            try:
                await asyncio.wait_for(
                    self._apply_guild_language_profile(message.guild, language),
                    timeout=PROFILE_UPDATE_TIMEOUT,
                )
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception(
                    "Profile update failed; guild=%s language=%s",
                    message.guild.id,
                    language,
                )
        if message.guild is None:
            return f"language set to {language}; I’ll reply in it from now on"
        return (
            f"language set to {language}; I’ll reply in it in this server from now on"
        )

    async def _reset_language(self, message: discord.Message) -> str:
        if not self.can_manage_settings(message):
            return "you need the Manage Server permission to change server settings"
        self.set_response_language(message, "English")
        if message.guild is None:
            return "language reset to English; I’ll reply in it from now on"
        try:
            await asyncio.wait_for(
                self._clear_guild_language_profile(message.guild),
                timeout=PROFILE_UPDATE_TIMEOUT,
            )
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("Profile reset failed; guild=%s", message.guild.id)
        return (
            "language reset to English; this server’s profile picture and banner "
            "are restored"
        )

    async def _memory_command(self, message: discord.Message, argument: str) -> str:
        if argument.casefold() == "erase mine":
            await asyncio.to_thread(self.memory.erase_user_memory, str(message.author.id))
            return "your conversation memory has been erased; usage counters remain"
        if message.guild is None:
            return "!memory erase only works in a server"
        if argument.casefold() != "erase":
            return "usage: !memory erase"
        if not message.author.guild_permissions.manage_guild:
            return "you need the Manage Server permission to erase server memory"
        removed = await asyncio.to_thread(
            self.memory.erase_server_memory, str(message.guild.id)
        )
        log.info(
            "Erased server memory; server=%s records=%s", message.guild.id, removed
        )
        return "server memory fully erased for every user and channel"

    async def _reset_command(self, message: discord.Message, argument: str) -> str:
        """Reset persistent and live bot state belonging to this server."""
        if message.guild is None:
            return "!reset all only works in a server"
        if argument.casefold() != "all":
            return "usage: !reset all"
        if not self.can_manage_settings(message):
            return "you need the Manage Server permission to reset this server"

        server_id = str(message.guild.id)
        removed = await asyncio.to_thread(
            self.memory.reset_server_data, server_id
        )
        self.response_languages.pop(f"guild:{server_id}", None)
        self.memory.set_setting(f"bot_engine:{server_id}", "owaua")
        try:
            await self._sync_sefbot_commands(message.guild, [])
        except (discord.HTTPException, discord.Forbidden):
            log.warning("could not remove sefbot slash commands in guild %s", server_id)
        try:
            await asyncio.wait_for(
                self._clear_guild_language_profile(message.guild),
                timeout=PROFILE_UPDATE_TIMEOUT,
            )
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("Profile reset failed; guild=%s", server_id)

        await stop_music(self, message.guild)
        self.music_tracks.pop(message.guild.id, None)
        log.info("Reset bot state; server=%s records=%s", server_id, removed)
        return "everything for this bot has been reset in this server"

    async def _reply(
        self, message: discord.Message, content: str
    ) -> None:
        if self.shutdown_requested:
            return
        text = content[:MAX_REPLY_CHARS]
        chunks = split_reply(text)
        for index, chunk in enumerate(chunks):
            if self.shutdown_requested:
                return
            try:
                await message.channel.send(
                    chunk,
                    reference=message if index == 0 else None,
                    allowed_mentions=discord.AllowedMentions.none(),
                    suppress_embeds=True,
                )
            except (discord.HTTPException, discord.Forbidden):
                log.exception("Could not send a Discord reply")
                return
        for index, image in enumerate(getattr(content, "image_bytes", ())):
            if self.shutdown_requested:
                return
            try:
                await message.channel.send(
                    "",
                    reference=message if not chunks and index == 0 else None,
                    allowed_mentions=discord.AllowedMentions.none(),
                    file=discord.File(io.BytesIO(image), filename=f"owaua-{index + 1}.png"),
                )
            except (discord.HTTPException, discord.Forbidden):
                log.exception("Could not send a generated image")
                return

    async def close(self) -> None:
        current_task = asyncio.current_task()
        for task in tuple(getattr(self, "active_handlers", ())):
            if task is not current_task and not task.done():
                task.cancel()
        task = getattr(self, "maintenance_task", None)
        prepare = getattr(self, "sefbot_prepare", None)
        for background in (task, prepare):
            if background is not None and not background.done():
                background.cancel()
        if task is not None or prepare is not None:
            await asyncio.gather(
                *(item for item in (task, prepare) if item is not None),
                return_exceptions=True,
            )
        host = getattr(self, "sefbot_host", None)
        if host is not None:
            await host.stop()
        for voice in self.voice_clients:
            voice.stop()
            await voice.disconnect(force=True)
        await self.provider_http.aclose()
        closer = getattr(self.memory, "close", None)
        if callable(closer):
            closer()
        await super().close()


def discord_retry_delay(failures: int) -> float:
    """Return a capped exponential delay for recreating a failed client."""
    if failures < 1:
        return 0.0
    exponent = min(failures - 1, 6)
    return min(
        DISCORD_RETRY_INITIAL_DELAY * (2 ** exponent), DISCORD_RETRY_MAX_DELAY
    )


async def start_discord_with_retries(
    token: str,
    *,
    bot_factory: Callable[[], PersonaBot] = PersonaBot,
    sleep: Callable[[float], Awaitable[object]] = asyncio.sleep,
) -> None:
    """Run Discord's built-in reconnect loop and recreate it if it exits.

    discord.py handles ordinary websocket reconnects when ``reconnect=True``.
    This outer loop covers failures that escape that loop, such as a temporary
    gateway or network failure while starting.  Login failures are permanent
    configuration errors and intentionally fail fast instead of retrying.
    """
    failures = 0
    recoverable = (
        aiohttp.ClientError,
        asyncio.TimeoutError,
        discord.ConnectionClosed,
        discord.GatewayNotFound,
        discord.HTTPException,
        OSError,
    )
    while True:
        bot = bot_factory()
        retry_delay: float | None = None
        try:
            await bot.start(token, reconnect=True)
            return
        except asyncio.CancelledError:
            raise
        except discord.LoginFailure:
            raise
        except recoverable as exc:
            failures += 1
            retry_delay = discord_retry_delay(failures)
            log.warning(
                "Discord client stopped (%s); recreating it in %.0fs (attempt %s)",
                type(exc).__name__,
                retry_delay,
                failures,
            )
        finally:
            try:
                await bot.close()
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("Failed while closing the Discord client")
        if getattr(bot, "shutdown_requested", False):
            return
        if retry_delay is not None:
            await sleep(retry_delay)


async def main() -> None:
    audit_path = Path(os.getenv("MUSIC_AUDIT_LOG", "data/music-audit.jsonl"))
    if not audit_path.is_absolute():
        audit_path = ROOT / audit_path
    configure_music_audit_log(audit_path)
    log.info("Cloudflare protection: %s", describe_protection())
    if not DISCORD_TOKEN:
        raise RuntimeError(
            "DISCORD_TOKEN is missing; copy .env.example to .env and fill it in"
        )
    if not LOCAL_AI_ONLY and not OPENAI_API_KEY:
        raise RuntimeError(
            "OPENAI_API_KEY is missing; copy .env.example to .env and fill it in"
        )
    await start_discord_with_retries(DISCORD_TOKEN)


if __name__ == "__main__":
    asyncio.run(main())
