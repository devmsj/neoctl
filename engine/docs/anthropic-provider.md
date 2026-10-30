# Native Claude / Anthropic provider

`MODEL_PROVIDER=anthropic` uses the native Messages API (`POST /v1/messages`), not OpenAI protocol conversion or a Claude Code subprocess. OpenAI remains a separate provider.

## CPA configuration

Complete upstream authentication in CPA itself. Configure neo with **CPA's client API key**, not the management password, Anthropic OAuth access/refresh token, authorization code, or browser cookie.

```dotenv
MODEL_PROVIDER=anthropic
ANTHROPIC_API_KEY=your-cpa-client-api-key
ANTHROPIC_BASE_URL=https://your-cpa-host
ANTHROPIC_MODEL=claude-sonnet-4-6
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
- Leaving thinking unset respects the selected model's default. Some newer Claude models always think and reject `off`/`none`. Legacy budget levels map to 1024/2048/4096 tokens for low/medium/high, capped below the request's output budget; explicit budgets are validated, not silently changed.
- Model IDs and actual availability must match the CPA deployment. Unknown custom aliases can chat with default reasoning, but model-specific reasoning support cannot be inferred reliably from arbitrary aliases.
- Existing assistant prefill is not supported across modern Claude models; native requests must end in a user turn (including tool results).
- No new redaction, path hiding, telemetry changes, OAuth UI or image-generation implementation was added.

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
