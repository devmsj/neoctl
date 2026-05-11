# neoctl / neo

neoctl 是一个用 TypeScript 编写的本地 AI 工程代理运行时。项目提供 `neo` 命令行 REPL，也导出核心运行时模块，围绕流式模型调用、工具执行、上下文管理、会话恢复和子代理任务编排构建。

## 特性亮点

- **流式多轮 Agent Loop**：模型输出、thinking、工具调用、工具结果和终止状态都通过统一事件流传递。
- **OpenAI 兼容模型网关**：支持 `/v1/responses` 与 `/v1/chat/completions`，`OPENAI_ENDPOINT=auto` 时会优先尝试 Responses API，并在兼容网关不支持时回退到 Chat Completions。
- **内置工程工具集**：文件读写、文本替换、命令执行、目录列表、ripgrep 搜索、Web 搜索、计划展示、子代理和后台任务控制。
- **上下文预算与压缩**：在每次模型调用前注入用户/系统上下文、估算上下文占用、预算大型工具结果，并支持自动、手动和错误恢复压缩。
- **会话持久化与恢复**：默认记录 JSONL transcript，大型工具结果落盘保存，支持最近/指定会话恢复和交互式会话浏览。
- **子代理与后台任务**：同一套 query loop 可运行同步子代理、后台子代理、fork 子代理，以及后台 shell 任务。
- **TTY REPL 体验**：Ink UI、slash command 补全、Markdown 渲染、流式状态栏、token 使用统计、剪贴板文本/图片粘贴、会话标题和终端标题更新。

## 快速开始

要求 Node.js >= 20。

```bash
npm install
npm run build
npm start
```

开发模式：

```bash
npm run dev
```

构建当前平台的便携可执行分发目录：

```bash
npm run standalone
```

产物输出到 `standalone/<platform>-<arch>/`，例如 Windows x64 为 `standalone/win32-x64/neo.exe`。该目录内包含内嵌 Node.js 的启动器、`dist/`、`node_modules/` 和当前平台的 `vendor/ripgrep/`，目标机器无需预装 Node.js；分发时请压缩并保留整个目录结构，不要只复制单个 `neo.exe`。

推送 `v*` tag 或手动触发 GitHub Actions 的 `Build standalone executables` workflow，会分别生成：

- `neo-win32-x64.zip`
- `neo-linux-x64.tar.gz`
- `neo-darwin-x64.tar.gz`
- `neo-darwin-arm64.tar.gz`

首次启动会创建用户级配置文件：

- Windows：`%APPDATA%\neo\.env`
- macOS/Linux：`~/.config/neo/.env`

可以运行 `/login` 交互式填写并保存，也可以手动编辑。推荐格式是：`MODEL_PROVIDER` 只选择当前供应者；供应者专属的 key、base URL、model 分别写在 `OPENAI_*` / `DEEPSEEK_*` / `KIMI_*` 下；跨供应者共用的运行参数保留 `MODEL_*`。

```env
# Active provider
MODEL_PROVIDER=openai

# OpenAI provider settings
OPENAI_API_KEY=your-openai-api-key
OPENAI_BASE_URL=https://api.openai.com
OPENAI_MODEL=gpt-5.5
OPENAI_FALLBACK_MODEL=
OPENAI_ENDPOINT=auto

# DeepSeek provider settings
DEEPSEEK_API_KEY=your-deepseek-api-key
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-chat
DEEPSEEK_FALLBACK_MODEL=

# Kimi provider settings
KIMI_API_KEY=your-kimi-api-key
KIMI_BASE_URL=https://api.moonshot.cn/v1
KIMI_MODEL=kimi-k2.6
KIMI_FALLBACK_MODEL=
# 如果 key 来自国际站 platform.kimi.ai，请改为：
# KIMI_BASE_URL=https://api.moonshot.ai/v1

# Shared model runtime settings
MODEL_REASONING_EFFORT=high
MODEL_REASONING_SUMMARY=auto
MODEL_MAX_OUTPUT_TOKENS=800
MODEL_TIMEOUT_MS=120000
MODEL_STREAM_IDLE_TIMEOUT_MS=120000
MODEL_MAX_RETRIES=2
```

