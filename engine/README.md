# Agent Scaffold Source

This directory is a TypeScript implementation scaffold for the parent README. Chapters 01, 02, 03, 04, 05-core, and 07 now have runnable paths; later chapters still expose stable module boundaries and placeholders.

## Shape

- `src/repl`: the UI layer. It owns terminal input, slash commands, system init events, and rendering streamed events.
- `src/core`: the multi-turn query loop, loop state, message pipeline, `QueryEngine`, and child-agent runner entry points.
- `src/model`: provider-neutral model gateway/config/factory, provider adapters, OpenAI Responses/Chat mappers, HTTP transport, SSE decoder, retry, and normalized errors.
- `src/tools`: lifecycle tool contracts, registry, schema validation, execution pipeline, batch orchestration, streaming executor, and built-in tools.
- `src/context`: system prompt sections, runtime user/system context, deterministic compaction helpers, and model-driven compaction.
- `src/session`: JSONL session transcripts, tool-result persistence, latest/specific session resume, and session listing.
- `src/agents`: agent definitions, `AgentTool`, prompt rules, fork constraints, local task lifecycle, and agent smoke coverage.
- `src/tasks`: background task store, task-control tools, named-agent message routing, and persisted task output files.
- `src/skills`: inline workflow-as-tool injection and fork-skill boundary.
- `src/safety`: optional permission, sandbox, and audit ports.
- `src/app`: app-state ports used by tools and runtime code.
- `vendor/ripgrep`: per-platform bundled `rg` binaries installed by `npm run vendor:rg` or optional `postinstall`.

## Commands

```bash
npm install
npm run vendor:rg
npm run typecheck
npm run build
npm run smoke:core
npm run smoke:tools
npm run smoke:context
npm run smoke:agents
npm run smoke:skills
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
- `grepTool` calls the bundled ripgrep binary through `ripgrep-binary.ts`, supports smart/sensitive/insensitive case modes, glob filters, hidden-file opt-in, bounded context lines, and bounded total results
- `searchTool` performs web search through a pluggable `SearchProvider`; the initial backend is Exa MCP, with provider factory seams for future Bing/Tavily/custom implementations
- `scripts/install-ripgrep.cjs` resolves the current OS/CPU, downloads the matching official ripgrep release asset, extracts `rg`, and writes a manifest beside the binary; runtime lookup does not depend on PATH

`npm run smoke:tools` verifies aliases, schema/custom validation, unknown-tool errors, max result truncation, bundled-rg grep, pluggable web search, and concurrent batch execution.

## Context And Prompts

`src/context` implements the Chapter 03 and Chapter 05 prompt/context path:

- `prompts.ts` builds system prompt sections with `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__`, replacement priority, proactive agent append mode, and prefix splitting for cache-aware providers
- `DefaultContextManager` memoizes user context (`currentDate`, project memory files) and system context (`cwd`, platform, git branch/status/recent commit)
- `message-pipeline.ts` prepends user context as a user message, appends system context to the system prompt, respects compact boundaries, and budgets oversized tool results
- `ModelDrivenCompactor` uses the configured model gateway for autocompact and reactive compact summaries
- deterministic snip, microcompact, and summary fallback remain available when model summarization fails or when tests need predictable output
- `query.ts` persists compact-boundary messages into the event stream and retries once after provider `context_length` errors

`npm run smoke:context` verifies prompt boundary splitting, context injection, tool result budgeting, deterministic compaction, model-driven autocompact, and prompt-too-long recovery.

## Session Resume

The REPL writes JSONL transcripts under `.agent/sessions` by default. After each user message, a background title subagent check is scheduled after 5s: it creates one initial title, then performs one later refinement with the conversation and previous title if the prior title agent has finished. `/sessions [page_size]` opens an interactive browser (default 10 per page): use ↑/↓ to select a session, ←/→ to switch pages when more than one page exists, Enter to resume the selected session, and Esc to close. Use `/resume [session_id]` to replace the current in-memory history with a saved transcript. `/resume` without an id resumes the newest session for the current agent.

Startup resume is available with environment variables:

```bash
set AGENT_SESSION_RESUME=1
npm run dev

set AGENT_SESSION_ID=<session_id>
set AGENT_SESSION_RESUME=1
npm run dev
```

Set `AGENT_SESSION_TRANSCRIPT=0` to disable transcript persistence, or `AGENT_SESSION_DIR=<absolute-or-relative-dir>` to store transcripts elsewhere. `/reset` clears the active history and records a reset marker so future resumes start after the reset.

`npm run smoke:session` verifies transcript recording, latest-session lookup, specific-session resume, tool-result output persistence, and reset markers.

## Subagents And Tasks

`src/agents` and `src/tasks` implement the Chapter 04 core path:

- `AgentTool` is a normal tool with `prompt`, `description`, `subagent_type`, `model`, `run_in_background`, `name`, `team_name`, `mode`, `isolation`, and `cwd` inputs
- `AgentTool` now exports prompt rules covering fresh/fork/background/parallel/prompt-quality behavior
- `runAgent()` creates isolated child messages/context/tool pools and reuses the same `query()` loop
- `AgentDefinition` supports tool allow/deny lists, model, effort, permission mode, background, max turns, memory, isolation, and custom system prompts
- sync agents return a completed structured result; background/fork agents register `LocalAgentTask` and return `async_launched`
- `TaskOutput`, `TaskList`, `TaskGet`, `TaskStop`, and `SendMessage` provide the minimum control surface for background agents
- completed background tasks write `.agent-tasks/<task_id>.txt`; the directory is gitignored
- fork children get explicit anti-recursion and scope boilerplate; teammate/team inputs are represented as named background agents for now

`npm run smoke:agents` verifies sync delegation, async launch, task output, output-file persistence, task listing, and named-agent message routing.

## Skills

`src/skills` implements the low-risk part of Chapter 05 SkillTool:

- `SkillTool` validates skill existence and model invocation eligibility
- inline skills inject a meta user message into the next model turn through `newMessages`
- inline skills can update main loop model and effort through `contextModifier`
- fork skills are recognized and return a structured `fork_required` result instead of silently pretending to run

`npm run smoke:skills` verifies inline injection, context modification, fork-skill rejection, and unknown-skill validation.

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
