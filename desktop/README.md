# Neo Desktop

独立的 Tauri 2 Windows 桌面壳。该目录不修改或耦合 `engine/`、`web/` 源码，只在构建时读取 `web` npm 包产物。

## 目录

```text
desktop/
├─ ui/                    # 安装引导页，纯 HTML/CSS/JS
├─ src-tauri/             # Tauri 2 / Rust 壳
├─ resources/
│  ├─ payload/            # 构建时生成的 neoctl-web.tgz
│  └─ node/               # 构建时下载的 Windows Node + npm
└─ scripts/
   ├─ prepare-payload.mjs
   └─ prepare-node-runtime.ps1
```

运行时安装到用户选择的位置，默认：

```text
%LOCALAPPDATA%\Neo Desktop Data
├─ runtime/               # Node、npm、neoctl-web、neoctl 及依赖
├─ data/                  # 用户配置、会话、上传和工作区
└─ logs/                  # Node 服务日志
```

## 行为

1. 安装包内包含 `neoctl-web.tgz`、Windows Node.js 和 npm。
2. 首次启动允许选择运行数据位置。
3. 将基础资源释放到临时目录。
4. 使用 `https://registry.npmmirror.com` 执行 nested 策略的 `npm install --omit=dev`。
5. 安装输出通过 Tauri event 实时显示，并映射为阶段进度。
6. 安装成功后原子替换 `runtime/`，失败不破坏已有版本。
7. 启动 `neoctl-web/server.mjs`，等待本地 HTTP 健康检查后在当前窗口进入工作台。
8. 服务只监听 `127.0.0.1`，窗口关闭时终止托管的 Node 进程。
9. 后续双击启动会读取安装记录并自动进入已安装工作台。

## 构建环境

- Windows 10/11
- Node.js 20+
- Rust stable（MSVC toolchain）
- Microsoft C++ Build Tools
- WebView2 Runtime

安装 Rust：

```powershell
winget install Rustlang.Rustup
rustup default stable-msvc
```

安装依赖并构建：

```powershell
cd desktop
npm install
npm run build
```

`npm run build` 会先执行 `bundle:prepare`：

- 在 `web/` 执行 `npm pack`，生成内置 `neoctl-web.tgz`；
- 从 npmmirror 下载固定版本 Windows Node.js zip；
- 再执行 Tauri NSIS 构建。

仅更新内置 payload：

```powershell
npm run payload
```

仅准备 Node：

```powershell
npm run runtime
```

## 注意

- `resources/node` 与生成的 tgz 被 `.gitignore` 排除，避免把大型构建资源提交进源码。
- 当前 Node 固定为 22.12.0，可通过 `prepare-node-runtime.ps1 -NodeVersion <version>` 调整。
- `neoctl-web` 自身锁定兼容的 `neoctl` 版本，桌面壳不单独追踪 core latest。
- 当前退出时通过 `taskkill /T` 清理托管进程树；正式发布可进一步改为 Windows Job Object。
- 正式发布前应增加 Authenticode 签名、安装包图标和升级/回滚策略。
