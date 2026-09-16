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

1. 安装包内包含 Windows Node.js 和 npm；构建仍生成并携带 `neoctl-web.tgz`，但默认首次安装不使用该快照。
2. 首次启动允许选择运行数据位置。
3. 将内置 Node.js 与 npm 释放到临时目录，首次安装需联网获取 Web 和 Core。
4. 临时 `package.json` 声明 `neoctl-web: "latest"`，使用 `https://registry.npmmirror.com` 执行 nested 策略的 `npm install --omit=dev`；npm 按最新 Web 的依赖声明解析兼容 Core，而非单独安装 Core latest。
5. 安装输出通过 Tauri event 实时显示，并映射为阶段进度。
6. 安装成功后原子替换 `runtime/`，失败不破坏已有版本。
7. 启动 `neoctl-web/server.mjs`，等待本地 HTTP 健康检查后在当前窗口进入工作台。
8. 服务只监听 `127.0.0.1`，窗口关闭时终止托管的 Node 进程。
9. 后续双击启动会读取安装记录并自动进入已安装工作台。
10. 从菜单返回启动页并关闭后台后，仍可在线更新 latest Web 及其兼容 Core，继续使用临时目录、原子替换和失败回滚。首次安装与更新均以 registry 的 latest Web 为准，不受桌面构建时 payload 版本限制；网络失败会报错，不会静默回退到内置快照。

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

## 目录容错

首次启动可直接“安装并启动”，目录编辑收在“更改目录”。安装前实测目录创建、写入、读取、重命名和删除；首次安装的安全目录不可写时，尝试 LocalAppData、AppData、用户目录下的 `Neo Desktop Data`，不使用临时目录保存长期数据。成功后以实际目录启动。

已有配置或数据不自动迁移；危险路径、无法确认数据状态的目录不会绕过检查。桌面配置文件不可写会在下载前报错。简短结果显示在界面，详细原因保留在日志。

## 安装回归测试

测试文件统一位于 `tests/`：`scripts/` 保存来源/更新检查和后端按钮测试，`ui/` 保存启动页单元测试与浏览器布局测试，`smoke/` 保存真实安装/启动检查，`rust/` 保存外置 Rust 单元测试。`ui/` 只包含随 Tauri 打包的前端资源，不包含测试。

在仓库根目录运行默认非浏览器回归测试（不访问网络、不调用模型；更新检查使用已准备好的 `desktop/resources/node` 内置 npm 的 semver）。来源回归同时检查构建不再读取或生成远程控制配置、启动不再注入远程控制配置，以及本机后台启停、托盘和更新入口仍然保留：

```powershell
npm --prefix desktop test
# 等价于：
node --test desktop/tests/ui/app.test.cjs desktop/tests/scripts/runtime-source.test.cjs desktop/tests/scripts/check-updates.test.cjs
npm --prefix desktop run check
```

浏览器和 Rust 测试独立运行，不包含在默认 `npm test` 中：

```powershell
npm --prefix desktop run test:browser
npm --prefix desktop run test:rust -- --locked
```

浏览器入口依次运行 `tests/ui/browser.test.cjs`（Windows Edge，可用 `EDGE_PATH` 指定路径，需要支持全局 WebSocket 的 Node）和 `tests/scripts/backend-ui.test.cjs`（还需要 `desktop/.cache/ui-test/node_modules/playwright` 及 Edge），不会自动安装依赖。也可以直接运行其中一个文件。Rust 入口需要 Rust/MSVC/Tauri 构建依赖；Windows Node 隔离测试还需要内置 Node/npm。`tests/rust/node_isolation_tests.rs` 由原 `node_isolation` 模块通过 `#[path]` 引入，仍是受 `cfg(all(test, windows))` 控制、可访问父模块私有成员的单元测试，不是 Cargo 集成测试。其他内联 Rust 单元测试保留在原模块。

`npm --prefix desktop run smoke:runtime` 依次执行下面的安装与启动 smoke。它会访问 npm registry、安装真实运行时并启动本地 Web/Core，仅在需要集成验证时显式运行，不属于默认测试。

在仓库根目录运行 `node desktop/tests/smoke/smoke-runtime-install.mjs` 可实际安装 registry latest Web 及其兼容 Core，并用内置 npm 的 semver 检查 Core 满足 Web 的依赖范围。仅验证内置快照时显式传入 `--bundled`；该模式不代表桌面默认安装行为。Smoke 使用临时目录并写入 `desktop/.smoke-runtime-path` 供启动测试使用，需要已准备好的内置 Node/npm；bundled 模式还需要 payload。

## 本地桌面调试（无需发布）

首次调试先确保 `desktop/resources/node` 已准备好（没有时执行一次 `npm run runtime`），然后运行：

```powershell
cd desktop
npm run dev:local
```

该命令会构建当前仓库的 `engine/`，分别对本地 Engine 与 Web 源码执行 `npm pack`，安装到 `desktop/.cache/dev-runtime` 的隔离运行时，再启动 Tauri 调试窗口。整个过程不发布 npm 包、不覆盖正式桌面的安装配置，也不复用正式数据目录；关闭调试窗口或按 `Ctrl+C` 会结束本次调试实例。源码修改后重新执行命令即可看到最新效果。

## 注意

- `resources/node` 与生成的 tgz 被 `.gitignore` 排除，避免把大型构建资源提交进源码。
- 当前 Node 固定为 22.12.0，可通过 `prepare-node-runtime.ps1 -NodeVersion <version>` 调整。
- `neoctl-web` 自身声明兼容的 `neoctl` 版本范围，桌面壳不单独追踪 core latest。
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

Neo Desktop 菜单可“返回启动页”，保留后台进程，手动返回后不会自动跳回工作台。启动页提供“更新 Web 和 Core”“启动核心和后台”“关闭核心和后台”“进入应用”；启动操作不导航，关闭操作需确认。这里的核心与后台是托管的 Web 服务及其嵌入 Core，一起启动或停止。进入应用命令由后端核验托管进程状态，后台关闭时拒绝进入。运行中禁止重装或更新；关闭后台后，更新按钮从国内镜像安装 latest Web 及其声明范围内的 Core。返回同一运行环境复用已有进程。全新双击启动仍沿用已安装版本自动启动逻辑。

## 窗口与托盘

主程序使用 Windows GUI 子系统，双击不分配控制台。关闭窗口时可选择“最小化到托盘”“退出应用”或“取消”。托盘模式保留后台服务，左键托盘图标恢复窗口，右键菜单提供打开与退出。退出会停止托管服务及其任务；没有默认记住选择。

## 检查更新

原生 Neo Desktop 菜单提供 Core / Web 版本检查；读取国内 npm 镜像的 latest Web 元数据，并从已发布 Core 中选择满足该 Web 依赖范围的最高版本，与已安装版本按 semver 比较。弹窗只展示检查结果并提示“请返回启动页更新”；实际更新在启动页执行，不检查或更新桌面壳本身。支持未安装、请求失败和超时提示。
