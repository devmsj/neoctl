# Neo Desktop

基于 Tauri 2 的 Windows 桌面应用，负责安装、更新和启动 Neo Web，提供托盘、后台启停及文件下载功能。

## 使用

首次启动选择数据目录，点击“安装并启动”。应用使用内置 Node.js，联网安装最新的 `neoctl-web` 及其兼容的 Engine，然后进入工作台。

默认数据目录是 `%LOCALAPPDATA%\Neo Desktop Data`：

- `runtime/`：Node.js、Web 和 Engine。
- `data/`：配置、会话和工作区。
- `logs/`：运行日志。

可从菜单返回启动页，停止后台后更新运行时。卸载桌面应用会保留数据目录。

## 构建

需要 Windows 10/11、Node.js 20+、Rust MSVC 工具链、Microsoft C++ Build Tools 和 WebView2。

在仓库根目录执行：

```powershell
npm ci --prefix web
npm ci --prefix desktop
npm --prefix desktop run build
```

构建会打包 Web、准备内置 Node.js，再生成 NSIS 安装程序。默认输出目录为 `desktop/src-tauri/target/release/bundle/nsis/`。

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
