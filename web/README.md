# maker

一个 Render 风格的 Vue 3 + Vite 单页应用，面向设计人员和工作流用户封装 `neoctl` 本地 AI Agent 运行时。

当前版本目标：先复刻 `neo web` 的能力；绘图工具等待后续 `neoctl` 更新后再接入。

## 开发启动

```bash
npm run dev
```

该命令会同时启动：

- Neo 运行时：`http://127.0.0.1:3101`
- Vue 单页应用：`http://127.0.0.1:5173`

每个新建对话会自动创建独立工作目录：`workspace/YYMMDDHHMMSS`。可通过 `NEO_WORKSPACE_ROOT` 覆盖 `workspace` 根目录；会话恢复时会自动回到该会话原有的工作目录。

Vite 会把以下路径代理到 Neo 运行时，确保本应用使用与 `neo web` 相同的后端能力：

- `/events`：SSE 流式同步
- `/api/state`：运行时状态
- `/api/submit`：提交用户消息和附件
- `/api/interrupt`：中断当前任务
- `/api/sessions/*`：会话列表、恢复、新建、删除
- `/api/login`：模型供应商配置
- `/vendor/*`：neo web 运行时静态资源

`expose_downloads` 可暴露任意现有绝对文件路径，不受当前工作目录限制；下载链接仍为临时链接并按注册表有效期失效。

如果只想启动纯前端 Vite：

```bash
npm run dev:ui
```

## 构建

```bash
npm run build
```

## 生产部署

请使用 Node.js 20 或更高版本。

```bash
npm ci
npm start
```

`npm start` 会先自动执行 `npm run build`，再启动 `server.mjs`。请不要直接复用旧 `dist` 目录或只执行 `node server.mjs`，否则部署版可能继续运行旧的前端构建产物。

WSL/PM2 服务器可使用 `bin/` 下的运维脚本：

```bash
./bin/deploy.sh   # 拉取、安装、构建并重启
./bin/start.sh    # 启动生产服务
./bin/stop.sh     # 停止服务
./bin/restart.sh  # 重启服务
./bin/status.sh   # 查看进程与 HTTP 健康状态
```

WSL 开机入口为 `bin/wsl-boot.sh`，它会恢复生产进程，并按当前 WSL IP 刷新 Windows 的 `22` 和 `5173` 端口转发。

## 单页应用能力

已实现：

- 用户与模型聊天
- 复用 `neoctl` Web API/SSE 协议
- 流式助手输出
- 推理过程、工具、系统、用户消息展示
- 工具调用输出折叠/展开
- 状态栏：模型、上下文占用、输入/输出 token、运行阶段
- 后台任务摘要
- 会话列表、恢复、新建、删除
- 模型登录/配置表单
- 图片粘贴附件，沿用 neo web 的 `[img#N]` 协议
- Render.com 风格的侧边栏、顶部栏、卡片和工作台布局

暂未实现：

- 绘图工具/画布能力。等待 `neoctl` 后续提供绘图运行时后再接。

## neoctl 集成

本项目已安装 npm 依赖：

```bash
neoctl@^0.2.3
```

可用脚本：

```bash
npm run neo:help   # 查看 neoctl 命令帮助
npm run neo        # 启动 neo 命令行 REPL
npm run neo:web    # 启动 neoctl 原生 Web UI，默认 127.0.0.1:3000
npm run neo:login  # 交互式配置模型供应商
```

也可以直接使用：

```bash
npx neo -help
npx neo -web --port 3001
```

## 配置

`neoctl` 会读取当前目录 `.env`、用户级配置或 `NEO_ENV_FILE` 指定的配置文件。

项目提供 `.env.neo.example` 作为示例。需要项目级配置时：

```bash
copy .env.neo.example .env
```

然后编辑 `.env` 中的模型供应商、API Key、Base URL 和模型名，也可以在单页应用的“模型配置”页面中配置。

> 注意：`neoctl` 是 Node.js/CLI 运行时依赖，包含文件系统、命令执行、终端/本地 Web UI 等能力，不应直接 import 到 Vue 浏览器端组件。本项目通过“本地运行时 + Vite 代理”的方式集成。
