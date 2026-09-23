# Neo Desktop

基于 Tauri 2 的 Windows 桌面应用，负责安装、更新和启动 Neo Web，提供托盘、后台启停及文件下载功能。

## 使用

首次启动选择数据目录，点击“安装并启动”。应用使用内置 Node.js，联网安装最新的 `neoctl-web` 及其兼容的 Engine，然后进入工作台。

默认安装位置是 `%LOCALAPPDATA%\Neo Desktop Runtime`，不可写时尝试 `%APPDATA%\Neo Desktop Runtime`。不从会话目录、父目录或工作目录推导默认值，也没有会话目录禁选规则。已有配置继续使用原位置，不自动迁移。

首次安装会检测现有内容；非空目录必须换目录或明确确认清空（包括其中的会话、配置和工作区）。清理后验证为空且可写，失败不会继续安装。

目录布局：

- `releases/r-*/`：当前版本独立的 Node.js、Web 和 Engine。
- `.neo-updater/`：当前版本指针、更新事务和跨进程锁。
- `runtime/`：仅旧版兼容路径，第一次成功切换后删除。
- `data/`：配置、会话和工作区。
- `logs/`：运行日志。

可从菜单返回启动页直接更新运行时：先准备新版本，再停止受管后台、验证新后台，最后提交并删除旧版本。卸载桌面应用会保留数据目录。

## 文件交互

- 对话中暴露的本地文件链接：桌面端点击后在 Windows 文件资源管理器中打开所在目录并选中文件，不下载副本、不执行文件。浏览器端仍保持下载。
- 文件可从资源管理器拖到输入框，复用 Web 上传与附件逻辑。Windows 下关闭 Tauri 原生拖拽接管（`dragDropEnabled: false`），让 HTML5 拖拽事件进入页面；不增加第二套原生文件上传流程。
- 文件定位是通用壳能力，不绑定任何 Web 插件名、路由或存储格式。插件按可选资源协议提供源文件路径；未启用、不支持或原文件丢失时显示错误，不偷偷回退为下载。
- 当前仅定位本机磁盘上的普通文件，不支持远程/容器文件或 UNC 网络路径。普通非资源下载仍使用原有保存对话框。
- 两项修复需要更新桌面壳和 Web 运行时；只更新 Web 无法改变旧壳的拖拽设置。Windows 不允许从普通权限的资源管理器拖入管理员权限进程，请不要以管理员身份运行桌面端。

## 构建

需要 Windows 10/11、Node.js 20+、Rust MSVC 工具链、Microsoft C++ Build Tools 和 WebView2。

在仓库根目录执行：

```powershell
npm ci --prefix web
npm ci --prefix desktop
npm --prefix desktop run build
```

构建会打包 Web、准备内置 Node.js，再生成 NSIS 安装程序。默认输出目录为 `desktop/src-tauri/target/release/bundle/nsis/`。

## GitHub 正式发布

发布顺序是 Core → Web → Desktop：先发布 `engine/package.json` 的版本，再发布精确依赖该 Core 的 Web，确认两者 npm `latest` 已传播，最后推送 `desktop-vX.Y.Z` 标签。

- 正式流水线设置 `NEO_RELEASE_PAYLOAD=registry`，内置 Web tgz 直接取自 npm 已发布版本，不重新打出另一份同版本包。Web 精确锁定 Core；首次安装仍需联网下载 Core 和其余依赖，不是完全离线安装包。
- 流水线开始、准备资源和发布前均核验仓库版本与 npm `latest` 一致，版本不一致会失败，禁止悄悄使用旧版。
- 必须通过 Core 类型检查与本次子代理回归、Web 设置测试、桌面脚本/Rust 测试、独立更新器离线协议测试及真实 npm 安装/升级测试。联网测试检查 Web/Core 精确版本、7 个子代理开关默认关闭、旧版本删除及数据保留。
- Release 附带安装包、SHA256、`release-versions.json`、`payload-manifest.json` 和源码 commit。可通过 `workflow_dispatch` 指定已有标签重跑同一份源码；失败步骤不会被忽略。
- Core 全量测试存在与本次变更无关的基线失败；发布专项流水线通过不等于历史全量测试全绿，不能通过跳过断言掩盖历史问题。

