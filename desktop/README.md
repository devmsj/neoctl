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

## 桌面视觉与卸载

- 安装引导以实际最后加载的 neo-brutalist-soft.css 为准：浅灰纸面、天空蓝菱形、黑色硬边，少量粉色和青柠点缀；不加载远程字体或图像。
- 日志默认收起；百分比表示阶段估计，不是按下载字节测得的进度。系统要求减少动态效果时停用装饰动画。
- 图标源文件在 `branding/neo-windows-diamond-icon.svg`，通过 `npx tauri icon branding/neo-windows-diamond-icon.svg` 生成多尺寸图标。
- 原生应用菜单提供“卸载 Neo Desktop…”入口，进入工作台后仍可访问；确认后启动同目录官方卸载器并退出壳。开发目录没有卸载器时不会删除文件。
- 卸载只移除程序，保留用户选择的数据目录（运行时、会话、工作区、日志和私有 npm 缓存）。不提供隐式删除数据操作。

## Node/npm 隔离边界

- 安装和启动直接执行内置 `node.exe`，npm 使用内置 `npm-cli.js`；不调用宿主 npm 安装桌面依赖。
- 子进程过滤继承的 npm、Node、nvm、Corepack、Volta 等注入变量，使用数据根目录下 `.neo-node/` 的独立配置、缓存、全局 prefix 和 node-gyp 缓存。
- 安装阶段 PATH 仅包含内置 Node 与 Windows 系统工具；运行阶段保留宿主开发工具路径，但内置 Node 优先。安装工作目录的受控 `.npmrc` 阻止祖先项目配置干扰。
- 不修改注册表 PATH、系统 Node/nvm、用户 `.npmrc` 或全局 npm 包。目录预检拒绝宿主 Node/nvm 目录、危险路径和无法识别的已有运行时目录。
- 这是依赖管理隔离，不是安全沙箱：core 调用用户开发工具、工作区脚本或任意终端命令时仍具有当前用户权限，用户项目自己的 `.npmrc` 也仍可生效。

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
- 正式发布前应增加 Authenticode 签名和升级/回滚策略。

## 桌面文件下载通道

`src-tauri/src/downloads.rs` 是独立的 WebView 下载适配器，主入口仅负责注册。它不引用下载插件、插件路由或前端业务代码，不新增页面可调用的文件写入 IPC。

- 普通下载链接或 attachment 响应触发 WebView2 原生下载；传输、会话认证、重定向等由 WebView2 处理，不通过 Rust 二次请求。
- 下载前弹出“保存下载文件”，默认使用系统下载目录；用户选择最终位置，取消则拒绝此次下载。
- 清理建议文件名中的非法字符及保留名称，网页不能指定最终本地路径。
- 完成或失败显示原生提示，不记录带令牌的下载 URL，不自动执行下载文件、不启动外部浏览器。
- 当前使用 Tauri Requested/Finished 生命周期，无字节进度、持久化下载队列、断点续传或进行中取消 UI。退出应用可能中断下载；托盘模式保留 WebView。
- 普通网页导航、非下载型新窗口链接并不自动转为下载。失效链接返回的 HTTP 错误仍由现有服务/页面处理。

## 启动页与后台控制

Neo Desktop 菜单可“返回启动页”，保留后台进程，手动返回后不会自动跳回工作台。启动页提供“启动核心和后台”“关闭核心和后台”“进入应用”；启动操作不导航，关闭操作需确认。这里的核心与后台是托管的 Web 服务及其嵌入 Core，一起启动或停止。进入应用命令由后端核验托管进程状态，后台关闭时拒绝进入。运行中禁止重装，返回同一运行环境复用已有进程。全新双击启动仍沿用已安装版本自动启动逻辑。

## 窗口与托盘

主程序使用 Windows GUI 子系统，双击不分配控制台。关闭窗口时可选择“最小化到托盘”“退出应用”或“取消”。托盘模式保留后台服务，左键托盘图标恢复窗口，右键菜单提供打开与退出。退出会停止托管服务及其任务；没有默认记住选择。

## 检查更新

原生 Neo Desktop 菜单提供 Core / Web 版本检查；直接读取国内 npm 镜像 latest 元数据，与已安装版本按 semver 比较。仅检查，不下载或替换依赖，不检查桌面壳更新。支持未安装、请求失败和超时提示，Core 适配版本仍以 Web 声明为准。
