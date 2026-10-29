# Mistral in Owaua

Owaua's Mistral chat model is **Mistral Large 4**, API ID `mistral-large-4`.
Set `MISTRAL_API_KEY` on the existing Owaua bot service. Keys never belong in Git
or Discord commands. The owner's `.provider mistral` / `/provider` selects it;
`.provider xai` selects xAI and `.provider switch` toggles the provider. The choice
applies to the current server (or current user's DMs) and persists across restarts.

A confirmed insufficient-balance error selects the other configured provider for
the affected server. It starts one shared recovery watcher for that failed key:
after five minutes, a single `hello` request uses `ministral-3b-latest` for Mistral,
or `grok-4.3` with reasoning disabled for xAI, with an eight-token output limit
and no user data or tools. Failed probes back off to 10, 20, 40 and 60 minutes.
A valid generated answer restores servers still on automatic fallback and stops
the watcher. Manual provider changes are preserved. No probes run before a
balance error; persisted schedules resume after restart.
Ordinary authentication, validation, rate-limit and server errors do not switch
providers unless the error specifically identifies exhausted credit. Explicit
Mistral API actions are never replayed against another provider.

Normal `/speak`, `/transcribe` and `/voice voices` commands use the active speech
provider. Mistral speech defaults to `gb_jane_neutral`; choose a Mistral voice ID
for a different voice. MP3 and WAV work through `/speak`; the raw API additionally
accepts PCM, FLAC and Opus. Use Mistral's pace tags for delivery changes: xAI's
explicit speed/language/timing/normalization options are not Mistral speech options
and are rejected when unsupported. Mistral transcription uses segment timestamps
and optional diarization; use a two-letter language code. `/voice join` continues
to use the existing xAI realtime service. PDF documents use inline Responses file
data and text/code files are included as UTF-8 input.

## Full REST operation interface

The owner can call all **288 REST operations published in the audited official
Mistral TypeScript SDK**, rather than only the chat endpoint:

```text
.mistral operations
.mistral responses {"input":"Explain gravitational waves briefly."}
.mistral search {"inputs":"Find today's astronomy news and cite sources."}
.mistral embeddings {"input":["A sentence to embed."]}
.mistral ocr {"document":{"type":"document_url","document_url":"https://example.org/report.pdf"}}
.mistral speech {"input":"Hello there.","voice_id":"gb_jane_neutral","response_format":"mp3"}
.mistral files.upload {"purpose":"ocr"}
.mistral files.download {"file_id":"YOUR_FILE_ID"}
.mistral betaLibrariesDocumentsUpload {"library_id":"YOUR_LIBRARY_ID"}
.mistral betaConversationsStart {"inputs":"Research this topic.","tools":[{"type":"web_search_premium"},{"type":"code_interpreter"}]}
.mistral batchJobsGet {"job_id":"YOUR_JOB_ID"}
```

Use `/mistral` with the same `operation`, JSON `payload`, and optional `file`
attachment. Attach a real Discord file to upload and transcription commands.
The attachment is downloaded only from Discord's CDN, without the Mistral key,
then uploaded to the fixed Mistral API origin.

`.mistral operations` returns the full catalog privately as a JSON attachment,
including every exact operation name, HTTP method, route, known query fields and
multipart/stream flags. Names such as `betaConversationsStart` match the official
SDK. Friendly aliases cover common calls; use the catalog for all other features.
The catalog is checked in and requires a deliberate code update when Mistral adds
new endpoints.

Use **REST snake_case field names**, as documented by Mistral, not SDK camelCase
names. Put path parameters such as `file_id`, `library_id` and `job_id` alongside
the body fields. They are removed from the body and safely inserted in the fixed
route. Known query fields are also separated automatically; `_query` explicitly
supplies additional query parameters. GET payload fields become query fields.
For endpoints taking a list or scalar at the root, place it in `_body` and keep
path parameters outside `_body`.

```text
.mistral files.url {"file_id":"YOUR_FILE_ID","expiry":1}
.mistral betaConnectorsCallTool {"connector_id_or_name":"YOUR_CONNECTOR","tool_name":"search","credentials_name":"work","arguments":{"query":"example"}}
```

Only the authenticated bot owner can use this interface. Model function calls
and text claiming to be the owner cannot invoke it. Responses are sent privately
(ephemeral slash replies, or DMs for dot commands in servers), mentions are
disabled, provider error bodies are withheld, and returned credential fields are
redacted. Query/path fields cannot select another hostname or arbitrary endpoint.

## Feature coverage and limits

| Family | Available operations |
| --- | --- |
| Models and generation | Model listing/retrieval, Chat Completions, Responses, input token counting, reasoning, sampling, JSON/schema output, function/namespace tools, vision/document inputs, FIM/code completion |
| Agents and Conversations | Agent/version/alias management, conversation creation/history/append/restart/deletion, hosted web/premium search, code execution, image generation, document libraries, handoffs and connectors |
| Documents and retrieval | OCR with structured extraction and annotations, text/code embeddings, files and signed URLs, libraries/documents/accesses, managed search indexes and ingestion configuration |
| Audio | Speech, transcription, voices, audio agents/sessions, realtime session creation |
| Safety | Text/chat moderation and classification |
| Batch and model management | Batch creation/list/status/cancellation/deletion and fine-tuned model rename/archive/deletion |
| Platform tools | Connector tools/credentials/access, prompts, skills, user/workspace identity, service accounts/roles, observability datasets/evaluations/judges/logs/spans/traces |
| Workflows | Workflow registrations, deployment workers/logs/start/stop, executions/history/signals/queries/reset/cancel/terminate, runs, schedules, events and metrics |

These are API operations, not a claim that Large 4 itself supplies every model
modality. OCR, embeddings, FIM, moderation and speech/transcription use their
specialist models. Reasoning settings must match the selected model. Model and
feature availability still depends on the account, region, permissions and credit.

Large 4 is the default for ordinary generation, Responses, new Conversations and
new Agents. Specialist aliases select documented model defaults when no model is
provided. The API returns raw JSON, so audio speech results expose `audio_data`
and Conversations generated-image results expose `tool_file` IDs. Use
`files.download` to retrieve a generated file or `files.url` for a signed link.

This Discord interface transfers at most 8 MiB per input/output and accepts at
most 6,000 JSON payload characters. It times requests out after three minutes.
Large jobs should use the asynchronous batch/workflow APIs and later status/file
calls. Pagination is explicit: request subsequent pages using the API's documented
pagination fields. API-side limits still apply.

Streaming REST variants can return a bounded SSE event-log attachment after
completion; this command does not forward live token/audio frames. Realtime
session creation is available, but this command does not establish a WebSocket,
WebRTC room, live microphone stream or interactive OAuth browser flow. Use a
compatible client for those session transports. OAuth/connector operations require
the corresponding account setup; credential results remain redacted.

Legacy fine-tuning job creation is deprecated upstream and is absent from the
current audited SDK. Existing fine-tuned model management remains available.
The Python Search Toolkit is a separate local framework, not a Mistral REST
endpoint or a Discord command feature.

## Audited sources

- [Official REST operation source, pinned SDK revision](https://github.com/mistralai/client-ts/tree/139fc4023b04c3336bfed18a359936ae1ceab336/src/funcs)
- [Mistral API reference](https://docs.mistral.ai/api)
- [Large 4 model](https://docs.mistral.ai/models/mistral-large)
- [Responses API](https://docs.mistral.ai/studio/conversations/responses)
- [Agent tools and endpoint compatibility](https://docs.mistral.ai/studio/agents/agent-tools)
- [OCR request fields](https://docs.mistral.ai/api/endpoint/ocr)
- [Audio model families](https://docs.mistral.ai/studio/audio/overview)
- [Files API](https://docs.mistral.ai/api/endpoint/files)
- [Deprecated fine-tuning API](https://docs.mistral.ai/resources/deprecated/customization)
- [Billing and HTTP 402](https://docs.mistral.ai/admin/billing-usage/billing)

The audit and offline mocked tests were performed on 2026-10-29. No paid API
prompts were needed for these tests. API access and live behavior require valid
service configuration; unit tests do not establish model entitlement.