也可以在当前工作目录放 `.env`，或通过 `NEO_ENV_FILE=/path/to/.env` 指定配置文件。加载顺序是：当前目录 `.env` → 用户级 `.env` → `NEO_ENV_FILE`，后者优先级最高。

## 常用命令

```bash
npm run typecheck       # TypeScript 类型检查
npm run build           # 编译到 dist，并复制模型元数据
npm run vendor:rg       # 下载/安装当前平台的 ripgrep 到 vendor/ripgrep
npm run standalone      # 构建当前平台的便携可执行分发目录
npm run standalone:clean # 清理 standalone 构建产物
npm run smoke:core      # 核心 query loop 冒烟测试
npm run smoke:tools     # 工具体系冒烟测试
npm run smoke:context   # 上下文和压缩冒烟测试
npm run smoke:session   # 会话持久化冒烟测试
npm run smoke:agents    # 子代理/任务冒烟测试
npm run smoke:skills    # skill 模块冒烟测试
npm run smoke:responses # OpenAI Responses mapper 冒烟测试
npm run smoke:deepseek # DeepSeek Chat mapper 冒烟测试
npm run smoke:openai -- "Say pong"
```

`postinstall` 会以 optional 模式尝试安装 ripgrep；如果失败或需要重装，可手动运行 `npm run vendor:rg`。

## REPL 用法

启动后直接输入自然语言任务即可。命令行参数也可用 `-`/`--` 形式调用同名 REPL slash command：

```bash
neo -help
neo -web
neo -web --port 3001
neo -model
neo -model gpt-5.5 high
neo -new
```

`neo -web` / `neo --web` 会启动本地浏览器 UI，默认监听 `127.0.0.1:3000`，可通过 `--host`、`--port` 参数或 `NEO_WEB_HOST`、`NEO_WEB_PORT` 环境变量调整。

除 `-help` 会直接打印帮助并退出、`-web` 会启动 Web UI 外，其它命令会启动 REPL 并执行对应内部命令，例如 `neo -model` 等同于进入 REPL 后输入 `/model`。

常用 slash commands：

| 命令 | 作用 |
| --- | --- |
| `/help` | 显示命令列表 |
| `/model` | 查看当前模型和 reasoning 设置 |
| `/model <model-id>` | 切换模型 |
| `/model <model-id> <effort>` | 切换模型并设置 reasoning effort |
| `/model <effort>` | 只切换 reasoning effort |
| `/login` | 交互式选择供应者、编辑配置并保存到 env 文件 |
| `/cost` | 查看当前 REPL 会话累计 token 使用量 |
| `/compact` | 手动压缩早期上下文 |
| `/pure` | 在风险/WAF 阻断后清理上下文但不重置会话 |
| `/sessions` | 打开会话浏览器 |
| `/state` | 查看 query engine 状态与通信日志状态 |
| `/log <absolute-dir>` | 将模型通信日志写入指定绝对目录 |
| `/log off` | 关闭模型通信日志 |
| `/reset` | 清空当前历史，并在 transcript 中写入 reset marker |
| `/exit` / `/quit` | 退出 |

交互细节：

- `Tab` 可补全 slash command。
- 上/下方向键可浏览输入历史，也可在补全面板中移动选择。
- `/sessions` 中使用上/下选择，会话多页时左/右或 PageUp/PageDown 翻页，Enter 恢复，Esc 关闭，`d`/Delete/Backspace 删除选中的非活跃会话。
- `Ctrl+V` / `Cmd+V` 或右键粘贴会读取系统剪贴板；长文本会以附件形式折叠，图片会作为 image block 发送给支持图片输入的模型。
- 空输入时第一次 `Ctrl+C` 会尝试中断当前任务或提示再次退出，第二次退出；有输入内容时 `Ctrl+C` 清空输入。

