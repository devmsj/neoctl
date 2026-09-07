# OBS-03 终端数据链交付（兼容 OBS-05）

2026-09-07，Windows。数据链已实现并定向验证；不据此把 OBS-03/05 的 Web/UI 整项标为完成。未提交，未修改 CSV。未修改 index.ts、App.vue、query/run-agent/agents；保留其他代理工作区修改。

## 文件与根因

真实入口不是 engine/src/tools/exec-process-manager.ts，而是：

- `engine/src/tools/builtins/exec-process-manager.ts`：唯一 `publishSafeOutput` 分流到已有 TerminalOutputStore；每流独立 streaming redactor、UTF-8 字节游标；drain 增量范围/缺口；live 快照标记；owner 注册/隔离读取；真实退出事实、64 槽位淘汰、完成 TTL sweep。
- `engine/src/tools/builtins/exec-tool.ts`：从可信 `context.session.sessionId/sessionDir` 传 owner/目录；透传新结果及事件字段，不改变工具名/schema/调用独立性。
- `engine/src/tools/terminal-output-store.ts`：经主代理释放并允许后，仅增加 metadata `truncatedFields` 类型、校验和 DTO 复制。仍唯一 store，没有第二套存储或历史全集。
- `engine/src/tools/smoke-terminal-output-chain.ts`：新增真实进程集成 smoke。
- `engine/src/tools/smoke-exec-process.ts`：超时测试不再要求伪造 null exit，允许真实 backend exit code 并验证跨轮询稳定。

旧链 stdout/stderr 共用 redactor，会把 carry 归到另一流；drain 先收原始输出，而 SSE 从脱敏分支输出；缺少能区别累计快照与增量的契约。新链所有输出窗口/store/事件都来自每流 redactor 完成的增量与最终 flush。保留既有 CRLF/CR -> LF 行为，修正跨 chunk CRLF 变双换行；空行/缩进不折叠。TTY 只有真实合流 stdout，不伪造 stderr 分离或全局跨流顺序。

## Web 可直接使用的最终同步 API

```ts
new ExecProcessManager({
  sessionsRoot?: string, // 可信总会话根；建议 runtime 显式传入
  maxProcesses?: number, // 原有默认全局 64，不按 owner 新增槽位策略
  completedRetentionMs?: number, // 原有兼容配置，生产默认 300000
  outputStore?: TerminalOutputStore, // 已由 host 独占管理的唯一 store 可注入；默认不必传
});

manager.registerOwnerSession(ownerSessionId, actualSessionDir)
// StoreResult<{ records: RunView[]; rejected: number }>
manager.listHistory(ownerSessionId, { offset?: number, limit?: number })
// StoreResult<{ records: RunView[]; nextOffset: number | null }>
manager.readOutput(ownerSessionId, runId, { stream, offset?: number, limitBytes?: number })
// StoreResult<OutputPage>
manager.list(ownerSessionId)
// 当前内存任务，owner 隔离；无参数 list() 仅为可信旧内部调用保留
manager.sweepOutput()
// 安全清理已注册 store；完成清理定时器也调用；读取本身检查 TTL，不依赖定时器授权
```

`StoreResult/RunView/OutputPage` 可从 manager 类型重导出或原 store 导入。注册/历史/读出没有新增另一套契约。默认不传 sessionsRoot 时按真实 sessionDir 父目录建 store，以兼容旧 runtime；显式总 root 时支持 nested resolver。每个 manager 同一 root 复用一份 store，不与另一个 manager 并发写同一 root。注入 store 时其 resolver 也必须能解析实际 child 目录。

注册必须用 runtime 实际会话路径，不从 HTTP 参数拼路径。相同 owner 不能改绑目录，Windows 大小写路径别名不能跨 owner 共用。重复注册同一实例不会把现存 running 标为 lost：store restore 对已加载 runId 跳过。真实运行时重复注册三次已测试。新 store 恢复残留 running 才标 lost，exit=null，不伪造终态或恢复输出期限。

已只读核实子代理：`run-agent.ts:createChildAgentSession` 以父 `sessionDir/subagents` 为 root，agentId 为 child sessionId；传给工具的是 `childSession.sessionId/sessionDir`，不是主会话 owner，不是顶层 root/agentId。无 sessionDir 的旧调用仍执行，output_ref 明确 unavailable，不能猜目录补持久化。

HTTP 已由主代理接 `GET /api/terminal-output?sessionId=<owner>&runId=<id>&stream=stdout|stderr&offset=<bytes>&limitBytes=65536`。建议 unwrap 成 `{sessionId,runId,...OutputPage}`，失败独立显示 reason，不改变原进程成功/失败。响应二次 registry 脱敏不重算存储游标；UI 必须按 nextOffset 前进，不能按最终文字长度计算地址。

## 数据语义

### drain/工具结果

所有旧字段保留。新增：

