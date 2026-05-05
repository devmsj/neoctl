# Agent Scaffold Source

This directory is a TypeScript implementation scaffold for the parent README. Chapters 01, 02, 03, and 07 now have runnable paths; later chapters still expose stable module boundaries and placeholders.

## Shape

- `src/repl`: the UI layer. It owns terminal input, slash commands, and rendering streamed events.
- `src/core`: the multi-turn query loop, loop state, message pipeline, `QueryEngine`, and child-agent runner entry points.
- `src/model`: provider-neutral model gateway/config/factory, provider adapters, OpenAI Responses/Chat mappers, HTTP transport, SSE decoder, retry, and normalized errors.
- `src/tools`: lifecycle tool contracts, registry, schema validation, execution pipeline, batch orchestration, and streaming executor.
- `src/context`: system prompt sections, runtime user/system context, and deterministic compaction policies.
- `src/agents`: `AgentTool`, local task lifecycle, and team-related contracts.
- `src/tasks`: background task store and task-control service contracts.
- `src/skills`: workflow-as-tool boundary.
- `src/safety`: optional permission, sandbox, and audit ports.
- `src/app`: app-state ports used by tools and runtime code.

## Commands

```bash
npm install
npm run typecheck
npm run build
npm run smoke:core
npm run smoke:tools
npm run smoke:context
npm run smoke:openai -- "Say pong"
npm run dev
```

## Core Loop

`src/core/query.ts` implements the Chapter 01 main path as a streaming state machine:

- prepares each turn from a single `QueryState`
- applies compact-boundary filtering and tool-result budgeting before model calls
- builds system/user context into the model request
- streams assistant deltas and messages to the UI
- collects `tool_use` events, executes tools, and feeds `tool_result` messages into the next model turn
- tracks `previousResponseId` for Responses API tool-result continuation
- emits terminal reasons such as `completed`, `max_turns`, `model_error`, and abort states
- keeps max-output-token recovery and reactive compact continuation points explicit

`npm run smoke:core` verifies the tool-call follow-up loop with a fake model and the built-in `echo` tool.

## Tool System

`src/tools` implements the Chapter 02 tool system contract:

- tools are lifecycle objects with identity, aliases, schemas, metadata, validators, execution, result mapping, progress rendering, and optional context modifiers
- `ToolRegistry` keeps built-in tools as a stable prompt-cache prefix, supports aliases, filters deferred tools, and merges external tools deterministically
- `runToolUse()` performs schema validation, custom validation, permission decision, progress emission, abort handling, result mapping, max-result truncation, new messages, and context modifier propagation
- `runTools()` partitions tool calls into concurrency-safe batches and serial batches, applying context modifiers in tool-use order
- `StreamingToolExecutor` can start tools as tool calls arrive and can synthesize discarded results on fallback/abort

`npm run smoke:tools` verifies aliases, schema/custom validation, unknown-tool errors, max result truncation, and concurrent batch execution.

## Context And Prompts

`src/context` implements the Chapter 03 prompt/context path:

- `prompts.ts` builds system prompt sections with `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__`, replacement priority, proactive agent append mode, and prefix splitting for cache-aware providers
- `DefaultContextManager` memoizes user context (`currentDate`, project memory files) and system context (`cwd`, platform, git branch/status/recent commit)
- `message-pipeline.ts` prepends user context as a user message, appends system context to the system prompt, respects compact boundaries, and budgets oversized tool results
- `DeterministicCompactor` provides snip, microcompact, autocompact, and reactive compact fallback without adding another model dependency
- `query.ts` persists compact-boundary messages into the event stream and retries once after provider `context_length` errors

`npm run smoke:context` verifies prompt boundary splitting, context injection, tool result budgeting, compaction, and prompt-too-long recovery.

## Model Providers

The REPL calls `createModelGatewayFromEnv()`, which loads `.env`, reads `MODEL_*` settings into a small discriminated provider config, and constructs a provider through `provider-factory.ts`. Provider-specific switches stay inside provider-owned config (`OpenAIProviderConfig.openai.endpoint` today), while `OPENAI_*` variables remain supported as compatibility aliases.

```bash
set MODEL_PROVIDER=openai
set MODEL_API_KEY=your-api-key
set MODEL_BASE_URL=https://api.openai.com
set MODEL_ID=gpt-5.5
set MODEL_REASONING_EFFORT=high
set MODEL_ENDPOINT=auto
npm run smoke:openai -- "Say pong"
npm run dev
```

The OpenAI adapter is split into a small provider facade plus mappers:

- `openai-adapter.ts`: endpoint selection, auth, transport, retry, and Responses-to-Chat fallback
- `openai-responses-mapper.ts`: `/v1/responses` request and event mapping
- `openai-chat-mapper.ts`: OpenAI-compatible `/v1/chat/completions` fallback mapping
- `openai-mappers.ts`: shared tool/message/usage helpers

`MODEL_ENDPOINT=auto` tries `/v1/responses` first and falls back to `/v1/chat/completions` for OpenAI-compatible gateways that do not expose Responses API.