## 架构概览

```text
src/
  repl/      Ink 终端 UI、输入编辑、slash commands、剪贴板、会话浏览
  core/      QueryEngine、多轮 query loop、消息管线、事件流、子代理 runner
  model/     模型网关、OpenAI adapter、HTTP/SSE、重试、错误归一化、模型元数据
  tools/     Tool 接口、注册表、schema 校验、执行编排、内置工具
  context/   system prompt、用户/系统上下文、上下文指标、压缩器
  session/   JSONL transcript、会话列表/恢复、大型工具结果落盘
  agents/    AgentTool、AgentDefinition、本地后台任务输出
  tasks/     TaskStore、TaskOutput/TaskList/TaskGet/TaskStop/TaskResume/SendMessage
  skills/    可复用 prompt workflow 的 SkillTool 与内存 catalog
  app/        AppState port 和内存实现
  safety/     permission / sandbox / audit 的接口边界
  types/      message 与 event 类型
```

### 运行主线

`QueryEngine` 是 REPL 与核心 loop 之间的状态封装：

1. 接收用户输入并追加到历史。
2. 记录 session transcript。
3. 生成一次 system init message，用于展示本轮可用工具、模型、命令等信息。
4. 调用 `query()` 进入流式多轮循环。
5. 将模型消息、工具结果、压缩边界和终止状态持续写回历史与 transcript。

`query()` 的每轮流程：

1. 构建 runtime context：system prompt、user context、system context。
2. 根据 compact boundary 选择参与模型调用的消息。
3. 对大型工具结果做预算处理；启用 session 时会将超大结果写到 `.agent/sessions/<session>/tool-results/` 并用预览替换。
4. 修复缺失的 tool_use/tool_result 配对，避免模型 API 拒绝历史。
5. 估算 context metrics，并按预算触发压缩。
6. 流式调用模型网关。
7. 收集 assistant 文本、thinking、tool_use 和 usage。
8. 如有工具调用，按并发安全规则执行工具，把 tool_result 放入下一轮。
9. 无工具调用时结束；如果因输出 token 达限且没有工具调用，会尝试提高输出预算继续。
10. 遇到 context length 错误时会进行一次 reactive compact 后重试。

事件类型定义在 `src/types/events.ts`，包括 `state`、`context.metrics`、`assistant.delta`、`thinking.delta`、`tool.started`、`tool.finished`、`usage`、`terminal` 等。

## 模型层

模型访问通过 `ModelGateway` 抽象。当前内置 provider 包括 OpenAI、DeepSeek 与 Kimi：

- `openai-adapter.ts`：端点选择、认证、超时、重试、Responses→Chat fallback。
- `deepseek-adapter.ts`：DeepSeek OpenAI 格式 Chat Completions，默认 `https://api.deepseek.com/chat/completions`，支持 `reasoning_content` 到 thinking 事件的归一化。
- `kimi-adapter.ts`：Kimi/Moonshot OpenAI 兼容 Chat Completions，默认 `https://api.moonshot.cn/v1/chat/completions`，支持 `reasoning_content` 到 thinking 事件的归一化。
- `openai-responses-mapper.ts`：Responses API 请求和流事件归一化。
- `openai-chat-mapper.ts`：Chat Completions 请求和流事件归一化。
- `http-transport.ts` / `sse-decoder.ts`：HTTP 请求与 SSE 流解析。
- `errors.ts`：将 provider 错误归一为 `ModelAPIError` 分类。
- `context-window.ts` + `model-metadata.json`：静态模型元数据，用于 context window、reasoning effort 和图片输入能力判断。

支持的配置变量：

