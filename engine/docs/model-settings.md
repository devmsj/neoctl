# Model settings

The Web **模型** page configures one active composition with three independent bindings:

- Main model: OpenAI-compatible Responses or Anthropic-compatible Messages.
- Image generation: OpenAI-compatible Images; independent of the main model protocol.
- Search: OpenAI Responses with an optional Exa MCP fallback. The model explicitly calls Exa after unavailable/incomplete OpenAI search; this is not automatic server-side retry.

API connections are named archives. Saving an archive does not change an applied connection snapshot. **应用** publishes the composition and copies its referenced connections. An in-flight API request and its tool batch keep their snapshot; the next model-turn boundary picks up the published configuration. Idle Web snapshots refresh the active configuration as well. Existing environment configuration remains in use until the first explicit application.

## Persistent files

Both files live in `~/.neoctl`, independently of the installation and Web workspace locations:

- `model-settings.json`: API connection archives, composition and applied snapshot.
- `model-metadata.json`: editable model IDs/aliases, limits and capabilities.

API keys are stored in the settings file. An empty key in the edit dialog preserves the existing key. API responses expose `hasKey`, not the stored key.

Package installation initializes metadata when the compiled module is available. Runtime startup also initializes it for portable/source distributions. Initialization preserves existing entries, adds missing bundled IDs and naturally sorts IDs. Existing user aliases take precedence over aliases introduced by a new bundled entry. Metadata saves use optimistic concurrency and are read on subsequent capability/limit lookups without restarting.

`NEO_MODEL_CONFIG_DIR` overrides the configuration location for tests/embedders. Ordinary installations should leave it unset. Tests must use temporary directories rather than changing the user's configuration.

## Detection

Detection uses independent test messages, not the current conversation. Main detection checks streaming, a tool call and its continuation. Image-input detection checks that an image request returns a complete reply. Search requires real source URLs; OpenAI search additionally requires a `web_search_call` record. Selecting image generation runs one image request and removes its temporary generated files afterward. Detection can consume upstream quota and cannot guarantee future account availability or all provider-specific behavior.

Metadata is a capability declaration, not proof that an endpoint implements it. Unknown models can be added from the model library. Reasoning starts at `high`; unsupported values require an explicit selection. Non-reasoning models omit reasoning parameters. Explicitly text-only models cannot accept attached images and do not receive `image_inspect`.

The isolated Web host restricts global model settings to administrators. No changes to telemetry, account login, or provider risk-control behavior are included.


## 协议、档位与生效边界

- API 存档可用 `protocols: ["openai", "anthropic"]` 声明双协议；旧 `kind` 保留为迁移默认。编排的 `main.protocol` 明确选择 `responses` 或 `messages`，图片与 OpenAI 搜索只使用 OpenAI 接口。
- 模型元数据的 `protocols` 与供应商独立。未设置时仅按旧供应商分类迁移；之后以显式兼容接口为准。会话列表按本会话当前生效协议过滤。
- `reasoningEfforts` 为可编辑列表，不限定七个预设值；每项是 1–64 位接口标识（字母、数字、点、连字符、下划线），`off/default` 为保留控制值。自定义档位不代表上游一定支持，使用检测验证。旧版 Claude 的 token-budget 推理仍只能使用可映射档位，不编造预算。
- 保存 API 存档不自动应用。应用方案和保存元数据会通知本服务已加载的会话：空闲立即更新，运行中保持当前请求与工具批次，在下一轮模型调用前更新。切换连接清除旧 response ID；子任务有独立边界。独立 CLI 进程在下一轮读取文件。
- 当前使用档位被删除时不静默降档；下一请求提示重新选择。新请求按最新元数据校验，已发出的请求不改写。
- 隔离部署仅超管可读写全局模型配置；通知覆盖本服务全部用户的运行时，不广播 Key。普通用户只能选择当前连接允许的模型/档位。
- 返回 `activation.deferred` 决定“已生效”或“正在运行中的会话下一轮 API 调用时生效”；只保存连接则仅提示“已保存”。运行计数限当前服务进程，不声称跨独立 CLI 进程统计。
