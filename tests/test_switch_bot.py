from __future__ import annotations

import asyncio
import shutil
import tempfile
import unittest
from collections import defaultdict
from pathlib import Path
from unittest.mock import AsyncMock, patch

from bot import HELP_TEXT, MessageEventGuard, PersonaBot, switch_bot_request
from memory import MemoryStore
from sefbot_host import SefbotHost, resolve_sefbot_root
from test_channel_commands import FakeChannel, make_message


class SwitchBotTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.store = MemoryStore(Path(self.temporary_directory.name) / "memory.sqlite3")
        self.bot = object.__new__(PersonaBot)
        self.bot.memory = self.store
        self.bot.message_events = MessageEventGuard()
        self.bot._connection = type("Connection", (), {})()
        self.bot._connection.user = type("User", (), {"id": 99})()
        self.bot.provider_http = type("HTTP", (), {})()
        self.bot.selected_persona = "rudeish"
        self.bot.full_mode_users = set()
        self.bot.rate_windows = defaultdict(list)
        self.bot.command_used = {}
        self.bot.conversation_locks = defaultdict(asyncio.Lock)
        self.bot.music_tracks = {}
        self.bot.response_languages = {}
        self.bot.shutdown_requested = False
        self.bot.active_handlers = set()
        self.bot.handler_count = 0
        self.host = FakeSefbot()
        self.bot.sefbot_host = self.host
        self.bot.http = type("HTTP", (), {})()
        self.bot.http.bulk_upsert_guild_commands = AsyncMock()

    def tearDown(self) -> None:
        self.store.close()
        self.temporary_directory.cleanup()

    def test_switch_bot_request_parses_the_server_choice(self) -> None:
        self.assertEqual(switch_bot_request("!switch bot"), "toggle")
        self.assertEqual(switch_bot_request("!SWITCH BOT sef"), "sef")
        self.assertEqual(switch_bot_request("!switch bot sefbot"), "sef")
        self.assertEqual(switch_bot_request("!switch bot on"), "sef")
        self.assertEqual(switch_bot_request("!switch bot owaua"), "owaua")
        self.assertEqual(switch_bot_request("!switch bot off"), "owaua")
        self.assertEqual(switch_bot_request("!switch"), "usage")
        self.assertEqual(switch_bot_request("!switch bot later"), "usage")
        self.assertIsNone(switch_bot_request("!help"))

    async def test_switch_is_per_server_and_uses_sefbot_for_that_server_only(self) -> None:
        switched = FakeChannel()
        other = FakeChannel()

        await self.bot.on_message(make_message("!switch bot", 1, switched, guild_id=11))

        self.assertIn("now running sefbot", switched.sent[-1])
        self.assertEqual(self.store.get_setting("bot_engine:11"), "sef")
        self.assertEqual(self.store.get_setting("bot_engine:12"), "")
        self.bot.http.bulk_upsert_guild_commands.assert_awaited()
        self.assertGreaterEqual(self.host.ensured, 1)

        await self.bot.on_message(make_message(",help", 2, switched, guild_id=11))
        await self.bot.on_message(make_message(",help", 3, other, guild_id=12))
        await self.bot.on_message(make_message("!help", 4, switched, guild_id=11))

        self.assertEqual(switched.sent[1:], ["from sefbot", "from sefbot"])
        self.assertEqual(other.sent, [])
        self.assertEqual([item["guildId"] for item in self.host.messages], ["11", "11"])
        self.assertNotIn(HELP_TEXT, switched.sent)

        self.bot.command_used.clear()
        await self.bot.on_message(make_message("!switch bot", 5, switched, guild_id=11))
        self.assertIn("back on owaua", switched.sent[-1])
        self.assertEqual(self.store.get_setting("bot_engine:11"), "owaua")

        await self.bot.on_message(make_message("!help", 6, switched, guild_id=11))
        self.assertEqual(switched.sent[-1], HELP_TEXT)

    async def test_switch_requires_manage_server_and_a_guild(self) -> None:
        channel = FakeChannel()
        await self.bot.on_message(
            make_message("!switch bot", 1, channel, author_id=33, manage_guild=False)
        )
        self.assertEqual(channel.sent, ["you need the Manage Server permission to switch this server"])
        self.assertEqual(self.store.get_setting("bot_engine:11"), "")

        direct = FakeChannel()
        self.bot.command_used.clear()
        with patch("bot.ALLOW_DMS", True):
            await self.bot.on_message(
                make_message("!switch bot", 2, direct, guild_id=None, author_id=33)
            )
        self.assertEqual(direct.sent, ["!switch bot only works in a server"])

    async def test_hosted_comma_help_runs_sefbot_code(self) -> None:
        project = Path(__file__).resolve().parents[1]
        if resolve_sefbot_root(project) is None or shutil.which("node") is None:
            self.skipTest("sefbot runtime is not installed")
        host = SefbotHost(project, Path(self.temporary_directory.name) / "sefbot-data")
        replies: list[str] = []

        async def actor(action: dict[str, object]) -> None:
            if action.get("name") == "reply" and isinstance(action.get("content"), str):
                replies.append(action["content"])

        try:
            await asyncio.wait_for(host.handle_message(
                {
                    "id": "m1",
                    "guildId": "11",
                    "channelId": "22",
                    "userId": "33",
                    "username": "member",
                    "displayName": "member",
                    "content": ",help",
                    "mentioned": False,
                    "botUserId": "99",
                    "attachments": [],
                },
                actor,
            ),
                30,
            )
        finally:
            await host.stop()

        self.assertTrue(replies)
        self.assertIn("Sefbot", replies[0])
        self.assertIn(",ask", replies[0])


class FakeSefbot:
    def __init__(self) -> None:
        self.messages: list[dict[str, object]] = []
        self.ensured = 0
        self.commands = [{"name": "help", "description": "What this bot can do"}]

    async def ensure(self) -> None:
        self.ensured += 1

    async def slash_commands(self) -> list[dict[str, object]]:
        return self.commands

    async def handle_message(self, payload: dict[str, object], actor) -> None:
        self.messages.append(payload)
        await actor({"name": "reply", "content": "from sefbot"})

    async def stop(self) -> None:
        return None
