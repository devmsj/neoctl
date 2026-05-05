# Architecture Map

This map translates the parent README into source modules without implementing every detailed chapter behavior yet.

| README concept | Module boundary |
| --- | --- |
| Message model | `src/types/messages.ts` |
| Tool interface and metadata | `src/tools/tool.ts` |
| Tool pool assembly | `src/tools/registry.ts` |
| Single tool execution pipeline | `src/tools/run-tool-use.ts` |
| Streaming tool execution | `src/tools/streaming-tool-executor.ts` |
| Main query loop | `src/core/query.ts` |
| Query engine / headless entry | `src/core/query-engine.ts` |
| Sub-agent runner | `src/core/run-agent.ts` |
| AgentTool | `src/agents/agent-tool.ts` |
| Background task state | `src/agents/local-agent-task.ts`, `src/tasks/task-store.ts` |
| Task control tools | `src/tasks/task-tools.ts` |
| Prompt and context assembly | `src/context/context-manager.ts`, `src/context/prompts.ts` |
| Compaction boundary | `src/context/compaction.ts` |
| Model gateway | `src/model/model-gateway.ts`, `src/model/env.ts` |
| OpenAI provider adapter | `src/model/openai-responses-adapter.ts` |
| HTTP transport | `src/model/http-transport.ts` |
| SSE decoder | `src/model/sse-decoder.ts` |
| Retry runner | `src/model/retry-runner.ts` |
| Error normalization | `src/model/errors.ts` |
| Credential provider | `src/model/credentials.ts` |
| API smoke test | `src/model/smoke-openai.ts` |
| SkillTool | `src/skills/skill-tool.ts` |
| Optional safety layer | `src/safety/*` |
| REPL UI layer | `src/repl/*` |

The API layer now supports OpenAI Responses first and an OpenAI-compatible Chat Completions fallback for gateways that do not expose `/v1/responses`.
