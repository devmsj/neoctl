# Architecture Map

This map translates the parent README into source modules without implementing every detailed chapter behavior yet.

| README concept | Module boundary |
| --- | --- |
| Message model | `src/types/messages.ts` |
| Tool interface and metadata | `src/tools/tool.ts` |
| Tool schema validation | `src/tools/schema.ts` |
| Tool pool assembly | `src/tools/registry.ts` |
| Single tool execution pipeline | `src/tools/run-tool-use.ts` |
| Batch tool orchestration | `src/tools/tool-orchestration.ts` |
| Streaming tool execution | `src/tools/streaming-tool-executor.ts` |
| Tool system smoke test | `src/tools/smoke-tool-system.ts` |
| Main query loop | `src/core/query.ts` |
| Loop state and terminal reasons | `src/core/state.ts` |
| Pre-model message pipeline | `src/core/message-pipeline.ts` |
| Query engine / headless entry | `src/core/query-engine.ts` |
| Core loop smoke test | `src/core/smoke-core-loop.ts` |
| System prompt sections and cache boundary | `src/context/prompts.ts` |
| Runtime user/system context | `src/context/context-manager.ts` |
| Snip/micro/auto/reactive compaction | `src/context/compaction.ts` |
| Context smoke test | `src/context/smoke-context.ts` |
| Agent definitions and fork rules | `src/agents/agent-definition.ts` |
| Sub-agent runner | `src/core/run-agent.ts` |
| AgentTool | `src/agents/agent-tool.ts` |
| Background task state | `src/agents/local-agent-task.ts`, `src/tasks/task-store.ts` |
| Task control tools | `src/tasks/task-tools.ts` |
| Agent/task smoke test | `src/agents/smoke-agents.ts` |
| SkillTool | `src/skills/skill-tool.ts` |
| Prompt and context assembly | `src/context/context-manager.ts`, `src/context/prompts.ts` |
| Compaction boundary | `src/context/compaction.ts` |
| Model gateway contract | `src/model/model-gateway.ts` |
| Provider config and factory | `src/model/config.ts`, `src/model/provider-factory.ts`, `src/model/env.ts` |
| Provider adapter contract | `src/model/provider-adapter.ts` |
| OpenAI provider facade | `src/model/openai-adapter.ts` |
| OpenAI compatibility export | `src/model/openai-responses-adapter.ts` |
| OpenAI Responses mapper | `src/model/openai-responses-mapper.ts` |
| OpenAI Chat fallback mapper | `src/model/openai-chat-mapper.ts` |
| OpenAI shared mappers | `src/model/openai-mappers.ts` |
| HTTP transport | `src/model/http-transport.ts` |
| SSE decoder | `src/model/sse-decoder.ts` |
| Retry runner | `src/model/retry-runner.ts` |
| Error normalization | `src/model/errors.ts` |
| Credential provider | `src/model/credentials.ts` |
| API smoke test | `src/model/smoke-openai.ts` |
| Optional safety layer | `src/safety/*` |
| REPL UI layer | `src/repl/*` |

Chapter 01 is implemented as a runnable multi-turn state machine. Chapter 02 is implemented as a lifecycle tool system with schema validation, permission hooks, result mapping, batching, and streaming execution. Chapter 03 has prompt section assembly, user/system context separation, tool-result budgeting, compact-boundary handling, deterministic snip/micro/auto compaction, and reactive compact retry. Chapter 04 has AgentTool, typed agent definitions, isolated runAgent reuse of the main query loop, sync and async agent paths, LocalAgentTask state, task control tools, named-agent SendMessage routing, and fork anti-recursion rules. Chapter 07 is organized around a provider-neutral gateway plus a small provider factory; provider-specific settings live in typed provider config and the OpenAI-compatible adapter keeps Responses and Chat mappings split by API surface.
