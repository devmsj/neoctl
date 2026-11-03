# Native Claude / Anthropic provider

`MODEL_PROVIDER=anthropic` uses the native Messages API (`POST /v1/messages`), not OpenAI protocol conversion or a Claude Code subprocess. OpenAI remains a separate provider.

## CPA configuration

Complete upstream authentication in CPA itself. Configure neo with **CPA's client API key**, not the management password, Anthropic OAuth access/refresh token, authorization code, or browser cookie.

```dotenv
MODEL_PROVIDER=anthropic
ANTHROPIC_API_KEY=your-cpa-client-api-key
ANTHROPIC_BASE_URL=https://your-cpa-host
ANTHROPIC_MODEL=claude-haiku-5-5
# Optional; stable Messages protocol version used by default:
ANTHROPIC_API_VERSION=2023-06-01
# Optional. Leave effort unset to use the model's default behavior.
# MODEL_REASONING_EFFORT=high
# MODEL_MAX_OUTPUT_TOKENS=8192
# MODEL_TIMEOUT_MS=120000
# MODEL_STREAM_IDLE_TIMEOUT_MS=120000
# MODEL_MAX_RETRIES=2
# Legacy models only; must be >=1024 and less than output token limit:
# ANTHROPIC_THINKING_BUDGET_TOKENS=2048
```

Base URL accepts an origin, a prefix ending in `/v1`, or the full `/v1/messages` URL; it does not append a duplicate `/v1`. Local CPA commonly uses `http://127.0.0.1:8317`, but use your actual deployment address. For official API keys, use `https://api.anthropic.com`.

Web and REPL `/login` expose `anthropic`, its credentials, base URL, model and common runtime settings. Protocol version and legacy thinking budget remain environment-only overrides; existing values are preserved when saving the form. Existing OpenAI settings are retained when switching. The shared model list includes Claude entries based on the CPA snapshot below; this list is not a guarantee of account access. A custom model ID can be entered in login. If the gateway applies different context limits, set `MODEL_CONTEXT_WINDOW_TOKENS` explicitly.

## Supported behavior

- Text, multi-turn history and system instructions.
- Client tools, parallel tool calls, tool failures and subsequent results.
- SSE streaming, fragmented UTF-8 / JSON, ping events and cumulative usage.
- Non-streaming responses; cancellation and idle timeout; transient retries before output only.
- Image **input** in the existing neo image pipeline. No Claude image generation implementation or tool registration.
- Legacy thinking budgets and adaptive thinking for recognized model families.
- Preservation of signed thinking and provider-opaque blocks in Claude-specific message metadata for tool continuation and session resume. This is protocol state, not new client telemetry or content redaction. Existing generic thinking filtering and OpenAI mapping are unchanged.
- Model-driven context compaction and subagent invocation through the shared gateway.
- JSON schema output for models/servers supporting `output_config.format`.

## Explicit boundaries

- OAuth login, refresh and upstream policy are CPA's responsibility. neo does not impersonate Claude Code, fabricate signatures or implement subscription authentication. Successful protocol integration does not establish permission for a particular upstream credential source.
- No arbitrary OpenAI request fields are forwarded. `previous_response_id` is not sent; Claude history is explicit.
- `reasoning.summary`, `json_object`, unsupported effort levels, forced tool choice with thinking, and OpenAI-specific `priority`/`flex`/`fast` tiers are rejected locally. Disable neo's Fast mode for this provider; do not assume OpenAI priority means Claude fast mode.
- Leaving effort unset preserves the model's default effort. Recognized Claude 5 families use adaptive thinking by default; neo explicitly requests `thinking.display="summarized"` for adaptive thinking so compatible servers return a readable summary rather than only a signature. Explicit `none`/disabled thinking stays disabled on models that support it. Some newer Claude models always think and reject `off`/`none`. Legacy budget levels map to 1024/2048/4096 tokens for low/medium/high, capped below the request's output budget; explicit budgets are validated, not silently changed.
- Native text blocks and text deltas are marked as provider-confirmed visible output, allowing session-title and subagent result extraction. Thinking/signatures are never promoted to final text. Signature-only thinking is retained for replay, but empty deltas and blank history cards are not displayed. Missing historical summaries cannot be reconstructed from signatures.
- Model IDs and actual availability must match the CPA deployment. Unknown custom aliases require a verified mid-conversation system capability override for query-loop use; model-specific reasoning support cannot be inferred reliably from arbitrary aliases.
- Existing assistant prefill is not supported across modern Claude models; requests end in a user turn (including tool results), optionally followed by a supported mid-conversation system message.
- No new redaction, path hiding, telemetry changes, OAuth UI or image-generation implementation was added.

