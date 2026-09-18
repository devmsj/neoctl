# Neo Engine

Neo 的 TypeScript 核心运行时，提供 `neo` 命令行、模型调用、工具执行、会话管理和子代理任务。Web 和 Desktop 共用这套核心。

子代理调度及管理工具（`subagent_run/output/list/get/stop/message/resume`）默认关闭：未配置时不会向模型暴露，也不能通过工具别名调用。Web/Desktop 可在工具设置中显式开启，会话设置可覆盖全局设置；已有明确保存的设置保留。SDK 使用者可通过 `ToolRegistry.setEnabled(name, true)` 显式开启。子代理内部的 `subagent_report` 汇报通道不受此默认开关影响。

## 安装使用

需要 Node.js 20+。

```sh
npm install -g neoctl
neo
```

首次使用输入 `/login` 配置模型。常用命令：

```sh
neo -help                  # 查看帮助
neo run "总结当前仓库"       # 执行一次任务
neo -web                   # 打开核心自带的 Web 界面
```

对话中可用 `/new` 新建会话、`/sessions` 查看历史、`/compact` 压缩上下文。

## 模型配置

支持 OpenAI 兼容的 Responses 和 Chat Completions 接口。除交互配置外，也可在工作目录的 `.env` 中填写：

```env
MODEL_PROVIDER=openai
OPENAI_API_KEY=your-api-key
OPENAI_BASE_URL=https://api.openai.com
OPENAI_MODEL=your-model-name
OPENAI_ENDPOINT=auto
```

将密钥和模型名替换为实际值。`NEO_ENV_FILE` 可指定其他配置文件。

## 源码开发

在 `engine/` 目录执行：

```sh
npm ci
npm run dev
```

| 命令 | 用途 |
| --- | --- |
| `npm run build` | 编译源码到 `dist/` |
| `npm start` | 运行已构建的 CLI |
| `npm run typecheck` | 检查源码和测试类型 |
| `npm test` | 运行单元测试 |
| `npm run standalone` | 构建当前平台的便携分发目录 |

源码位于 `src/`，测试位于 `tests/`。便携构建输出到 `standalone/<平台>-<架构>/`。

更多测试命令见 [tests/README.md](tests/README.md)。
