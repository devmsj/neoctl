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

## 可选的桌面资源定位协议

资源插件不依赖桌面模块。`route(req, res, url, helpers)` 可在完成自身资源授权、文件存在性与可读性校验后，将 `helpers.localResourceHeaders?.(req, absolutePath)` 合入响应头；没有 helper 时保持原有 GET/HEAD 行为。不得直接信任请求中传入的本地路径。

桌面客户端对原资源 URL 发送 `HEAD` 和 `X-Neo-Resource-Action: reveal`，读取百分号编码的 `X-Neo-Resource-Path`，再调用壳提供的通用定位能力。宿主只在受管桌面本地服务（`NEO_DESKTOP_LOCAL_RESOURCES=1`、监听 `127.0.0.1`、非 Docker）提供路径；普通 GET/HEAD 和浏览器下载不暴露路径。前端拒绝跨源和重定向，壳再次核对当前受管运行时的精确 origin，并验证本机普通文件。不会通过 URL 或命令行执行资源。

协议没有插件专用路由、注册表镜像或缓存；插件缺失、关闭或不支持时不触发本地动作。新增插件只需选择实现协议，无需修改桌面壳。全局停用或卸载后，历史资源的新请求也立即失效，包括桌面定位请求。

## 插件热插拔

设置页可启停插件、安装可信本地插件包或卸载插件，无需重启。安装时输入**运行 Web 服务的机器上**包含 `neo-plugin.json` 的绝对目录；不执行 npm 安装脚本，不下载远端代码。插件是可信服务器代码，拥有宿主进程权限，不是沙箱；不要安装不可信来源。包内须自包含依赖，不接受符号链接。

- 全局启停立即影响资源 HTTP 路由；运行中主会话及子代理在下一次模型调用前同时更新工具和提示词。
- 已发出的模型请求及对应工具批次使用一致快照，允许完成；卸载后不接受新的资源请求，已有 HTTP 流允许结束。
- 安装复制到数据目录 `installed-plugins/<唯一版本目录>`，候选校验和索引持久化成功后才发布。相同 ID 重装会加载新的依赖图；未变化的插件实例保持不变。
- 卸载先逻辑移除，待轮次及 HTTP 流的引用释放后调用可选 `dispose()` 并清理旧安装目录。停用不重建实例、不删除数据；卸载也保留用户数据。内置包只记录卸载状态，不修改发行文件。
- 多用户模式下只有管理员可以管理安装及全局启停；各用户使用独立实例和数据目录。`NEO_WEB_PLUGINS` 环境配置仍锁定管理操作。
- 第三方插件应只在实例中持有可释放资源，工厂失败时自行回滚，卸载时通过 `dispose()` 清理。Node.js 不支持卸载 ESM 模块缓存，宿主不承诺回收任意模块级副作用；需要这种强隔离的插件应使用独立进程。

管理 API：`GET /api/plugins`；`POST /api/plugins/global` (`enabledIds`)；`POST /api/plugins/install` (`directory`)；`POST /api/plugins/uninstall` (`id`)。目录文件的手工编辑不是热更新入口，请使用安装接口重新发布。

## 开发命令

以下命令在 `web/` 目录执行：

```sh
npm run build          # 构建前端
npm test               # 非浏览器测试，需先构建本地 Engine
npm run test:server    # 服务启动与模型配置回归
```

页面源码在 `src/`，服务入口为 `server.mjs`，插件在 `plugins/`，测试在 `tests/`。

测试说明见 [tests/README.md](tests/README.md)；多用户配置见 [isolation.example.json](isolation.example.json) 和 [用户管理脚本](scripts/isolation-user.mjs)。
