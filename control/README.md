# Neo Control

Desktop 的受信远控端：管理注册设备与心跳、保存多份 Web 模型配置、广播或定向下发配置，以及收集会话增量。管理端可复用 neoctl-web 的 Vue/Markdown 能力只读查看上报内容，不会执行会话中的工具调用。

> 自动注册实现（2026-09-05）：定制客户端内置控制配置，替代外部配对文件；Web 先加密注册再同步。本文不代表目标主机已部署，部署状态应以独立验证结果为准。现有同步范围和模型表单语义不变。

## 启动

需要 Node.js 20+。服务端使用 Node 内置模块，无第三方运行依赖。会话查看器构建需要先安装 `web` 的依赖。

```powershell
# 仓库根目录
npm --prefix web ci
node control/scripts/build-viewer.mjs
$env:CONTROL_ADMIN_TOKEN = (node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))")
# 请将上面生成的 token 保存到密码管理器；登录管理页时需要它。
$env:CONTROL_DATA_DIR = 'C:\NeoControlData'
node control/server.mjs
```

默认地址 `http://127.0.0.1:8787`，通过 `CONTROL_HOST` / `CONTROL_PORT` 修改监听地址。推荐对外部署使用 HTTPS 反向代理（本次个人设备 HTTP 部署及 SSH 管理隧道见 `DEPLOYMENT.md`），并设置 `CONTROL_PUBLIC_ORIGIN` 为管理页的完整源（例如 `https://control.example.com`，不带路径），用于同源校验；反向代理保留该 Host。限制管理端访问范围，不要通过公开明文 HTTP 输入管理 token。

管理端输入管理员 token 后：

1. 在私有服务端配置中同时设置 `CONTROL_AUTO_ENROLL=true` 和 `CONTROL_SHARED_DEVICE_KEY`，并在启动 Control 时加载；共享 key 必须是随机 32 字节的标准 base64 编码。程序化启动对应 `options.autoEnroll: true` 和 `options.sharedDeviceKey`。自动注册默认关闭，仅设置共享 key 不启用 `/enroll`；启用时必须有合法共享 key。
2. 向已授权管理的设备分发定制 EXE：内置 Control URL/IP、是否允许 HTTP 及同一应用级共享设备 key，由 Rust 主 agent 处理并传给受管 Web。每台安装自行持久化随机 UUID `deviceId`，先注册再同步，无需管理员预创建设备或外部配对文件；不要复制设备身份数据目录。管理员 token 和 SSH 凭据绝不能内置进 EXE。
3. 在模型配置中创建存档。存档对应 Web「模型配置」表单：

   ```json
   {
     "provider": "openai",
     "values": {
       "apiKey": "YOUR_API_KEY",
       "baseUrl": "https://api.openai.com/v1",
       "model": "gpt-5.6",
       "endpoint": "responses"
     }
   }
   ```

   其他允许字段包括 `reasoningEffort`、`reasoningSummary`、`maxOutputTokens`、`timeoutMs`、`streamIdleTimeoutMs`、`maxRetries`。存档是完整表单，不是任意环境变量或远程脚本。
4. 选择一个存档广播，或选择“不广播”；也可勾选一个/多个客户端定向下发。客户端处理成功后确认命令；暂时掉线时保持待投递状态。
5. 在设备列表查看 IP、机器码、设备型号、在线状态并编辑备注。在会话列表打开只读查看器。

## 内置配置与自动注册

