# Agent Scaffold Source

This directory is a TypeScript engineering skeleton for the parent README. It focuses on module boundaries and contracts before implementing each detailed chapter.

## Shape

- `src/repl`: the UI layer. It owns terminal input, slash commands, and rendering streamed events.
- `src/core`: the query loop, query state, `QueryEngine`, and child-agent runner entry points.
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
npm start
```

## OpenAI-compatible API

The REPL uses `NotConfiguredModelGateway` when `OPENAI_API_KEY` is absent. When the key is present, it uses `OpenAIResponsesAdapter`.

```bash
set OPENAI_API_KEY=your-api-key
set OPENAI_BASE_URL=https://api.openai.com
set OPENAI_MODEL=gpt-5.4-mini
set OPENAI_ENDPOINT=auto
npm run smoke:openai -- "Say pong"
npm run dev
```

`OPENAI_ENDPOINT=auto` tries `/v1/responses` first and falls back to `/v1/chat/completions` for OpenAI-compatible gateways that do not expose Responses API.
