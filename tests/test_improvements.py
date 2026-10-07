"""Behavior regressions for helpful answers, reliable memory and bounded work."""

from __future__ import annotations
import offline_test_config
import asyncio
import json
import sqlite3
import time
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from ask import (
    ProviderError,
    response_reply,
    _chat_completions_tool_loop,
    ollama_full_tools,
)
from bot import split_reply
from intelligence import (
    plan_request,
    extract_pending_notes,
    summarize_pending_conversation,
    parse_document,
)
from memory import MemoryStore
import test_ask as fixtures
import test_memory


class PlanningTests(unittest.TestCase):
    def test_casual_and_help_have_different_budgets(self):
        self.assertEqual(plan_request("hey").output_tokens, 256)
        for prompt in (
            "explain recursion",
            "help me debug this",
            "how do I make bread?",
        ):
            self.assertEqual(plan_request(prompt).output_tokens, 1200)

    def test_search_follows_relevant_previous_request(self):
        plan = plan_request(
            "what about Vienna?", [{"role": "user", "content": "weather in Budapest"}]
        )
        self.assertTrue(plan.search)
        self.assertFalse(plan.search_required)
        self.assertFalse(
            plan_request(
                "what about you?", [{"role": "user", "content": "hello"}]
            ).search
        )

    def test_explicit_verification_is_required(self):
        self.assertTrue(plan_request("verify this claim").search_required)
        self.assertTrue(plan_request("search for Budapest weather").search)

    def test_long_document_reports_truncation(self):
        self.assertIn("Text truncated", parse_document(b"line\n" * 6000, "text"))
        with self.assertRaises(ValueError):
            parse_document(b"", "text")

    def test_code_fences_and_links_survive_chunking(self):
        text = (
            "```python\n"
            + "print('hello')\n" * 50
            + "```\n[Source](<https://example.org/page>)"
        )
        chunks = split_reply(text, 120)
        self.assertTrue(all(len(c) <= 120 for c in chunks))
        self.assertTrue(all(c.count("```") % 2 == 0 for c in chunks))
        self.assertIn("[Source](<https://example.org/page>)", "\n".join(chunks))

    def test_long_link_moves_whole_to_next_chunk(self):
        link = "[Reference](<https://example.org/a-long-path>)"
        chunks = split_reply("word " * 14 + link, 90)
        self.assertTrue(any(link in c for c in chunks))

    def test_provider_result_retains_usage_model_and_tools(self):
        reply = response_reply(
            {
                "model": "actual",
                "usage": {"input_tokens": 100},
                "output": [
                    {"type": "web_search_call"},
                    {
                        "type": "message",
                        "content": [
                            {
                                "type": "output_text",
                                "text": "answer",
                                "annotations": [
                                    {
                                        "type": "url_citation",
                                        "url": "https://example.org",
                                        "title": "Source",
                                    }
                                ],
                            }
                        ],
                    },
                ],
            }
        )
        self.assertEqual(reply.result.model, "actual")
        self.assertEqual(reply.result.usage["input_tokens"], 100)
        self.assertEqual(reply.result.tool_activity, ("web_search_call",))
        self.assertTrue(reply.result.citations)