- 取消 `control-pairing.json`、外置 `control/pairing.json` 资源及 `NEO_DESKTOP_CONTROL_FILE` 的配对入口；定制 EXE 不再导出含 key 的配对文件。Rust 主 agent 在启动受管 Web 时传入一次性的 `NEO_DESKTOP_CONTROL_CONFIG` 环境变量，JSON 仅含 `{enabled,url,allowHttp,key}`，不含预分配的 `deviceId`。
- Web 在启动最早阶段接收并删除该环境变量，配置仅在进程内存保留；须早于运行时初始化及派生工具/子进程，不能把原始 JSON、key 或环境变量值写入日志、诊断、模型上下文或继续传给子进程。删除环境变量用于减少继承泄漏，不等于安全擦除内存。
- 无配置的普通 Web 保持关闭；`enabled` 不为 `true` 或配置无效也不得自动注册/同步，更不能回退读取旧配对文件。非本机明文 HTTP 必须显式设置 `allowHttp: true`，推荐 HTTPS。
- Web 启动器将 `NEO_WEB_DATA_DIR` 对应的数据目录（未设时为 Web 默认目录）传给同步器的 `options.dataDir`；直接调用同步器而未传有效数据目录时保持关闭。其中 `control-device.json` 只保存持久随机 UUID，例如 `{ "deviceId": "<随机 UUID>" }`，不保存 key、URL 或整份配置。机器码为 UUID 派生哈希，属于身份元数据，不是硬件证明或认证凭据。游标/命令确认仍按现有同步状态机制持久化，不在该身份文件中重置它们。
- 首次运行及进程重启先 `POST /enroll`，验证加密确认后才开始 `/sync`。使用共享 key 的 AES-256-GCM `up` 加密 `{requestId,sentAt,kind:'enroll',device:identity}`，请求外层为 `{deviceId,envelope}`；响应外层 `{envelope}`，`down` 解密为 `{requestId,deviceId,kind:'enrolled'}`。客户端核对 requestId、deviceId、kind，注册不携带管理员凭据。完整加密/重放约定见 `IMPLEMENTATION.md`。
- 注册和同步在后台静默运行，不弹窗、不写聊天消息；失败采用有上限的退避、请求超时及单个在途请求，不能无限紧密重试。失败不得推进游标、假确认命令或为了重试换一个 deviceId。
- 相同 ID 的重复注册是幂等确认，不重置备注、创建时间、命令、确认状态、会话或同步状态。真正的新设备继承当前广播，随后通过同步应用并确认配置。
- 管理端删除设备时须持久化撤销该 ID；服务重启后，同 ID 的 `/enroll` 和 `/sync` 仍被拒绝，历史会话保留。停止自动注册不等于撤销已注册设备，也不自动停止其同步。
- `/enroll` 必须执行设备数/状态/请求体/并发等配额、基于 socket IP 的尝试及失败限速，拒绝过期请求；注册在时间窗内为幂等确认（含相同 requestId），不改变现有记录，`/sync` 独立持久拒绝重复 requestId；失败也计入防滥用限制，不能靠创建新 ID 绕过 IP 限速。现有同步配额不放宽。共享 key 只授权设备协议，所有 `/api/*` 仍独立要求 `CONTROL_ADMIN_TOKEN`，不得以设备 key 代替管理员鉴权。

## 共享密钥模式与限制

`CONTROL_SHARED_DEVICE_KEY` 是应用级 32-byte base64 共享设备 key，不是管理员 token、SSH 密码/私钥或模型 API key。Control 与定制 EXE 必须使用同一值；真实 key 仅进入受限部署/私有构建流程，不写入仓库或本文。现有服务端共享模式启动时会迁移已有设备的 key，保留其 ID、命令和历史；未设置共享 key 的旧管理创建设备模式仍使用每设备随机 key，但不是新定制 EXE 的自动注册流程。移除共享 key 环境变量不会自动轮换已有设备密钥。

**EXE 内置 key 可被提取**，运行时内存及启动环境也不是防提取安全边界；不得承诺混淆或删除环境变量能保密。共享 key 不提供设备间密码学隔离：持有者可以冒用已知的其他设备 ID，AAD 绑定 ID/方向只能防止直接改包，不能阻止持 key 者重新加密伪造请求。不要公开分发此定制包。