| 变量 | 说明 |
| --- | --- |
| `MODEL_PROVIDER` | `openai`、`deepseek` 或 `kimi` |
| `OPENAI_API_KEY` / `DEEPSEEK_API_KEY` / `KIMI_API_KEY` | 供应者专属 API Key；只读取当前 `MODEL_PROVIDER` 对应的一组变量；Kimi 也兼容 `MOONSHOT_API_KEY` |
| `OPENAI_BASE_URL` / `DEEPSEEK_BASE_URL` / `KIMI_BASE_URL` | 供应者专属服务地址；DeepSeek 默认 `https://api.deepseek.com`，Kimi 默认 `https://api.moonshot.cn/v1`；国际站 key 使用 `https://api.moonshot.ai/v1` |
| `OPENAI_MODEL` / `DEEPSEEK_MODEL` / `KIMI_MODEL` | 供应者专属默认模型；OpenAI 默认 `gpt-5.5`，DeepSeek 默认 `deepseek-chat`，Kimi 默认 `kimi-k2.6` |
| `OPENAI_FALLBACK_MODEL` / `DEEPSEEK_FALLBACK_MODEL` / `KIMI_FALLBACK_MODEL` | 供应者专属 fallback model |
| `OPENAI_ENDPOINT` | OpenAI 专用，`responses`、`chat` 或 `auto`；DeepSeek 与 Kimi 固定使用 Chat Completions |
| `MODEL_REASONING_EFFORT` | 共享运行设置：`none`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max` |
| `MODEL_REASONING_SUMMARY` | `auto`、`concise`、`detailed` |
| `MODEL_MAX_OUTPUT_TOKENS` | 默认最大输出 token，未设置时为 800 |
| `MODEL_CONTEXT_WINDOW_TOKENS` | 覆盖模型上下文窗口估算 |
| `MODEL_TIMEOUT_MS` | 请求超时 |
| `MODEL_STREAM_IDLE_TIMEOUT_MS` | 流式响应空闲超时 |
| `MODEL_MAX_RETRIES` | provider 重试次数 |

## 工具体系

工具实现统一遵循 `Tool<TInput>` 接口，包含：

- 名称与 alias。
- JSON Schema 输入定义。
- 元数据：是否只读、是否可并发、是否可见、最大结果大小等。
- 输入 normalize 与自定义校验。
- 权限决策入口 `canUseTool`。
- 执行函数 `call()` / `execute()`。
- 结果映射、进度消息渲染、上下文修改器。

`ToolRegistry` 负责注册和按 prompt cache 友好顺序输出工具定义；`runToolUse()` 负责 schema 校验、权限检查、进度事件、执行、结果映射和异常转 tool_result；`runTools()` 会把同一轮模型产生的工具调用按并发安全性分批执行。默认并发上限为 10，可用 `AGENT_MAX_TOOL_USE_CONCURRENCY` 调整。

REPL 当前注册的内置工具：

| 工具 | 作用 |
| --- | --- |
| `echo` | 返回输入文本，主要用于测试链路 |
| `read` / `view` | 按行范围读取文本文件 |
| `list` | 列目录，支持递归、隐藏文件、深度、排除项和数量限制 |
| `grep` | 通过 bundled ripgrep 搜索工作区文本 |
| `write` | 创建或覆盖文本文件 |
| `edit` / `replace` | 基于唯一字符串替换修改文件，容忍 LF/CRLF 和直/弯引号差异 |
| `exec` / `shell` / `bash` / `powershell` | 执行命令，支持 cwd、超时、输出截断和后台模式 |
| `search` | 通过可插拔 provider 搜索 Web；OpenAI 模型提供者默认走 GPT web search，否则默认 Exa MCP；可显式切换 provider |
| `plan` | 输出和更新当前任务计划 |
| `agent` | 启动同步/后台/fork 子代理 |
| `TaskOutput` | 读取后台任务输出，可阻塞等待完成 |
| `TaskList` | 列出后台任务 |
| `TaskGet` | 查看单个后台任务详情 |
| `TaskStop` | 停止后台任务 |
| `TaskResume` | 以新指令恢复已结束/失败/停止的后台 agent 任务 |
| `SendMessage` | 给命名后台 agent 排队消息 |

### 文件与搜索

- `read` 对大文件使用 offset/limit 分段读取，避免一次性塞满上下文。
- `list` 默认跳过 `.git`、`node_modules`、`dist`、`build`、`coverage` 等重目录。
- `grep` 不依赖系统 PATH，会调用 `vendor/ripgrep` 中的平台二进制；支持 glob、大小写模式、fixed strings、隐藏文件、上下文行、结果数和列宽限制。
- `search` 默认优先使用显式 `SEARCH_PROVIDER` / `WEB_SEARCH_PROVIDER`；未显式配置且当前模型提供者为 OpenAI（`MODEL_PROVIDER=openai` 或存在 `OPENAI_API_KEY`）时走 OpenAI Responses API 的 GPT web search，否则走 `https://mcp.exa.ai/mcp` 的 `web_search_exa`。OpenAI 搜索可通过 `OPENAI_SEARCH_API_KEY`、`OPENAI_SEARCH_BASE_URL`、`OPENAI_SEARCH_MODEL`、`OPENAI_SEARCH_TOOL_TYPE`、`OPENAI_SEARCH_CONTEXT_SIZE` 配置；Exa 可通过 `EXA_MCP_URL`、`EXA_MCP_TOOL_NAME` 配置；两者超时可用 `SEARCH_TIMEOUT_MS` 配置。模型也可以在单次工具调用里通过 `provider` 字段切换后端，但工具提示会要求：除非用户明确要求特定 provider，或默认/当前搜索 provider 在重试后持续不可用，否则不要显式指定 `provider`，让系统默认选择生效。