class ReliableMemoryTests(test_memory.MemoryStoreTests):
    # The inherited persistence tests also exercise the migrated schema.
    def seed(self, text, *, replaces=None, user="u", server="g"):
        generation = self.store.memory_generation(user, server)
        self.store.apply_extracted_notes(
            user,
            server,
            generation,
            [{"id": 9999, "channel_id": "channel", "event_id": "source-event"}],
            [{"text": text, "source": 1, "replaces": replaces}],
        )

    def test_normalized_deduplication_and_correction_preserve_id(self):
        self.seed("The user grows roses.")
        self.seed("THE USER grows roses!")
        notes = self.store.list_notes("u", "g")
        self.assertEqual(len(notes), 1)
        original = notes[0]
        self.seed("The user grows lilies.", replaces=original["id"])
        note = self.store.list_notes("u", "g")[0]
        self.assertEqual(note["id"], original["id"])
        self.assertEqual(note["created_at"], original["created_at"])
        self.assertEqual(note["source_event"], "source-event")

    def test_correction_cannot_replace_another_users_note(self):
        self.seed("The user grows roses.")
        note = self.store.list_notes("u", "g")[0]
        self.seed("The user grows lilies.", replaces=note["id"], user="other")
        self.assertEqual(self.store.list_notes("u", "g")[0]["text"], note["text"])
        self.assertEqual(self.store.list_notes("other", "g"), [])

    def test_irrelevant_notes_are_not_injected(self):
        self.seed("The user grows roses.")
        self.seed("The user prefers concise answers.")
        recall = self.store.recall_notes("u", "g", "debug my program")
        self.assertEqual(len(recall), 1)
        self.assertIn("prefers", recall[0]["text"])

    def test_notes_and_queue_reject_recognizable_secrets(self):
        self.seed("api_key=sk-abcdefghijklmnop1234")
        generation = self.store.memory_generation("u", "g")
        self.store.queue_note_extraction(
            "secret", "u", "g", "channel", "password=hunter2", generation
        )
        self.assertEqual(self.store.list_notes("u", "g"), [])
        self.assertEqual(self.store.background_status("u", "g"), (0, 0))

    def test_legacy_database_backed_up_before_migration(self):
        path = Path(self.temporary_directory.name) / "legacy.sqlite3"
        with sqlite3.connect(path) as db:
            db.execute(
                "CREATE TABLE app_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)"
            )
            db.execute("INSERT INTO app_settings VALUES ('custom','keep')")
        migrated = MemoryStore(path)
        self.addCleanup(migrated.close)
        self.assertTrue(path.with_name(path.name + ".pre-v1.backup").exists())
        self.assertEqual(migrated.get_setting("custom"), "keep")
        self.assertEqual(
            migrated._connect().execute("PRAGMA user_version").fetchone()[0], 1
        )

    def test_retry_state_survives_restart_and_quarantines_after_three_attempts(self):
        generation = self.store.memory_generation("u", "g")
        for i in range(6):
            self.store.queue_note_extraction(
                str(i), "u", "g", "channel", "I grow roses", generation
            )
        rows = self.store.pending_note_batches()[0][3]
        self.store.fail_note_batch(rows, transient=True)
        self.assertEqual(self.store.pending_note_batches(), [])
        reopened = MemoryStore(self.path)
        self.addCleanup(reopened.close)
        self.assertEqual(reopened.background_status("u", "g"), (6, 0))
        for attempt in (1, 2):
            self.store.fail_note_batch(
                [dict(r, attempts=attempt) for r in rows], transient=True
            )
        self.assertEqual(self.store.background_status("u", "g"), (6, 6))

    def test_pause_shared_between_instances(self):
        other = MemoryStore(self.path)
        self.addCleanup(other.close)
        self.assertFalse(other.notes_paused("u", "g"))
        self.store.pause_notes("u", "g", True)
        self.assertTrue(other.notes_paused("u", "g"))

    def seed_summary(self):
        for i in range(20):
            self.store.append_message(
                event_id=str(i),
                scope_id="channel",
                user_id="u",
                server_id="g",
                role="user" if i % 2 == 0 else "assistant",
                content="project discussion",
            )
        return self.store.pending_summary()

    def test_summary_persists_and_is_scoped(self):
        job, messages, generation = self.seed_summary()
        self.assertTrue(
            self.store.apply_summary(
                job, messages, generation, "We are designing a garden."
            )
        )
        self.assertEqual(self.store.conversation_summary("other", "u", "g"), "")
        self.assertEqual(self.store.conversation_summary("channel", "other", "g"), "")
        reopened = MemoryStore(self.path)
        self.addCleanup(reopened.close)
        self.assertIn("garden", reopened.conversation_summary("channel", "u", "g"))
        self.assertIsNone(self.store.pending_summary())

    def test_erasure_and_pause_fence_summary_writes(self):
        job, messages, generation = self.seed_summary()
        self.store.erase_user_memory("u")
        self.assertFalse(
            self.store.apply_summary(job, messages, generation, "old facts")
        )
        self.assertEqual(self.store.conversation_summary("channel", "u", "g"), "")

    def test_new_messages_arriving_during_summary_are_not_lost(self):
        job, messages, generation = self.seed_summary()
        self.store.append_message(
            event_id="new",
            scope_id="channel",
            user_id="u",
            server_id="g",
            role="user",
            content="new request",
        )
        self.store.apply_summary(job, messages, generation, "summary")
        count = (
            self.store._connect()
            .execute("SELECT message_count FROM conversation_summaries")
            .fetchone()[0]
        )
        self.assertEqual(count, 1)


