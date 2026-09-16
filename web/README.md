# Neo Web

基于 Vue 3 和 Vite 的浏览器工作台，使用 Neo Engine 处理对话和工具调用。提供会话管理、图片上传、运行状态查看和插件功能。

## 安装使用

需要 Node.js 20+。

```sh
npm install -g neoctl-web
neow
```

`neow` 自动打开浏览器，默认地址为 `http://127.0.0.1:5173`，端口占用时自动顺延。在页面中填写模型 API 地址、密钥和模型名称即可开始对话。

## 源码开发

在仓库根目录执行：

```sh
npm ci --prefix engine
npm ci --prefix web
npm --prefix web run dev
```

打开 `http://localhost:5173`。`dev` 会构建并使用本地 Engine；`dev:package` 改用 npm 安装的核心。

## 生产启动

在 `web/` 目录执行：

```sh
npm ci
npm start
```

`npm start` 会先构建前端，再启动服务，默认监听 `0.0.0.0:5173`，使用 npm 核心。已有本地 Engine 构建时，可运行 `npm start -- --core local`。

常用环境变量：

| 变量 | 用途 |
| --- | --- |
| `APP_HOST` / `APP_PORT` | 生产服务监听地址和端口 |
| `VITE_HOST` / `VITE_PORT` | 开发服务监听地址和端口 |
| `NEO_WEB_DATA_DIR` | Web 数据目录 |
| `NEO_WORKSPACE_ROOT` | 会话工作目录的根路径 |

默认 Web 数据目录为 Windows 的 `%LOCALAPPDATA%\neoctl-web`、macOS 的 `~/Library/Application Support/neoctl-web`、Linux 的 `${XDG_DATA_HOME:-~/.local/share}/neoctl-web`。

## 开发命令

以下命令在 `web/` 目录执行：

```sh
npm run build          # 构建前端
npm test               # 非浏览器测试，需先构建本地 Engine
npm run test:server    # 服务启动与模型配置回归
```

页面源码在 `src/`，服务入口为 `server.mjs`，插件在 `plugins/`，测试在 `tests/`。

测试说明见 [tests/README.md](tests/README.md)；多用户配置见 [isolation.example.json](isolation.example.json) 和 [用户管理脚本](scripts/isolation-user.mjs)。