### 命令执行

`exec` 根据平台和 `shell` 参数选择 PowerShell、cmd、bash 或 sh。支持：

- `cwd`：命令工作目录。
- `timeoutMs`：超时控制。
- `maxOutputChars`：分别限制 stdout/stderr 返回长度。
- `background=true`：将长命令注册为后台任务，立即返回 task id，后续用 `TaskGet`/`TaskOutput`/`TaskStop` 管理。

## 上下文与压缩

`DefaultContextManager` 每轮构建两类上下文：

- **User context**：当前日期，以及项目记忆文件内容。默认读取 `AGENTS.md`、`CLAUDE.md`、`.agent/memory.md`、`.codex/memory.md`、`.github/copilot-instructions.md`。
- **System context**：cwd、platform、git branch、recent commit、status。

`prompts.ts` 将 system prompt 分为可缓存稳定段和动态段，中间使用 `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__` 标记。`message-pipeline.ts` 在模型调用前把 user context 作为用户消息 prepend，并把 system context append 到 system prompt。

压缩实现位于 `src/context/compaction.ts`：

- `DeterministicCompactor` 提供可预测的 snip、microcompact、summary fallback。
- `ModelDrivenCompactor` 使用当前模型生成摘要，支持 autocompact、manual compact、pure compact 和 reactive compact。
- 当工具结果过大时，session 模式下 `FileToolResultMemory` 会把完整结果写入文件，仅把预览和路径留在上下文中。

## 会话持久化

默认启用 transcript，位置为：

```text
.agent/sessions/<session_id>/transcript.jsonl
.agent/sessions/<session_id>/tool-results/*
```

会话记录包括用户/助手/工具消息、内容替换记录、title、compact marker 和 reset marker。`/reset` 不删除文件，而是写入 reset marker，使未来 resume 从 reset 后继续。

相关环境变量：