**撤销仅限 ID**：撤销一个 ID 不会收回共享 key，也不能阻止持 key 者生成新 UUID 再注册。配额和限速只是降低滥用，不是硬件身份认证。泄露时需轮换服务端共享 key 并更新所有定制应用/设备；旧 EXE 内置值不会自动更新。仅删除本地 `control-device.json` 会丢失身份并可能创建新 ID，不是可靠的停用或撤销方式。

## 数据与加密边界

- 无内置配置时默认不启用上报，自动注册服务端也默认关闭。定制 EXE 自动注册仅应用于已授权管理的设备，启用后包含该 Desktop 工作区注册表登记的已有和新增会话（不扫描上传未登记的 CLI 会话），请事先告知使用者并取得相应授权。
- Desktop 受管 Web 与 Control 分别是应用层加密的两个端点。新机制使用应用级共享 256 位设备 key，AES-256-GCM 双向认证加密，方向与设备 ID 通过 AAD 绑定，但不提供持 key 设备间的隔离。HTTPS 用于额外保护路由元信息及管理员访问。
- **Control 能解密内容**，这是服务端收集/展示会话的必要前提；不是“连 Control 也无法读取”的浏览器端加密方案。模型 API 密钥与会话可能包含敏感内容，不应部署在不可信服务器。
- 不再落地含 key 的外部配对文件；定制 EXE、私有构建输入、服务端环境和 Control 数据目录仍包含秘密。限制操作系统 ACL，使用磁盘加密和加密备份；客户端模型配置的现有持久化语义不变。应用层传输加密不等于静态数据加密；管理员访问应使用 HTTPS 或受保护的 SSH 隧道。
- 设备身份用于管理，不是硬件可信证明；IP 可能是代理/NAT 地址，机器码也不是认证凭证。认证依靠共享设备 key 和服务端对 deviceId 的准入/撤销检查；删除只阻止被撤销 ID，不阻止持 key 者冒用其他有效 ID 或注册新 ID。

## 增量语义

- 上报 `transcript.jsonl` 的新增字节，不在每次心跳发送完整历史。持久化游标仅在 Control 确认后推进。
- 网络超时可能导致未确认的数据再次发送；Control 以会话、文件及字节位置幂等处理，避免重复落盘。分布式网络不能保证物理传输绝不重复。
- 这里的实时指已持久化会话记录的秒级同步。模型尚未形成持久化消息的逐 token 流不在 JSONL 中，不能将其误称为 token 级直播。
- 查看器只读解析原生会话记录，包含文本、工具记录及压缩标记。不向 Control 启动的 agent 注入历史、不自动执行工具、不自动访问外部图片或资源。附件和外部大工具结果文件不在本版上传范围内，引用可能无法打开。
- 停止广播不回滚已经生效的模型配置；删除存档会取消其广播，但此前定向下发的独立配置快照仍保留待投递。撤销设备 ID 也不撤回已经上传的历史数据。配置下发失败在 Desktop 不弹窗，管理员可依据确认状态排查。
- 每个数据目录只运行一个 Control 进程，不支持多个实例共享目录。默认单会话文件上限 16 MiB、会话总量 1 GiB；达到配额会拒绝新增字节，不应把本实现视为无限容量的归档服务。请监控磁盘并规划保留/备份策略。
- 同步请求时间戳允许约 2 分钟时钟偏差；请让客户端与服务端保持时间同步。默认每台设备每分钟最多 120 次同步，避免将轮询间隔调得过小。

## 验证

```powershell
node --test control/test/*.test.mjs web/control-sync.test.mjs web/control-transcript.test.mjs
node control/scripts/build-viewer.mjs
```

以上是现有测试/查看器构建命令，不代表已覆盖新机制。部署前还须验证：真实 Windows 定制 EXE 内置配置、环境变量最早消费并删除且不传子进程、普通 Web 无配置关闭、身份文件无 key、先注册后同步、重复注册保留命令状态、新设备继承广播、删除后跨重启拒绝同 ID、注册失败/IP 限速及配额、设备 key 无法调用管理员 API，以及 HTTPS 反向代理、网络中断恢复和多个活动会话配置热更新。
