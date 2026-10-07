"""Offline integration checks for notes, research, documents and model routing."""
import offline_test_config

import io
import json
import time
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from pypdf import PdfWriter
from pypdf.generic import DictionaryObject, NameObject, DecodedStreamObject
import httpx

import ask as ask_module
from intelligence import document_kind, extract_pending_notes, parse_document, read_document, search_needed
import test_ask as ask_fixtures
model_reply = ask_fixtures.model_reply
import test_channel_commands as command_fixtures
FakeChannel = command_fixtures.FakeChannel
make_message = command_fixtures.make_message


class IntelligenceAskTests(unittest.IsolatedAsyncioTestCase):
    setUp = ask_fixtures.AskTests.setUp
    tearDown = ask_fixtures.AskTests.tearDown
    _ask = ask_fixtures.AskTests._ask
    async def test_auto_search_has_web_only_and_keeps_sources(self):
        self.http.responses = {"output": [{"type": "message", "content": [{
            "type": "output_text", "text": "Today's weather is sunny.",
            "annotations": [{"type": "url_citation", "url": "https://example.org/weather", "title": "Weather"}],
        }]}]}
        answer = await self._ask("what's the weather today?")
        body = self.http.calls[0][1]["json"]
        self.assertEqual([t["type"] for t in body["tools"]], ["web_search"])
        self.assertIn("https://example.org/weather", answer)

    async def test_mercury_and_luna_tool_fallback(self):
        with patch("ask.INCEPTION_API_KEY", "test-only-key"):
            await self._ask("hello", model_key="mercury")
            url, request = self.http.calls[-1]
            body = request["json"]
            self.assertIn("api.inceptionlabs.ai", url)
            self.assertEqual(body["model"], "mercury-2.5")
            self.assertEqual(body["reasoning_effort"], "instant")
            self.assertIn("max_completion_tokens", body)
            self.assertNotIn("tools", body)
            answer = await self._ask("latest news", model_key="mercury", event_id="search")
            self.assertTrue(self.http.calls[-1][0].endswith("/responses"))
            self.assertIn("Used Luna", answer)

    async def test_documents_are_transient_and_have_citation_guidance(self):
        await self._ask("explain this", documents_text="[File: x.txt]\n[Lines 1-1]\nprivate attachment text")
        body = self.http.calls[-1][1]["json"]
        self.assertIn("private attachment text", json.dumps(body["input"]))
        self.assertIn("page or line markers", body["instructions"])
        self.assertNotIn("private attachment text", json.dumps(self.memory.recent_messages("123", "7", limit=20)))
        batches = self.memory.pending_note_batches()
        self.assertEqual(batches, [])  # waits for batching deadline

    def seed_notes(self, user="7", server="", text="The user is building a garden"):
        generation = self.memory.memory_generation(user, server)
        rows = [{"id": 9999, "channel_id": "123"}]
        self.memory.apply_extracted_notes(user, server, generation, rows, [{"text": text, "source": 1}])
        return generation, rows

    async def test_memory_scopes_pause_resume_and_prompt_recall(self):
        self.seed_notes()
        self.assertEqual(self.memory.list_notes("8", ""), [])
        self.assertEqual(self.memory.list_notes("7", "other-server"), [])
        await self._ask("how is my garden?", event_id="recall")
        self.assertIn("building a garden", json.dumps(self.http.calls[-1][1]["json"]["input"]))
        self.memory.pause_notes("7", "", True)
        await self._ask("how is my garden?", event_id="paused")
        self.assertNotIn("building a garden", json.dumps(self.http.calls[-1][1]["json"]["input"]))
        self.assertEqual(len(self.memory.list_notes("7", "")), 1)
        self.memory.pause_notes("7", "", False)
        self.assertEqual(len(self.memory.recall_notes("7", "", "garden")), 1)

    def test_inflight_extraction_cannot_restore_erased_notes(self):
        generation, rows = self.seed_notes()
        self.memory.erase_user_memory("7")
        self.memory.apply_extracted_notes("7", "", generation, rows, [{"text": "restored", "source": 1}])
        self.assertEqual(self.memory.list_notes("7", ""), [])

    def test_note_correction_and_deletion_are_owned(self):
        self.seed_notes()
        note_id = self.memory.list_notes("7", "")[0]["id"]
        self.assertFalse(self.memory.edit_note("8", "", note_id, "stolen"))
        self.assertTrue(self.memory.edit_note("7", "", note_id, "The user grows roses"))
        self.assertEqual(self.memory.list_notes("7", "")[0]["text"], "The user grows roses")
        self.assertTrue(self.memory.edit_note("7", "", note_id, None))
        self.assertEqual(self.memory.list_notes("7", ""), [])

    async def test_background_extraction_batches_only_user_statements(self):
        generation = self.memory.memory_generation("7", "")
        for i in range(6):
            self.memory.queue_note_extraction(str(i), "7", "", "123", "I am building a garden", generation)
        self.http.responses = model_reply('[{"text":"The user is building a garden","source":1,"replaces":null}]')
        await extract_pending_notes(self.http, self.memory)
        self.assertEqual(len(self.http.calls), 1)
        self.assertEqual(self.memory.list_notes("7", "")[0]["text"], "The user is building a garden")
        self.assertEqual(self.memory.pending_note_batches(), [])
        self.assertNotIn("tools", self.http.calls[-1][1]["json"])

    def test_notes_survive_reopening_database(self):
        self.seed_notes()
        from memory import MemoryStore
        other = MemoryStore(self.memory.path)
        try:
            self.assertEqual(len(other.list_notes("7", "")), 1)
        finally:
            other.close()

    def test_document_formats_and_limits(self):
        self.assertEqual(document_kind(SimpleNamespace(filename="x.csv", content_type=None)), "text")
        self.assertIn("[Lines 1-2]", parse_document(b"a\nb", "text"))
        with self.assertRaises(ValueError):
            parse_document(b"x" * (8 * 1024 * 1024 + 1), "text")
        writer = PdfWriter()
        for _ in range(21):
            writer.add_blank_page(width=100, height=100)
        output = io.BytesIO()
        writer.write(output)
        with self.assertRaisesRegex(ValueError, "20-page"):
            parse_document(output.getvalue(), "pdf")

    async def test_document_reader_rejects_external_urls_before_network(self):
        with self.assertRaises(ValueError):
            await read_document(self.http, SimpleNamespace(filename="x.pdf", content_type="application/pdf", url="https://example.com/x.pdf", size=1))
        self.assertEqual(self.http.calls, [])

    async def test_pdf_text_and_subprocess_reader(self):
        writer = PdfWriter()
        page = writer.add_blank_page(width=200, height=200)
        font = DictionaryObject({NameObject("/Type"): NameObject("/Font"), NameObject("/Subtype"): NameObject("/Type1"), NameObject("/BaseFont"): NameObject("/Helvetica")})
        page[NameObject("/Resources")] = DictionaryObject({NameObject("/Font"): DictionaryObject({NameObject("/F1"): writer._add_object(font)})})
        stream = DecodedStreamObject()
        stream.set_data(b"BT /F1 12 Tf 10 100 Td (garden project) Tj ET")
        page[NameObject("/Contents")] = writer._add_object(stream)
        data = io.BytesIO()
        writer.write(data)
        self.assertIn("[Page 1]\ngarden project", parse_document(data.getvalue(), "pdf"))
        transport = httpx.MockTransport(lambda request: httpx.Response(200, content=data.getvalue()))
        async with httpx.AsyncClient(transport=transport) as client:
            text = await read_document(client, SimpleNamespace(filename="garden.pdf", content_type="application/pdf", url="https://cdn.discordapp.com/garden.pdf", size=len(data.getvalue())))
        self.assertIn("garden.pdf", text)
        self.assertIn("[Page 1]\ngarden project", text)

    def test_server_erasure_keeps_other_server_notes(self):
        generation, rows = self.seed_notes(server="one")
        self.seed_notes(server="two")
        self.memory.erase_server_memory("one")
        self.memory.apply_extracted_notes("7", "one", generation, rows, [{"text": "old", "source": 1}])
        self.assertEqual(self.memory.list_notes("7", "one"), [])
        self.assertEqual(len(self.memory.list_notes("7", "two")), 1)

    async def test_mercury_image_uses_luna(self):
        with patch("ask.INCEPTION_API_KEY", "test-only-key"):
            result = await self._ask("look", image_urls=["https://cdn.discordapp.com/image.png"], model_key="mercury")
        self.assertTrue(self.http.calls[-1][0].endswith("/responses"))
        self.assertIn("Used Luna", result)

    def test_search_router_avoids_smalltalk(self):
        for text in ["hello", "how are you", "what is friendship", "I love the weather", "version 2 in 2019"]:
            self.assertFalse(search_needed(text), text)
        for text in ["latest news", "weather in Budapest", "what happened in 2025?", "read https://example.com"]:
            self.assertTrue(search_needed(text), text)