| 变量 | 作用 |
| --- | --- |
| `AGENT_SESSION_TRANSCRIPT=0` | 禁用 transcript |
| `AGENT_SESSION_DIR=<dir>` | 修改 session 根目录 |
| `AGENT_SESSION_RESUME=1` | 启动时恢复最近会话 |
| `AGENT_SESSION_ID=<id>` | 指定 session id；配合 resume 恢复指定会话 |
| `AGENT_SESSION_TITLE_DELAY_MS` | 会话标题生成延迟，默认 5000ms |
| `AGENT_TOOL_RESULT_THRESHOLD_CHARS` | 大型工具结果落盘阈值 |

每次用户输入后，`QueryEngine` 会延迟启动一个无工具的标题子代理：先生成初始短标题，后续在已有标题基础上进行一次 refinement。标题用于 `/sessions` 列表和终端标题。

## 子代理与任务

`agent` 工具通过 `runAgent()` 复用主 query loop，但使用独立的消息、上下文和工具池。子代理定义支持工具 allow/deny、模型覆盖、最大轮数、背景运行、隔离类型和自定义 system prompt。

调用模式：

- **同步子代理**：默认模式；当前工具调用等待子代理完成后返回最终文本、耗时、token 和工具调用数。
- **后台子代理**：`run_in_background=true` 或 `mode=background`；立即返回 `task_id` 和 output file。
- **fork 子代理**：`mode=fork`；继承父上下文，但追加反递归和作用域约束。
- **并行同步子代理**：同一模型轮次中多个 `agent` 调用设置 `parallel=true` 后可被并发批处理。

后台任务由 `TaskStore` 管理，完成、失败或停止后会写入：

```text
.agent-tasks/<task_id>.txt
```

控制工具：

- `TaskList()`：列任务。
- `TaskGet({ task_id })`：查详情。
- `TaskOutput({ task_id, block, timeout_ms })`：读输出，可等待完成。
- `TaskStop({ task_id })`：停止任务。
- `TaskResume({ task_id, directive })`：带新指令恢复任务。
- `SendMessage({ target, message })`：向命名或指定 agent id 的后台任务追加待处理消息。

子代理相关限制：

- `AGENT_SUBAGENT_MAX_TURNS` 可覆盖子代理最大轮数。
- `AGENT_SUBAGENT_WALL_TIMEOUT_MS` 可设置子代理墙钟超时。
- fork 子代理不能继续生成更多子代理，避免递归失控。

## Skill 模块

`src/skills` 提供可复用 prompt workflow 与插件化 catalog。设计参考：Claude Code 的 `SKILL.md` + frontmatter 目录形态、OpenAI Agents SDK 的 tools / agents-as-tools / guardrails 组合方式，以及 OpenClaw 的多目录、插件目录和 skill gating 思路。默认 REPL 运行时当前未注册 skill catalog，嵌入方可按需装配。

核心能力：

- `SkillDescriptor` 支持 `version`、`tags`、`inputSchema`、`outputSchema`、`permissions`、`examples`、`trustLevel`、`source` 等插件元数据。
- `InMemorySkillCatalog` 适合测试和静态注入。
- `FileSystemSkillCatalog` 支持 `.neo/skills/<skill-name>/SKILL.md` 风格目录，也可合并 workspace、user、plugin、remote mirror 等多个 root。
- `CompositeSkillCatalog` 可按优先级合并多个 catalog。
- `createSkillTool()` 会创建 `skill` 调用工具。
- inline skill 会向下一轮模型注入 meta user message，并可修改主循环模型/effort，同时记录 `activeSkill`。
- `createSkillAwareCanUseTool()` 可基于 active skill 的 `allowedTools` 做运行期工具 gating。
- fork skill 会返回 `fork_required`，需要调用方用 AgentTool / 子 agent 编排承接。
- `createSkillManagementTools()` 提供 `skill_list`、`skill_read`、`skill_validate`、`skill_create`、`skill_update`、`skill_delete`，方便父项目实现 agent 自动生成 skill。

`SKILL.md` 示例：