class ImprovementsAskTests(unittest.IsolatedAsyncioTestCase):
    setUp = fixtures.AskTests.setUp
    tearDown = fixtures.AskTests.tearDown
    _ask = fixtures.AskTests._ask

    async def test_helpful_answers_keep_formatting_without_repair(self):
        answer = "Here is the explanation.\n\n```python\nprint('hello')\n```"
        self.http.responses = fixtures.model_reply(answer)
        for i, persona in enumerate(("normal", "rudeish-high", "cute", "nerdish")):
            result = await self._ask(
                "explain this code", persona=persona, event_id=str(i)
            )
            self.assertEqual(result, answer)
            self.assertEqual(self.http.calls[-1][1]["json"]["max_output_tokens"], 1200)
        self.assertEqual(len(self.http.calls), 4)

    async def test_explicit_search_forces_web_tool(self):
        await self._ask("verify this claim")
        body = self.http.calls[-1][1]["json"]
        self.assertEqual(body["tool_choice"], {"type": "web_search"})
        self.assertEqual(body["max_tool_calls"], 2)

    async def test_quote_does_not_reduce_input_or_enter_history_and_notes(self):
        prompt = "explain " + "x" * 1800
        await self._ask(prompt, quoted_context="OTHER PERSON: private statement " * 150)
        body = self.http.calls[-1][1]["json"]
        self.assertIn(prompt, json.dumps(body["input"]))
        stored = self.memory.recent_messages("123", "7", limit=20)
        self.assertEqual(stored[0]["content"], prompt)
        self.assertNotIn("OTHER PERSON", json.dumps(stored))

    async def test_repair_consumes_second_attempt(self):
        self.http.responses = [
            fixtures.model_reply("As an AI language model, I cannot be your friend."),
            fixtures.model_reply("hey there"),
        ]
        await self._ask("hey")
        used = (
            self.memory._connect()
            .execute("SELECT count(*) FROM api_usage")
            .fetchone()[0]
        )
        self.assertEqual(used, len(self.http.calls))

    async def test_transient_extraction_failure_is_retained(self):
        generation = self.memory.memory_generation("7", "")
        for i in range(6):
            self.memory.queue_note_extraction(
                str(i), "7", "", "123", "I grow roses", generation
            )
        with patch(
            "ask.request_ai",
            AsyncMock(side_effect=ProviderError("unavailable", transient=True)),
        ):
            await extract_pending_notes(self.http, self.memory)
        self.assertEqual(self.memory.background_status("7", ""), (6, 0))

    async def test_malformed_extraction_is_quarantined(self):
        generation = self.memory.memory_generation("7", "")
        for i in range(6):
            self.memory.queue_note_extraction(
                str(i), "7", "", "123", "I grow roses", generation
            )
        self.http.responses = fixtures.model_reply('[{"text":"invented","source":900}]')
        await extract_pending_notes(self.http, self.memory)
        self.assertEqual(self.memory.background_status("7", ""), (6, 6))
        self.assertEqual(self.memory.list_notes("7", ""), [])

    async def test_summary_background_request_is_capped_and_has_no_tools(self):
        for i in range(20):
            self.memory.append_message(
                event_id=str(i),
                scope_id="123",
                user_id="7",
                server_id="",
                role="user",
                content="garden plan",
            )
        self.http.responses = fixtures.model_reply(
            "The user is planning a garden layout."
        )
        await summarize_pending_conversation(self.http, self.memory)
        self.assertIn("garden", self.memory.conversation_summary("123", "7", ""))
        body = self.http.calls[-1][1]["json"]
        self.assertEqual(body["max_output_tokens"], 700)
        self.assertNotIn("tools", body)

    async def test_unadvertised_web_tool_does_not_execute(self):
        self.http.responses = [
            {
                "choices": [
                    {
                        "message": {
                            "content": None,
                            "tool_calls": [
                                {
                                    "id": "call",
                                    "function": {
                                        "name": "web_search",
                                        "arguments": "{}",
                                    },
                                }
                            ],
                        }
                    }
                ]
            },
            {"choices": [{"message": {"content": "unavailable"}}]},
        ]
        with patch("ask.execute_web_search", AsyncMock()) as search:
            result = await _chat_completions_tool_loop(
                self.http,
                "http://fake",
                {},
                {"model": "local", "messages": []},
                authorize=AsyncMock(),
            )
        search.assert_not_awaited()
        self.assertEqual(result, "unavailable")


class MusicLifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def test_old_disconnect_does_not_remove_replacement_state(self):
        from types import SimpleNamespace
        from music import stop_music

        replacement = {"title": "new"}
        bot = SimpleNamespace(music_tracks={11: {"title": "old"}})

        async def disconnect():
            bot.music_tracks[11] = replacement

        voice = SimpleNamespace(stop=lambda: None, disconnect=disconnect)
        await stop_music(bot, SimpleNamespace(id=11, voice_client=voice))
        self.assertIs(bot.music_tracks[11], replacement)

    async def test_failed_replacement_disconnects_existing_voice(self):
        from types import SimpleNamespace
        from music import _play_or_restart
        import test_music_attachments as music_fixtures

        message, voice = music_fixtures.make_music_message(
            SimpleNamespace(
                size=100,
                filename="song.mp3",
                content_type="audio/mpeg",
                url="https://cdn.discordapp.com/song.mp3",
            )
        )
        voice.disconnect = AsyncMock()
        bot = SimpleNamespace(
            music_tracks={message.guild.id: {"query": "old", "title": "old"}},
            user=SimpleNamespace(id=99),
        )
        track = {
            "query": "https://cdn.discordapp.com/song.mp3",
            "url": "https://cdn.discordapp.com/song.mp3",
            "title": "new",
            "source": "attachment",
        }
        with (
            patch("music.play_track", side_effect=RuntimeError("decoder failed")),
            patch("music._connect_to_author", AsyncMock(return_value=(voice, None))),
            patch("music.download_audio", AsyncMock(return_value=b"audio")),
        ):
            await _play_or_restart(
                bot, message, track["query"], verb="playing", direct_track=track
            )
        self.assertNotIn(message.guild.id, bot.music_tracks)
        voice.disconnect.assert_awaited_once()