## Visible thinking lifecycle (all providers)

- Anthropic adaptive thinking requests `display: "summarized"`. OpenAI Responses requests `reasoning.summary: "auto"` for reasoning-capable models unless reasoning is disabled or the caller selected another summary mode. Chat-compatible `reasoning_content` / `reasoning` fields are displayed when supplied. None of these options exposes encrypted or signature-only content; visible summaries remain provider-dependent.
- Stream adapters normalize provider boundaries to `thinking_done`; the query loop publishes `thinking.done` before answer text or tool generation. The shared lifecycle guard also closes thinking on EOF, errors, retries, incomplete responses and cancellation (including providers that ignore abort).
- Responses summaries supplied only in done/output-item/completion frames are recovered, without duplicating streamed prefixes. The Web bridge immediately sends the stopped row/status via SSE, retaining readable text; completed/pinned previews cannot keep the execution icon pulsing.
- Session titles use an isolated, tool-free title prompt rather than inheriting a general worker's report instructions. Only provider-confirmed visible output can become a title.

## Runtime context and time (2026-11-03)

- Each query turn, including tool continuation and title generation, appends one `system` message: `Current time: YYYY-MM-DDTHH:mm:ssZ`. Compaction requests also receive the current time. No duration advice or extra clock instructions are added.
- Runtime time and context changes are persisted as hidden metadata messages. Completed history is replayed verbatim; changing the clock does not rewrite the stable prompt, old timestamps, or completed request prefixes. Platform/session facts use a separate system message; cwd changes append only when changed. User-authored project/workspace documents remain user-level context. The deprecated `UserContext.currentDate` and `DefaultContextManagerOptions.currentDate` fields are accepted for source compatibility but no longer injected.
- Responses maps internal system messages to historical `developer`; Chat maps them to historical `system`. Claude uses native `messages[].role="system"` on documented supporting families (including Haiku/Sonnet/Opus 5.5, Opus 4.8/5 and Fable/Mythos 5/5.1). Text system messages require no beta header. Unsupported models fail explicitly rather than masquerading as user/tool results or moving dynamic time to the top-level prefix. Embedded integrations can set `AnthropicAdapterOptions.midConversationSystem` for a verified custom alias.
- Claude validates system placement after a complete user/tool-result turn, before the next assistant turn or request end. An interrupted runtime tail with no assistant output can be carried past subsequently queued user input; earlier completed turns remain unchanged. Compaction checkpoints retain their existing top-level treatment.
- Runtime time injection adds no cache-control fields or breakpoints. It only preserves existing request prefixes; actual cache policy and hits remain provider-managed.
- Continuation/recovery hints are concise English and remain system-origin instructions. User text and project documents are not translated.

Source: https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages

## Cross-check sources (2026-10-30)

Official documentation:

- https://platform.claude.com/docs/en/api/messages/create
- https://platform.claude.com/docs/en/build-with-claude/streaming
- https://platform.claude.com/docs/en/build-with-claude/thinking
- https://platform.claude.com/docs/en/build-with-claude/extended-thinking
- https://platform.claude.com/docs/en/build-with-claude/effort

CPA source snapshot: `router-for-me/CLIProxyAPI`, commit `90c447d3a8727d115aa7552ec93ce023736ed492`.

- `internal/api/server_routes.go`: `/v1/messages` and `/v1/messages/count_tokens` registration.
- `internal/access/config_access/provider.go`: client `x-api-key` authentication.
- `sdk/api/handlers/claude/code_handlers.go`: native body dispatch, streaming/non-streaming behavior and incomplete stream handling.
- `internal/registry/models/models.json`: model IDs, limits and effort capabilities (deployment-dependent).

## Validation

Run from `engine`:

```sh
node --import tsx --test tests/model/anthropic-provider.test.ts
npm test
npm run typecheck
```

Tests use synthetic data, local HTTP servers and the real neo query/tool/session code. The local server follows the verified CPA client-side contract; it is **not a running CPA instance or a live Anthropic service**. No upstream key is needed. Live testing through the actual CPA endpoint remains required before claiming production acceptance, including available model IDs and upstream signed-thinking handling.
