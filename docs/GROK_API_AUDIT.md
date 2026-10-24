# Grok API coverage audit

Reviewed **October 21, 2026**, against the official [developer documentation index](https://docs.x.ai/llms.txt) and Owaua's current source. This is a capability-family checklist, not a claim that every API parameter, account entitlement, or Grok product feature is implemented.

**Implemented** means there is a reachable source path. **Partial** means useful support exists with specified gaps. **Remaining** means a separate integration is needed. These labels do not establish a production deployment, account access, or successful paid inference. The expanded implementation is checked with syntax validation, mocked provider tests and an actual local Opus/chart rendering check. No paid prompts or voice/media generation tests are sent. Deployment readiness and live paid feature behavior are separate facts.

## What Owaua can use now

Owaua already combines Grok 4.7 text and image understanding, live web/X research, hosted Python, custom local tools, isolated local memory, and image/video generation. The expansion adds native document inputs, reasoning/search controls, richer media options, video editing/extension, cache hints, native voice, saved knowledge, MCP integrations, downloadable analysis and structured JSON. Multi-agent research is explicitly excluded by the user. Defaults preserve one medium-quality 1k image or one six-second 720p lite video unless a user chooses supported settings.

Examples of reachable requests:

- `/ask prompt:Compare these reports file:<PDF>`; ordinary messages can attach several supported documents.
- `/ask prompt:Find recent announcements reasoning:high web_domains:docs.x.ai x_handles:xai from_date:2026-10-01 to_date:2026-10-22 visual_search:true`.
- Attach images and ask to combine or edit them; ask for three 2k images in a chosen aspect ratio.
- Attach one image and ask to animate it; attach several and request a reference-guided video.
- Attach an MP4 and ask to change the scene or extend the action. This supplies an editing reference; it does not enable general MP4 understanding.

The model chooses tools, so examples express intended behavior rather than guaranteeing a particular tool is selected. Paid live behavior remains unverified.

## Text, reasoning, and conversation

| Public capability | Current coverage and useful next step | Official reference |
|---|---|---|
| Text generation, instructions, multimodal messages | **Implemented:** Responses REST, configurable model, persona, text/image/document inputs and bounded visible output. `max_output_tokens` excludes reasoning, so it is not a total spending cap. Grok 4.7 is the default. | [Text](https://docs.x.ai/developers/model-capabilities/text/generate-text) |
| Streaming | **Partial:** SSE reports actual web/X activity to the loading indicator; final text is delivered when complete. Incremental answer rendering and reasoning-summary UI remain. | [Streaming](https://docs.x.ai/developers/model-capabilities/text/streaming) |
| Reasoning effort and summaries | **Partial:** `/ask reasoning` validates low/medium/high/xhigh against the configured model. Text reasoning cannot be disabled; xhigh requires 4.6+. Summarized reasoning is not displayed. | [Reasoning](https://docs.x.ai/developers/model-capabilities/text/reasoning) |
| Encrypted reasoning and tool state | **Partial:** output items are replayed inside custom-tool continuation. Across separate Discord requests only bounded text history is retained; persistent encrypted-state replay is absent. | [State and encrypted thinking](https://docs.x.ai/developers/model-capabilities/text/generate-text) |
| Stored Responses lifecycle | **Intentional alternative:** requests use `store:false`; no remote response retrieval/deletion or `previous_response_id` conversation store. Provider defaults otherwise retain Responses for 30 days. | [Responses reference](https://docs.x.ai/developers/rest-api-reference/inference/responses) |
| JSON mode / schema-constrained output | **Implemented:** `/ask output:json` with a default answer/sources schema or a bounded custom object schema. Strict provider formatting plus local parsing/schema validation; invalid or incomplete output fails without a paid retry. JSON is delivered intact as a file. | [Structured outputs](https://docs.x.ai/developers/model-capabilities/text/structured-outputs) |
| Realtime multi-agent research | **Excluded by request:** `grok-4.20-multi-agent`, four or sixteen agents. Responses only; no client-side/custom functions or `max_tokens`. Separate research routing is needed because Owaua's ordinary tools are incompatible. All agents' tokens/tools are billed. | [Multi-agent](https://docs.x.ai/developers/model-capabilities/text/multi-agent) |

## Research and tools

| Public capability | Current coverage and useful next step | Official reference |
|---|---|---|
| Web search and page browsing | **Implemented:** hosted `web_search`, source links and optional allowlist of up to five domains. Excluded domains and location hints remain unexposed. | [Web](https://docs.x.ai/developers/tools/web-search) |
| Web image search / image inspection | **Implemented, opt-in:** visual search enables both image search and image understanding. These are separate capabilities. Returned remote images still depend on Discord rendering. | [Visual web search](https://docs.x.ai/developers/tools/web-search) |
| X keyword, semantic, user and thread search | **Implemented:** hosted `x_search`; up to twenty allowed handles and optional dates. Exclusion controls remain. The end date is exclusive, and handle/date filters do not constrain thread fetches. | [X search](https://docs.x.ai/developers/tools/x-search) |
| X image/video understanding | **Implemented, opt-in:** visual search enables media inspection for discovered X posts. This does not imply arbitrary attached-video understanding. | [X media](https://docs.x.ai/developers/tools/x-search) |
| Hosted Python | **Implemented:** calculations plus actual Python-generated file bytes through bounded stdout envelopes. CSV/text/code and PNG chart export tools provide additional delivery paths. Three files, 1 MiB each, 3 MiB combined. No invented sandbox download endpoints; export bytes are replaced by metadata before continuation. The sandbox has no external network. | [Code execution](https://docs.x.ai/developers/tools/code-execution) |
| Custom functions | **Implemented:** allowlisted time, scoped memory and media functions; argument validation and bounded rounds. Execution currently processes returned custom calls serially. Forced/required/none tool choice is not exposed. | [Function calling](https://docs.x.ai/developers/tools/function-calling) |
| Remote MCP | **Implemented:** `/integrations` and explicit `/ask integrations:` selection. Public xAI docs and DeepWiki work without extra credentials; both public tool catalogs were checked read-only. Deployment-owned servers require read-only tool allowlists; authenticated servers also require actor/guild restrictions and environment token references. No write tools or unsupported approval flags. | [MCP](https://docs.x.ai/developers/tools/remote-mcp) |
| Tool combinations, citations and usage | **Implemented/partial:** hosted tools and local functions share a loop; citations and raw usage are preserved. More detailed status, usage aggregation and cost controls remain. Request `max_turns` limits assistant turns, not individual calls; parallel calls can occur within a turn. Do not send response-only `max_tool_calls` as a request control. | [Advanced tools](https://docs.x.ai/developers/tools/advanced-usage), [Accounting](https://docs.x.ai/developers/tools/tool-usage-details) |

## Files, knowledge, and privacy

| Public capability | Current coverage and useful next step | Official reference |
|---|---|---|
| Native file attachments | **Implemented:** PDF and UTF-8 text/code through uploaded `input_file` IDs; four files, 20 MiB each, 40 MiB total. Supports mixed images/documents. Direct public `file_url` inputs remain unused. | [Chat with files](https://docs.x.ai/developers/model-capabilities/files/chat-with-files) |
| File lifecycle | **Implemented:** bounded Discord-only downloads, temporary uploads, cleanup after success/failure and a one-hour expiry backstop. No persistent ID reuse. Provider Files cap is 512 MB, above Owaua's deliberate limits. General file listing/admin is absent. | [Managing files](https://docs.x.ai/developers/files/managing-files) |
| Collections / persistent RAG | **Implemented:** private `/knowledge add/list/forget/clear`, durable Files library with up to 20 documents/40 MiB per scope, explicit `/ask library:true`. Native attachment search works with the existing inference key. Optional management credentials additionally enable per-scope Collections indexing and hosted `file_search`; indexing failures fall back to stored Files. Management credentials are not currently configured in production, so native Collections is not active there. | [Collections](https://docs.x.ai/developers/files/collections), [API](https://docs.x.ai/developers/files/collections/api), [Metadata](https://docs.x.ai/developers/files/collections/metadata) |
| Generated media in Files | **Remaining:** persist generated outputs, reference stored files as future Imagine inputs and apply explicit retention. | [Imagine Files integration](https://docs.x.ai/developers/model-capabilities/imagine/files) |
| Public CDN links | **Remaining:** revocable links, optional expiration, one active URL/file; eligible image/video/PDF types up to 50 MiB and 1,000 active links/team. | [Public URLs](https://docs.x.ai/developers/files/public-urls) |

Local SQLite history, full-text recall and user notes remain Owaua's memory system. They are scoped by server, channel and user. The document library is additional and explicitly opt-in; private messages are not automatically indexed. Saved documents stay at xAI until forgotten/cleared, with metadata in a separate private SQLite database. Metadata filters help scope retrieval but do not replace authorization. Current requests still transmit relevant prompts, recalled text and attachments to xAI. `store:false` controls Responses storage; it does not assert zero provider retention for every service. File IDs/URLs are not retained in text history, while the assistant's textual analysis can remain in conversation history.

## Imagine images and video

| Public capability | Current coverage and useful next step | Official reference |
|---|---|---|
| Text-to-image and variations | **Implemented:** `grok-imagine-image-2.0`; one to ten images, low/medium/auto quality, 1k/2k and documented ratios. Default medium is explicit because provider `auto` currently differs between generation and editing. | [Images](https://docs.x.ai/developers/model-capabilities/images/generation) |
| Single/multiple image editing | **Implemented:** up to five references, natural-language edits, reference-guided creation and replying to bot images. Single-image editing keeps its source aspect ratio; unsupported shape overrides fail before submission. Ten edited outputs is a bot cap, not a verified provider maximum. | [Editing](https://docs.x.ai/developers/model-capabilities/images/editing), [Multiple images](https://docs.x.ai/developers/model-capabilities/images/multi-image-editing), [REST schema](https://docs.x.ai/openapi.json) |
| Hosted conversational image tool | **Remaining alternative:** `image_generation` can chain generation/edits with research and returns base64 outputs. Owaua uses controlled application functions instead; it does not currently decode/deliver these hosted output items. | [Hosted image tool](https://docs.x.ai/developers/tools/image-generation) |
| Deferred/base64 images and webhooks | **Remaining:** resumable image jobs, binary handling and signed completion events would improve long-job recovery. Current images use synchronous URL output. | [Image generation](https://docs.x.ai/developers/model-capabilities/images/generation) |
| Text/image-to-video | **Implemented:** lite/standard/classic routing, supported duration/resolution/ratios, first-frame animation and polled completion. Standard has native 1080p; lite 1080p is upscaled; classic stops at 720p. | [Video overview](https://docs.x.ai/developers/model-capabilities/video/overview) |
| Reference-to-video | **Partial:** multiple image references supported within Owaua's five-image input cap. Provider standard supports more references; preset character voices, last frame and timestamped keyframes remain. Custom audio references are trusted-partner gated. | [Reference video](https://docs.x.ai/developers/model-capabilities/video/reference-to-video) |
| Video editing and extension | **Implemented:** classic model, MP4 source editing up to 8.7s; extension source 2–15s, adding 2–10s. Source aspect/resolution constraints apply. | [Editing](https://docs.x.ai/developers/model-capabilities/video/editing), [Extension](https://docs.x.ai/developers/model-capabilities/video/extension) |

Native video audio is a model capability, not a separate Owaua audio attachment or voice feature; explicit silent-video controls remain unexposed. Direct image uploads to signed storage (`output.upload_urls`) also remain unused. The REST schema lists 1.5k images while the narrative guide advertises 1k/2k; Owaua exposes the latter until model support is confirmed. Durable media downloads/job recovery remain valuable: temporary URLs and an accepted job do not guarantee Discord delivery. The old `grok-imagine-image-quality` slug retires November 2, 2026 and redirects to image 2.0 at low; Owaua already names 2.0 explicitly. [Image REST reference](https://docs.x.ai/developers/rest-api-reference/inference/images), [Retirement notice](https://docs.x.ai/developers/migration/imagine-image-quality-nov-2)

## Voice

Speech recognition, synthesis and native realtime voice are **implemented**. Music playback continues independently through SoundCloud. Realtime sessions listen only to the creator, use the current persona without local conversation history, end after ten minutes/two minutes idle, and cannot share a server connection with music.

| Family | Practical expansion and constraints | Official reference |
|---|---|---|
| Speech-to-text | **Implemented:** `/transcribe` plus audio attachments in chat and `/ask`; later captions/meeting summaries. Transcribe 2.0 supports Hungarian among 38+ languages, timestamps, diarization, multichannel, keyterms, REST uploads/URLs and streaming Smart Turn/VAD/Opus. | [STT](https://docs.x.ai/developers/model-capabilities/audio/speech-to-text) |
| Text-to-speech | **Implemented:** `/speak`, `/ask spoken:true`, voice listing and MP3/WAV downloads with voice/language selection, expression tags, speed, normalization, pronunciation/IPA replacements and character timing; unary or streaming output. | [TTS](https://docs.x.ai/developers/model-capabilities/audio/text-to-speech) |
| Realtime speech-to-speech | **Implemented:** `/voice join/leave/status` runs a native Discord voice session with interruption handling, Opus/PCM conversion and hosted web/X tools. Voice 3.0 supports reasoning controls, language/keyterm hints, scripted utterances, pronunciation, per-response instructions and reconnect context. Only creator audio is subscribed; same-channel owner controls, bounded sessions and shutdown cleanup are implemented. Live voice quality remains untested. | [Realtime voice](https://docs.x.ai/developers/model-capabilities/audio/speech-to-speech) |
| Custom voices | Existing eligible voice IDs can be selected; creation remains account/region gated. Currently US-only excluding Illinois; API creation Enterprise-gated. Thirty voices/team, reference maximum 120s. Do not advertise availability to this Budapest-based user without eligibility verification. | [Custom voices](https://docs.x.ai/developers/model-capabilities/audio/custom-voices) |
| Client credentials / telephony | Ephemeral browser/mobile voice credentials; optional BYO SIP calls, transfers, hangup and DTMF. These serve separate clients beyond Discord. | [Tokens](https://docs.x.ai/developers/model-capabilities/audio/ephemeral-tokens), [SIP](https://docs.x.ai/developers/model-capabilities/audio/speech-to-speech/sip) |

## Developer infrastructure and cost

| Family | Current coverage / decision | Official reference |
|---|---|---|
| Automatic prompt cache | **Partial:** caching may already happen automatically; Owaua now sends an opaque scoped `prompt_cache_key`. Stable prefix layout, routing headers and measured hit-rate optimization remain. `store:false` does not mean caching is disabled. | [Caching](https://docs.x.ai/developers/advanced-api-usage/prompt-caching) |
| Context compaction | **Remaining:** explicit `/v1/responses/compact` or SDK compaction can reduce long-conversation costs; compaction costs tokens and requires input still within context. The request schema's `context_management` is parsed but not executed, so it does not establish automatic compaction. Current local bounded history/retrieval remains. | [Compaction](https://docs.x.ai/developers/advanced-api-usage/context-compaction) |
| Responses WebSocket | **Remaining:** repeated agent turns can use one socket, latest-response in-memory state and warmup; supports `store:false`, serial turns and a 59-minute connection limit. | [WebSocket](https://docs.x.ai/developers/advanced-api-usage/websocket-mode) |
| Async, batch, deferred | **Remaining:** batch supports model-dependent offline text/media jobs with reduced pricing; ordinary asynchronous SDK calls are concurrency. Deferred chat is a separate older endpoint with single retrieval within 24h. Responses `background` is documented compatibility-only, not a proven background-job API. | [Async](https://docs.x.ai/developers/advanced-api-usage/async), [Batch](https://docs.x.ai/developers/advanced-api-usage/batch-api), [Deferred](https://docs.x.ai/developers/advanced-api-usage/deferred-chat-completions) |
| Cost and quota observability | **Partial:** text/media usage is logged, including returned cost ticks when present. Aggregate spend, budgets and X fetched-post/profile counters need dashboards/enforcement. One USD is 10^10 ticks; X searches bill fetched items. | [Cost](https://docs.x.ai/developers/cost-tracking), [Limits](https://docs.x.ai/developers/rate-limits) |
| Priority and regional routing | **Remaining, optional paid choices:** priority is a token-price premium; US regional inference currently supports only 4.7/4.6 at a 10% premium and excludes tools/Files/Collections from its residency guarantee. Media and voice APIs are unavailable there. | [Priority](https://docs.x.ai/developers/advanced-api-usage/priority-processing), [Regions](https://docs.x.ai/developers/advanced-api-usage/regions) |
| Management, billing, audit, webhooks | **Remaining operator tooling:** separate management credentials/host, ACLs, key limits, billing and audit logs. Never expose management credentials through ordinary model tools. | [Management](https://docs.x.ai/developers/management-api-guide), [Reference](https://docs.x.ai/developers/rest-api-reference/management) |
| Enterprise transport / integrations | **Remaining when needed:** mTLS requires enterprise enablement; Vertex/Foundry and SDKs are deployment alternatives. Docs MCP helps development rather than adding a bot feature. | [mTLS](https://docs.x.ai/developers/advanced-api-usage/mtls), [Platforms](https://docs.x.ai/developers/community) |

Model catalogs, tokenization and account metadata are operator capabilities, not user-facing features. OpenAPI also lists embedding/skills surfaces without matching current public product guides; existence in a schema does not prove account availability. Do not market them as integrated. Chat Completions and Anthropic compatibility are legacy migration surfaces; new work should use Responses. Grok app connectors, Grok Build hooks/subagents/worktrees, and Grok Bot computer control belong to separate products. [API catalog](https://docs.x.ai/llms.txt), [Legacy reference](https://docs.x.ai/developers/rest-api-reference/inference/legacy)

## Remaining work outside this release

- Incremental answer rendering, longer encrypted-state replay and measured cache optimization.
- Advanced media persistence/job recovery, silent output, character voices and pinned/keyframes.
- Optional operator APIs: budgets/usage dashboards, compaction, batch/deferred jobs, WebSocket text transport, priority/regional routing and enterprise transport.
- Account-gated custom voice creation and non-Discord clients/telephony need separate credentials, eligibility and product work.
- Multi-agent research is deliberately excluded, with no enabled routing or tools.

The optional native Collections path is implemented and mocked but needs a management key; the persistent Files library works with the existing inference key. Custom authenticated MCP services similarly need their own service credentials; the built-in public documentation integrations do not.

Source paths include `src/ai.js`, `src/request-options.js`, `src/artifacts.js`, `src/mcp.js`, `src/voice.js`, `src/voice-command.js`, `src/knowledge.js`, `src/knowledge-command.js`, `src/request-input.js`, `src/reply.js`, `src/bot.js`, and the existing media/memory modules. Recheck official model details and account entitlements for model-specific or gated options.