class ProviderBudgetTests(unittest.IsolatedAsyncioTestCase):
    setUp = fixtures.AskTests.setUp
    tearDown = fixtures.AskTests.tearDown
    _ask = fixtures.AskTests._ask

    async def test_mercury_honors_casual_and_substantive_budgets(self):
        await self._ask("hello", model_key="mercury")
        body = self.http.calls[-1][1]["json"]
        self.assertEqual(body["max_completion_tokens"], 256)
        self.assertEqual(body["reasoning_effort"], "instant")
        await self._ask("debug my code", model_key="mercury", event_id="debug")
        body = self.http.calls[-1][1]["json"]
        self.assertEqual(body["max_completion_tokens"], 1200)
        self.assertEqual(body["reasoning_effort"], "medium")

    async def test_luna_uses_bounded_reasoning_for_difficult_help(self):
        await self._ask("debug my code")
        body = self.http.calls[-1][1]["json"]
        self.assertEqual(body["reasoning"], {"effort": "low"})
        self.assertEqual(body["max_output_tokens"], 1200)

    async def test_cancel_before_tool_dispatch_prevents_execution(self):
        from security import BudgetExceeded

        self.http.responses = [
            {
                "choices": [
                    {
                        "message": {
                            "content": None,
                            "tool_calls": [
                                {
                                    "id": "call",
                                    "function": {
                                        "name": "web_search",
                                        "arguments": "{}",
                                    },
                                }
                            ],
                        }
                    }
                ]
            }
        ]
        with patch("ask.execute_web_search", AsyncMock()) as search:
            with self.assertRaises(BudgetExceeded):
                await _chat_completions_tool_loop(
                    self.http,
                    "http://fake",
                    {},
                    {"model": "local", "messages": [], "tools": ollama_full_tools()},
                    authorize=AsyncMock(),
                    recheck=AsyncMock(side_effect=BudgetExceeded("erased")),
                )
        search.assert_not_awaited()


class HonestyTests(unittest.IsolatedAsyncioTestCase):
    setUp = fixtures.AskTests.setUp
    tearDown = fixtures.AskTests.tearDown
    _ask = fixtures.AskTests._ask

    async def test_substantive_answer_preserves_complete_code_and_citation(self):
        answer = "```python\n" + "# comment\n" * 600 + "```\n[Source](https://example.org)"
        self.http.responses = fixtures.model_reply(answer)
        result = await self._ask("explain this code")
        self.assertEqual(result, answer)
        self.assertEqual(self.http.calls[-1][1]["json"]["max_output_tokens"], 1200)

    async def test_human_mode_keeps_truthful_identity_answer(self):
        answer = "I'm an AI model running as a Discord bot."
        self.http.responses = fixtures.model_reply(answer)
        result = await self._ask("are you an AI?", human=True)
        self.assertEqual(result, answer)
        self.assertEqual(len(self.http.calls), 1)

    async def test_local_full_mode_does_not_claim_code_execution(self):
        with patch("ask.LOCAL_AI_ONLY", True), patch("ask.LOCAL_ENABLE_TOOLS", False):
            await self._ask(
                "explain recursion", full_mode=True, full_mode_provider="ollama"
            )
        body = self.http.calls[-1][1]["json"]
        instructions = body["messages"][0]["content"]
        self.assertIn("Local Python/code execution is disabled", instructions)
        self.assertIn("No web tools are enabled", instructions)
        self.assertNotIn("tools", body)


class ShutdownTests(unittest.IsolatedAsyncioTestCase):
    async def test_handlers_finish_before_shared_resources_close(self):
        from types import SimpleNamespace
        from unittest.mock import Mock
        from bot import PersonaBot
        import discord

        events = []
        ready = asyncio.Event()

        async def handler():
            ready.set()
            try:
                await asyncio.Event().wait()
            finally:
                events.append("handler finished")

        task = asyncio.create_task(handler())
        await ready.wait()
        bot = PersonaBot.__new__(PersonaBot)
        bot._connection = SimpleNamespace(voice_clients=[])
        bot.active_handlers = {task}
        bot.provider_http = SimpleNamespace(
            aclose=AsyncMock(side_effect=lambda: events.append("http closed"))
        )
        bot.memory = SimpleNamespace(
            close=Mock(side_effect=lambda: events.append("database closed"))
        )
        bot.shutdown_requested = False
        with patch.object(discord.Client, "close", AsyncMock()):
            await bot.close()
        self.assertTrue(task.done())
        self.assertEqual(events, ["handler finished", "http closed", "database closed"])
        self.assertFalse(bot.shutdown_requested)
        self.assertTrue(bot.closing)