- `owner_session_id`, `started_at`, `finished_at`（未终态 null）。
- `output_kind: 'incremental'`, `output_cursor_unit: 'utf8_bytes'`。
- `stream_mode: 'separate' | 'tty_merged'`。
- `output_ranges.stdout/stderr = {start,end,retained:[{start,end}],gaps:[{start,end}],truncated}`。每流脱敏后独立字节地址，start/end 为本次 drain 消费范围；预览省略 marker 不计入字节范围。重复空 drain 的 start=end，不重复全文。
- `output_ref = {owner_session_id,run_id,availability,reason?,persistence?,truncated?,byte_limit?,expires_at?,streams?}`。只含引用和计数，不含全文；available/expired/evicted/lost/io-error 原 store 状态，无 owner/启动失败为 unavailable。

`output_chars/omitted_chars` 继续按本次 drain 的 UTF-16 字符计数（现在统计已脱敏文本），不是全 run 原始 bytes。预览截断和 store 的 64MiB 截断相互独立，不能混用。

### live/event

`list(owner)` 新增 owner/started_at/finished_at/exit_code/signal/output_ref，`output_kind:'snapshot'`、`output_cursor_unit:'utf16_code_units'`、output_truncated、stream_mode。

旧 `output/outputEnd` 是有界混合展示快照/字符位置（stderr 有展示前缀），不得作为全文源。outputSubscriber 继续提供兼容 text/outputStart/outputEnd，同时新增 `streamText/streamStart/streamEnd/cursorUnit:'utf8_bytes'/ownerSessionId/outputKind:'incremental'/streamMode`。streamText 才是该流正文；不同流不声明全局顺序。

### 退出与生命周期

自然非 0 仍兼容 `status:'exited'`，但 `exit_code!=0, termination_reason:'failed'`，不得当成功。主动终止/超时保留 backend 实际 exit/signal（Windows taskkill 实测 exit_code=1），不再抹成 null；用户请求的 termination_reason 独立保留。duration 在终态后固定。

终态历史仅使用 `record.exit.status/exitCode/signal/terminationReason/durationMs/finishedAt`；启动时 `metadata.status` 不能用于终态显示。`lifecycle:'lost'` 单独显示；输出 text:null 为不可获取，不是空白成功。

输出单 run stdout+stderr 合计默认 64MiB，超限明确 truncated 与 observedBytes/storedBytes；终态后 300000ms 过期，64 槽位先淘汰可提前 revoke，退出事实跟会话保留。完成 timer sweep、显式 sweep 和读时 TTL 检查都安全；刷新过期输出也由 store restore 清理。没有将全文另塞 transcript 或状态快照规避期限。

### metadata 限制

manager 将已脱敏 command/cwd/shell/description 裁剪为完整 UTF-8 前缀，分别 <=4096/2048/256/2048 bytes；`metadata.truncatedFields` 明确列出裁剪字段，缺省不含该字段。工具原始调用及 manager 当前命令不由 metadata 预览反推。store 校验字段数组，DTO/恢复复制该标记。超长命令仍创建 run 并保留历史；真实中文长命令、emoji 长 description、重启读回标记已通过。

## 实际验证

均在本机 Windows engine 目录运行（2026-09-07）：

- `npm run typecheck`：终端改动后此前多轮通过。最后复验被并行新增 `src/web/agent-content-detail.test.ts:17` 的 `Parameters<typeof test>[1]` 越界/never 阻塞（后续 TestContext 相关报错）；终端文件无诊断。已通知主代理，未越界修改该测试。不能把最终全仓状态报为通过。
- `npx tsx src/tools/smoke-terminal-output-chain.ts`：13 组通过。覆盖长输出分流、空行缩进 Unicode、连续 drain/空 drain、UTF-8 四字节分页/重复读不重复、跨 chunk 双流秘密/flush/emoji、CRLF 边界、0/7/kill、跨 owner history/read/live/control、nested child、同实例 running 重复注册、刷新终态输出/事实、lost、注入 17B 小预算、slot evict、精确 TTL、文件丢失/不可建目录不改进程结果、metadata 裁剪及刷新、真实 PTY、65 个真实进程验证默认全局 64 槽位。
- `npx tsx --test src/tools/terminal-output-store.test.ts`：20 tests，19 pass，0 fail，1 skip（Windows 文件 symlink 权限不足；真实 junction/hardlink 测试通过）。在 truncatedFields 扩展后重跑通过。
- `npm run smoke:exec`：13 checks 全通过，包含 timeout/interrupt/terminate/kill、真实 PTY 和连续 drain。
- `npm run smoke:secrets`：通过，含 exec 和 splitChunkRedaction。
- `npm run smoke:tools`：通过，含 exec 成功/失败/交互工具协议。
- `git diff --check`：通过。
- `npm run smoke:web-terminal-tasks`：本次失败，主代理新增 history 期间旧 Web 测试夹具缺 `terminalTaskHistory` 方法，`WebRepl.snapshot` index.ts:875 报 TypeError。已通知主代理，不修改越界文件，不将本项伪报通过。

首次 smoke:exec 的旧 timeout-null 断言失败已解释并修正：它与“保留真实退出码”冲突。复跑全部通过。

剩余整项门槛属主代理 Web/UI 集成：history 夹具修复、两模态读取/复制/下载、中央调用保持独立、打开终态详情不关闭、刷新/切 owner/迟到响应不串用、完整浏览器验收。此文件不将未运行的 HTTP/UI 测试报为通过。