```md
---
name: review-code
description: Review code changes for correctness and risk.
version: 1.0.0
execution: inline
allowed-tools:
  - read
  - grep
tags:
  - code-review
trust-level: workspace
---

Review the provided changes. Focus on correctness, security, tests, and migration risk.
Return concise findings with file references when available.
```

父项目装配示例：

```ts
import {
  FileSystemSkillCatalog,
  createSkillTool,
  createSkillManagementTools,
  createSkillAwareCanUseTool,
} from "neoctl";

const skills = new FileSystemSkillCatalog({
  roots: [
    { root: ".neo/skills", kind: "workspace" },
    { root: ".neo/plugins/acme/skills", kind: "plugin", plugin: "acme", readonly: true },
  ],
});

tools.register(createSkillTool(skills));
for (const tool of createSkillManagementTools(skills, { requireApproval: true })) tools.register(tool);

const canUseTool = createSkillAwareCanUseTool(skills, parentCanUseTool);
```

建议：开放 `skill_create`/`skill_update` 给模型时保持 approval；对 remote/plugin skill 使用只读 root；生产环境使用 `createSkillAwareCanUseTool()` 或父级权限系统强制 `allowedTools`。

## 作为库使用

包入口会导出核心 agent 编排运行时、模型网关、上下文管理、任务/子代理、工具系统、session 与 safety 边界：

```ts
import {
  QueryEngine,
  ToolRegistry,
  createModelGatewayFromEnv,
  readFileTool,
  listDirectoryTool,
  grepTool,
  execTool,
  planTool,
} from "neoctl";

const tools = new ToolRegistry();
tools.register(readFileTool);
tools.register(listDirectoryTool);
tools.register(grepTool);
tools.register(execTool);
tools.register(planTool);

const engine = new QueryEngine({
  agentId: "main",
  modelGateway: createModelGatewayFromEnv(),
  tools,
});

for await (const event of engine.sendUserText("Summarize this repository")) {
  console.log(event);
}
```

Vue 等前端项目如果通过 API 消费消息，可使用展示层投影工具把内部 `Message` 转为可直接渲染的 DTO。图片块会提供可赋给 `<img :src>` 的 `thumbnail.src`：

```ts
import { toDisplayMessages } from "neoctl";

const displayMessages = toDisplayMessages(engine.getHistoryMessages(), {
  imageMode: "data-url",
  includeThinking: false,
  includeToolUse: false,
});
```

```vue
<img
  v-if="block.type === 'image' && block.thumbnail"
  :src="block.thumbnail.src"
  class="message-image-thumb"
/>
```

也可以用 `imageMode: "metadata-only"` 只返回图片标签、MIME 与大小信息，避免在列表接口中内联 base64。

除根入口外，发布包还通过 package `exports` 暴露 `dist` 下的编译后子路径，便于依赖方按需导入较底层模块：

```ts
import { HttpTransport } from "neoctl/model/http-transport";
import { createAgentTool } from "neoctl/agents/agent-tool";
```

如果直接从源码运行，请使用 `.ts` 源文件路径或 `tsx`；发布包会通过 `dist` 导出编译后的 `.js` 模块与 `.d.ts` 类型声明。

## 运行数据目录

| 路径 | 内容 |
| --- | --- |
| `.agent/sessions/` | 默认会话 transcript 和大型工具结果 |
| `.agent-tasks/` | 后台 agent / exec 任务最终输出 |
| `vendor/ripgrep/` | 当前平台 ripgrep 二进制和 manifest |
| `dist/` | `npm run build` 生成的编译产物 |

## 当前边界

- 模型 provider 配置类型目前内置 OpenAI、DeepSeek 与 Kimi provider。
- `src/safety` 是 permission、sandbox、audit 的接口边界；默认 REPL 没有强制沙箱策略。
- `src/skills` 已实现工具与 catalog，但默认 REPL 未装配 skill catalog。
- `isolation=worktree/remote` 在 AgentTool schema 中保留为接口形态，当前本地实现主要通过 `cwd` 和独立消息上下文隔离。
