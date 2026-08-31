# neoctl

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

neoctl 是一个使用 TypeScript 构建的本地 AI 工程代理，提供流式 Agent 运行时、终端 REPL，以及基于 Vue 3 的浏览器工作台。

它面向需要让模型在本地完成真实工程任务的开发者：读取和修改文件、搜索代码、执行命令、管理上下文、恢复会话，并通过子代理与后台任务处理较长的工作流。

> 项目仍在快速迭代中，接口和配置可能发生变化。用于重要数据或生产环境前，请先在隔离工作区中验证。

## 项目组成

```text
neoctl/
├── engine/   # Agent 运行时、neo CLI、模型适配器、工具与会话系统
├── web/      # Vue 3 + Vite 浏览器工作台及 Node.js 服务端
└── LICENSE   # Apache License 2.0
```

| 目录 | 说明 | 技术栈 |
| --- | --- | --- |
| [`engine`](engine/) | 可独立运行和作为 npm 模块使用的 AI Agent 核心，提供 `neo` 命令行与原生 Web API | TypeScript、Node.js、React Ink |
| [`web`](web/) | 面向设计和工作流用户的单页应用，复用 neoctl 的会话、工具和流式协议 | Vue 3、Vite、Node.js |

## 主要能力

- 流式多轮 Agent Loop，统一处理文本、推理、工具调用、用量和终止事件。
- OpenAI Responses / Chat Completions 与 Anthropic Messages API 支持。
- 文件读写、文本搜索、命令执行、Web 搜索、计划、图片及自定义工具。
- 上下文预算、手动压缩、JSONL 会话持久化与历史恢复。
- 子代理、后台任务和可恢复的长时间工作流。
- Ink 终端 REPL，以及会话隔离的 Vue 浏览器工作台。
- Windows、Linux 和 macOS 的内置 ripgrep 运行资源。

## 环境要求

- Node.js 20 或更高版本
- npm 10 或兼容版本
- 一个 OpenAI 兼容服务或 Anthropic API 凭据

## 快速开始

### 启动浏览器工作台

```bash
git clone https://github.com/devmsj/neoctl.git
cd neoctl/web
npm install
npm run dev
```

开发模式默认启动：

- Web 应用：`http://0.0.0.0:5173`（可通过本机局域网 IP 访问）
- Agent 运行时：`http://127.0.0.1:3101`

首次使用可在 Web 应用的模型配置页面填写 API Key、服务地址和模型，也可以从示例文件创建项目级配置：

```bash
cp .env.neo.example .env
```

Windows PowerShell：

```powershell
Copy-Item .env.neo.example .env
```

生产方式启动：

```bash
npm ci
npm start
```

默认监听 `0.0.0.0:5173`，可通过 `APP_HOST`、`APP_PORT` 或 `PORT` 调整。工作区根目录可通过 `NEO_WORKSPACE_ROOT` 设置。

### 启动终端 Agent

```bash
cd neoctl/engine
npm install
npm run build
npm start
```

开发模式：

```bash
npm run dev
```

配置可以保存在当前目录的 `.env`、用户级配置文件，或由 `NEO_ENV_FILE` 指定。最小 OpenAI 配置示例：

```env
MODEL_PROVIDER=openai
OPENAI_API_KEY=your-api-key
OPENAI_BASE_URL=https://api.openai.com
OPENAI_MODEL=gpt-5.6
OPENAI_ENDPOINT=auto
```

运行时也可以通过 npm 安装：

```bash
npm install -g neoctl
neo -help
neo run "总结当前仓库"
echo "检查当前改动" | neo run --json
```

完整的模型配置、REPL 命令和运行时架构请参阅 [`engine/README.md`](engine/README.md)。Web 部署和界面能力请参阅 [`web/README.md`](web/README.md)。

## 常用开发命令

运行时：

```bash
cd engine
npm run typecheck
npm run build
npm run smoke:core
npm run smoke:tools
npm run smoke:context
npm run smoke:session
npm run smoke:agents
```

Web 应用：

```bash
cd web
npm run dev
npm run build
npm run test:xhs
```

两个子项目目前分别管理依赖与锁文件。修改运行时后若需要在 Web 应用中联调，请确保 Web 使用的 `neoctl` 依赖版本包含对应改动。

## 工作原理

```text
Browser / Terminal
        │
        ▼
 Web workspace / neo REPL
        │
        ▼
   QueryEngine event loop
        │
        ├── Model providers
        ├── Context and sessions
        ├── Tools and shell tasks
        └── Subagents and background tasks
```

`engine` 负责模型调用、上下文、会话和工具执行；`web` 通过 HTTP/SSE 协议连接运行时，并为每个会话维护独立工作目录。浏览器端不会直接加载具有本地系统权限的运行时模块。

## 安全提示

neoctl 的部分工具可以读取和修改文件、执行系统命令及访问网络。请注意：

- 只在你信任的机器、模型服务和代码仓库中运行。
- 不要把 API Key、密码或生产凭据提交到 Git。
- 为不受信任的任务使用容器、虚拟机或权限受限的工作目录。
- 对自动执行的命令和文件修改进行人工检查，再用于生产环境。
- 将 Web 服务暴露到局域网或公网前，额外配置访问控制和反向代理安全策略。

## 参与贡献

欢迎通过 Issue 报告问题或提出建议，也欢迎提交 Pull Request。提交代码前请至少运行相关目录的类型检查、构建和冒烟测试，并尽量为行为变化补充说明或测试。

## License

本项目基于 [Apache License 2.0](LICENSE) 开源。