## 调试本地源码

在仓库根目录执行：

```powershell
npm ci --prefix engine
npm ci --prefix web
npm ci --prefix desktop
npm --prefix desktop run bundle:prepare
npm --prefix desktop run dev:local
```

`dev:local` 使用当前仓库的 Engine 和 Web，调试运行时及数据保存在 `desktop/.cache/dev-runtime/`。修改源码后重新运行即可。

## 测试与目录

准备好上述构建资源后，在 `desktop/` 目录执行：

```powershell
npm test               # 桌面脚本和启动页测试
npm run test:rust      # Rust 单元测试
npm run check          # 检查资源和目录布局
```

`ui/` 是启动页，`src-tauri/` 是 Rust 应用，`scripts/` 保存构建脚本，`tests/` 保存测试。更多测试说明见 [TESTING.md](../TESTING.md)。


## 独立更新和空间回收

- `neoctl-updater.exe` 独立准备新版本，不加载或覆盖当前后台的 Node 文件。
- 下载期间后台可继续运行；更新前原生确认说明后台任务将在切换时中断。
- Windows Job Object 管理受管后台及其子进程；切换时停止并等待整树退出，再启动候选版本、检查 `/api/client-info`，成功后原子提交当前版本指针。
- 新版本提交后立即删除所有非当前版本及旧布局残留，不保留历史版本。被外部服务占用时显示具体清理错误，可点“重试删除旧版本”；再次进入启动页也会重试。不会按进程名称批量杀死外部 Node，也不会把删除失败报为成功。
- 健康检查失败且尚未提交时，重新启动旧版本。更新器中断后，按已提交指针恢复，并清除未提交候选目录。
- `data/`、会话和工作区不属于更新垃圾回收。首次安装“清空此目录”是另一项明确的破坏性操作，有原生二次确认。
- 回滚仅覆盖程序版本，不能撤销新版本对共享数据的迁移；不兼容数据迁移应另加备份和迁移协议。

打包会先构建独立更新器并复制到 `resources/updater/`，然后生成包含更新器的桌面安装包。源码修改不会自动修复已安装的旧桌面壳，需要重新打包安装。

```powershell
npm --prefix desktop run test:updater
```

该离线集成测试使用真实更新器、临时 Node 和模拟 npm 包安装，验证提交、旧 Node 占用、清理重试、取消恢复和数据保留；不替代联网下载和桌面 GUI 端到端验收。

更新期间退出/卸载会提示等待操作完成；异常结束由 Windows Job Object 回收受管进程树。更新器协议有超时，首次安装未提交时恢复为可清理重试状态。健康检查核对 `/api/client-info` 返回的 Core 版本，不只检查端口或 HTTP 200。

安装依赖使用 npm 官方源 `https://registry.npmjs.org`，保持 TLS 校验。本机直连测试在镜像站及官方源均复现 Node/OpenSSL 加密运算错误；临时使用 `HTTP_PROXY` / `HTTPS_PROXY=http://127.0.0.1:7890`（`NO_PROXY=127.0.0.1,localhost,::1`）后，真实 npm 安装、再次更新、Web/Core 健康检查、旧版本删除与数据保留测试通过。代理仅用于测试进程，未写入安装包或持久配置。仍需已安装桌面 GUI 全流程验收。真实联网集成测试：`node desktop/tests/smoke/smoke-updater-network.mjs`，使用独立临时目录，先内置 Web 包安装，再 registry latest 更新，验证 HTTP Core 版本、旧版本删除与数据保留。此测试不安装或替换用户桌面程序。
