# Agent Scaffold Source

This directory is a TypeScript implementation scaffold for the parent README. Chapter 01 and Chapter 07 now have runnable paths; later chapters still expose stable module boundaries and placeholders.

## Shape

- `src/repl`: the UI layer. It owns terminal input, slash commands, and rendering streamed events.
- `src/core`: the multi-turn query loop, loop state, message pipeline, `QueryEngine`, and child-agent runner entry points.
- `src/model`: provider-neutral model gateway, OpenAI Responses/Chat-compatible adapter, HTTP transport, SSE decoder, retry, and normalized errors.
- `src/tools`: tool contracts, registry, execution pipeline, and streaming orchestration placeholders.
- `src/context`: prompt assembly, runtime context, and compaction policy boundaries.
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
- keeps max-output-token recovery and hook/compact continuation points explicit for later chapters

`npm run smoke:core` verifies the tool-call follow-up loop with a fake model and the built-in `echo` tool.

## OpenAI-compatible API

The REPL uses `NotConfiguredModelGateway` when `OPENAI_API_KEY` is absent. When the key is present, it uses `OpenAIResponsesAdapter`.

The project loads `.env` from the current working directory and lets it override stale process-level OpenAI variables, which is useful on developer machines with old global settings.

```bash
set OPENAI_API_KEY=your-api-key
set OPENAI_BASE_URL=https://api.openai.com
set OPENAI_MODEL=gpt-5.4-mini
set OPENAI_ENDPOINT=auto
npm run smoke:openai -- "Say pong"
npm run dev
```

`OPENAI_ENDPOINT=auto` tries `/v1/responses` first and falls back to `/v1/chat/completions` for OpenAI-compatible gateways that do not expose Responses API.
