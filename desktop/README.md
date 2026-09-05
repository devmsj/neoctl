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

## 可选 Control 自动连接（编译期内置）

私有桌面 EXE 在编译时内置 Control 服务地址和共享设备密钥，启动后台时自动连接，不导入外部配对文件、不弹同意对话框。普通构建未指定配置时内置 `null`，不会注入 Control 配置或连接服务。旧 `data/control-pairing.json` 不再读取；也不能通过宿主环境覆盖内置配置。

`src-tauri/build.rs` 读取可选环境变量 `NEO_CONTROL_BUILD_CONFIG` 指向的私有 JSON，校验后序列化到 `OUT_DIR/control-config.json`，由 `include_str!` 编入 EXE。Cargo 跟踪环境变量和配置文件变化；移除变量会重新生成 `null`。运行时只向直接托管的 Node 注入 `NEO_DESKTOP_CONTROL_CONFIG` JSON，Node 读取后立即删除该环境变量，避免传给后续子进程。桌面不会将内置配置另写到数据目录。

私有 JSON 的字段格式（下列是不可直接构建的占位说明，不是真实凭据）：

```json
{"enabled":true,"url":"https://control.example.com","allowHttp":false,"key":"<服务端生成的32字节标准base64共享设备密钥>"}
```

- 仅接受 `enabled`、`url`、`allowHttp`、`key` 四个字段；`enabled` 必须为 `true`，`allowHttp` 可省略（默认 false）。拒绝 `root`、用户名、管理员密码等未知字段；`key` 必须为规范的 32 字节 base64 设备密钥，不能用登录密码替代。结构校验不能判断一串符合格式的密钥是否确为服务端授权密钥。
- URL 必须是 HTTP(S) origin（可含端口和末尾 `/`，不含用户名、密码、路径、查询或片段）。默认要求 HTTPS，仅 localhost、127.0.0.1、::1 允许 HTTP；远程 HTTP 必须显式 `allowHttp:true`。HTTP 即使使用消息体 AES-256-GCM，也不保护元信息或管理端 HTTP 登录，优先 HTTPS 或安全隧道。
- 配置限制 16 KiB；配置缺失、字段错误或无法读取会使指定配置的构建失败，错误不包含原始配置、密钥或解析输入。未指定环境变量才是普通禁用构建。

私有构建命令（先由管理员在忽略目录安全准备配置，不把密钥写到命令行）：

```powershell
cd desktop
$env:NEO_CONTROL_BUILD_CONFIG = (Resolve-Path .cache/control/build-config.json).Path
try {
  npm run build
} finally {
  Remove-Item Env:NEO_CONTROL_BUILD_CONFIG -ErrorAction SilentlyContinue
}
```

无需完整 EXE 的 Rust 验证：在 `desktop/src-tauri` 执行 `cargo test --lib --locked`。普通公开构建前清除 `NEO_CONTROL_BUILD_CONFIG`，建议使用干净独立构建目录，避免混淆私有制品与公共制品。不需要额外 Tauri resources 覆盖文件。

同步范围与行为：

- 只同步该桌面数据目录 `session-workspaces.json` 登记的会话；会话来源为 Engine 的 `AGENT_SESSION_DIR` 或默认 `~/.neoctl/sessions`。不会遍历未登记的 CLI 历史、任意工作区文件、上传图片或工具输出附件。登记表缺失/损坏时不上传会话。
- 自动连接后会补传登记的已有会话历史，并约每秒同步已持久化 `transcript.jsonl` 的新增字节；会发送机器标识、主机名和机型。不是逐 token 上传，积压和网络故障会延迟同步。
- 接收并应用 Control 下发的模型配置（包括 API 连接配置），沿用现有登录配置与活跃实例更新机制；不打断已发出的模型请求。请求/响应采用共享 AES-256-GCM 协议，认证响应确认后才推进游标。网络重试和诊断不应包含正文、密钥或原始错误。
- `control-sync-state.json` 保存确认游标和命令状态；`control-device.json` 保存机器标识。要停用或更换内置配置，使用无配置/新配置重新构建替换程序并重启后台；泄露时需在服务端撤销或轮换相应共享设备密钥。

**这是自动上传并允许远程应用模型配置的私有发行版。发布者必须事先获得设备使用者授权并明确告知同步范围。内置密钥可从 EXE、内存、构建输出或调试产物提取，不是安全密钥库；同一共享密钥制品泄露会影响使用该密钥的设备。严禁公开分发或上传公共制品库、npm、版本库及构建日志。** 私有 JSON 只放 `desktop/.cache/` 或仓库外受限目录；构建 `src-tauri/target/` 和拷贝制品 `desktop/artifacts/` 已被桌面 `.gitignore` 排除，但忽略不等于访问控制。不要把私有配置放入 payload 或 npm 包，也不要上传包含内置配置的构建缓存/符号文件。仓库根 `artifacts/` 不受该忽略规则保护。

## 检查更新

原生 Neo Desktop 菜单提供 Core / Web 版本检查；直接读取国内 npm 镜像 latest 元数据，与已安装版本按 semver 比较。仅检查，不下载或替换依赖，不检查桌面壳更新。支持未安装、请求失败和超时提示，Core 适配版本仍以 Web 声明为准。
