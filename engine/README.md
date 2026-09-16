# Neo Engine

Neo 的 TypeScript 核心运行时，提供 `neo` 命令行、模型调用、工具执行、会话管理和子代理任务。Web 和 Desktop 共用这套核心。

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