class IntelligenceCommandTests(unittest.IsolatedAsyncioTestCase):
    setUp = command_fixtures.ChannelCommandTests.setUp
    tearDown = command_fixtures.ChannelCommandTests.tearDown
    async def test_persona_switch_preserves_conversation(self):
        self.store.append_message(event_id="original", scope_id="22", user_id="33", server_id="11", role="user", content="my project is a garden")
        await self.bot.on_message(make_message("!persona cute", 1, FakeChannel()))
        self.assertEqual(self.store.recent_messages("22", "33", limit=20)[0]["content"], "my project is a garden")

    async def test_context_off_stops_capture_and_recall(self):
        channel = FakeChannel()
        await self.bot.on_message(make_message("chatter", 1, channel))
        self.assertTrue(self.store.recent_channel_lines("22", limit=20))
        await self.bot.on_message(make_message("!context off", 2, channel))
        await self.bot.on_message(make_message("more chatter", 3, channel))
        self.assertEqual(self.store.recent_channel_lines("22", limit=20), [])
        with patch("bot.ask", new_callable=AsyncMock, return_value="hi") as mocked:
            await self.bot.on_message(make_message("<@99> hello", 4, channel, mentions=[self.bot.user]))
        self.assertEqual(mocked.await_args.kwargs["channel_lines"], [])

    async def test_context_change_requires_manager(self):
        channel = FakeChannel()
        await self.bot.on_message(make_message("!context off", 1, channel, manage_guild=False))
        self.assertIn("Manage Server", channel.sent[-1])
        self.assertTrue(self.store.channel_context_enabled("11", "22"))

    async def test_document_only_mention_gets_summary(self):
        channel = FakeChannel()
        attachment = SimpleNamespace(filename="x.txt", content_type="text/plain", url="https://cdn.discordapp.com/x.txt")
        with patch("bot.read_document", new_callable=AsyncMock, return_value="[Lines 1-1]\nhello"), patch("bot.ask", new_callable=AsyncMock, return_value="summary") as mocked:
            await self.bot.on_message(make_message("<@99>", 1, channel, mentions=[self.bot.user], attachments=[attachment]))
        self.assertEqual(mocked.await_args.kwargs["prompt"], "Summarize the attached document.")
        self.assertEqual(mocked.await_args.kwargs["user_statement"], "")
        self.assertIn("hello", mocked.await_args.kwargs["documents_text"])

    async def test_memory_view_is_private(self):
        generation = self.store.memory_generation("33", "11")
        self.store.apply_extracted_notes("33", "11", generation, [{"id": 999, "channel_id": "22"}], [{"text": "private project", "source": 1}])
        channel = FakeChannel()
        message = make_message("!memory view", 1, channel)
        message.author.send = AsyncMock()
        await self.bot.on_message(message)
        self.assertNotIn("private project", channel.sent[-1])
        self.assertIn("private project", message.author.send.await_args.args[0])
