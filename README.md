# Neo

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-339933?logo=node.js&logoColor=white)](https://nodejs.org/)

本地 AI 工程助手，在终端、浏览器或 Windows 桌面中完成代码阅读、文件编辑和命令执行。

## 功能

- 接入 OpenAI 兼容的 Responses / Chat Completions API。
- 流式对话、图片附件、工具调用与会话恢复。
- 文件搜索与编辑、终端命令、子代理和后台任务。
- 通过插件扩展工具和 Web 功能。

## 快速开始

需要 Node.js 20+ 和可用的模型 API 配置。

**浏览器版**

```sh
npm install -g neoctl-web
neow
```

启动后在页面的模型配置中填写 API 地址、密钥和模型名称。`neow` 会自动打开浏览器。

**终端版**

```sh
npm install -g neoctl
neo
```

在终端中使用 `/login` 配置模型，然后直接输入任务。

## 源码开发

```sh
git clone https://github.com/devmsj/neoctl.git
cd neoctl
npm ci --prefix engine
npm ci --prefix web
npm --prefix web run dev
```

打开 `http://localhost:5173`。开发模式使用当前仓库的 Engine。

## 项目结构

| 模块 | 说明 |
| --- | --- |
| [engine](engine/README.md) | TypeScript 核心运行时、CLI、工具与会话管理 |
| [web](web/README.md) | Vue 3 浏览器工作台和 Node.js 服务 |
| [desktop](desktop/README.md) | Tauri 2 Windows 桌面应用 |

测试命令见 [TESTING.md](TESTING.md)，Docker 部署见 [docker_deploy](docker_deploy/README.md)。

## License

[Apache-2.0](LICENSE)
