# OBS-07 / OBS-11 独立数据准备（非整项完成）

日期：2026-09-07。前置 OBS-04 UI 未完成，本记录不标记任何 issue 整项完成，不改 CSV，不提交。

## 范围与结论

已改授权文件：
- `engine/src/agents/local-agent-task.ts`
- `engine/src/agents/agent-tool.ts`（保留 OBS-04 两个 runAgent 调用点的 runGeneration）
- `engine/src/tasks/task-store.ts`（主代理追加授权）
- 专属测试 `engine/src/agents/obs07-11-run-facts.test.ts` 与本记录。

主代理已追加授权并完成 `engine/src/tasks/task-persistence.ts` 与 `engine/src/tasks/subagent-tools.test.ts`。显式 DTO 白名单已映射 current/history startedAt、durationMs、visibleText，实际刷新测试通过；旧测试改为真实 prepareResume 链而不放松生产终态冻结。独立数据准备范围已完成，OBS-07/11 整项仍未完成（UI/reader 等不在本代理范围）。

## 根因与实现

1. TaskStore.markRunning 原来只改 status；创建时间不等于本轮开始。现在只允许 pending → running，设置本轮真实 UTC ISO startedAt；重复调用不重置时钟，终态调用不得偷偷续跑。可选 generation 参数用于迟到回调守卫。
2. complete/fail/kill 首次终态冻结 completedAt 和 durationMs；durationMs 来自本轮 startedAt 与终止时间之差，不采用 createdAt 或 runner 的 total_duration_ms。缺失、非标准 UTC ISO、Date.parse 自动纠正的非法日期、逆序及非安全整数保持未知。零合法。
3. prepareResume 先归档前轮 startedAt/completedAt/durationMs 和 result/status/error，再清 startedAt/completedAt/durationMs/result/error 并进入 pending；新轮 markRunning 才计时。slice(-8) 不变。更新代际状态后再取消旧 controller，避免同步 abort 回调写入新轮。
4. TaskStore 的 complete/fail/kill 可传捕获的 runGeneration；旧代终态回调 no-op，不修改新代 abortController。重复终态不移动终止时间。明确匹配 generation 的同状态 failed/killed 可在 result 尚缺失时补充 partial，不更改状态、原因或冻结时间；已存在报告不覆盖。
5. agent-tool sync/background/resume 在完成、失败、停止和 catch 上传捕获 generation。停止后仅消费该代 runner 的收尾以获取 finalization，不继续写进度或上下文；跨代丢弃。保留原 prompt、resume directive、pending 消息行为及 transcript generation。
6. partial 来源只能是 runner 本轮新 messages 中成功的指定 report tool output.report，或 OBS-04 标记 displayChannel=visible 的 assistant text；不复制 runner 更宽的旧 unmarked text fallback，不读 progress.lastText，不读 thinking 或隐藏通道，不用 output.txt。TaskStore 持久 result.status 固定 incomplete，task.status 独立为 failed/killed。
7. 同步失败返回的顶层 status 固定 failed/cancelled，不被 result.status spread 覆盖；报告完整性另传 report_status。AgentToolRuntime 增加可选 runAgent adapter 供模拟 runner 测试，默认仍原生产 runAgent。

## Web 投影精确契约

新增类型字段（本轮、每条历史归档各两项）：

| 对象 | 字段 | 类型 | 语义 |
| --- | --- | --- | --- |
| LocalAgentTask | startedAt | string 或缺失 | 本轮 markRunning 产生的 UTC ISO 时间，不是创建时间 |
| LocalAgentTask | durationMs | number 或缺失 | 首次终态冻结的本轮毫秒数，运行中不保存累计计数 |
| AgentRunArchive / runHistory[] | startedAt | string 或缺失 | 被归档轮次真实开始 |
| AgentRunArchive / runHistory[] | durationMs | number 或缺失 | 被归档轮次冻结毫秒数 |

复用字段：`completedAt` 是该轮终态时间；`runGeneration` 是真实轮次身份；`result.content` 是该轮报告；失败/停止允许 partial 的 `result.status === 'incomplete'`，不是任务成功完成。无允许正文时 result 缺失；不要用 lastText 兜底。

导出纯函数 `agentRunDurationMs(run, nowMs = Date.now()): number | undefined`：running 从 startedAt 算当前耗时；pending 未提供；终态只有合法 startedAt/completedAt 且 durationMs 与其差值一致才返回冻结值。缺少冻结字段的旧记录即使有时间也不补算，页面刷新不可按当前时间补终态 duration。持久化恢复把进程中断标 killed 时，只知道发现中断，不知道实际停止时间；completedAt 与 durationMs 均保持未知，startedAt 保留实录。刷新两次及再续跑均有真实测试。

Web reader 仍需按已授权所属会话 + taskId + requested runGeneration 选择 current 或 runHistory，执行脱敏及完整/不可获取语义；不能接受任意文件路径。output.txt 仍是稳定的当前任务派生文本，不是指定轮次全文来源。保留最多8条历史，淘汰轮次不可伪造全文。UI/GET reader/Markdown/复制下载/订阅接入未实施。

## 最终验证

- `npm --prefix engine run typecheck`：退出码0，新增测试全部 never 类型问题已解除，没有隐去测试。
- `npx --prefix engine tsx --test engine/src/agents/obs07-11-run-facts.test.ts engine/src/agents/agent-tool-persistence.test.ts engine/src/tasks/task-persistence.test.ts engine/src/tasks/subagent-tools.test.ts engine/src/tasks/task-ack-size.test.ts engine/src/core/obs04-visible-data.test.ts engine/src/core/run-agent-persistence.test.ts`：69项通过、0失败、0跳过，退出码0（其中专属25项）。
- 专项覆盖：真实 TaskStore 11轮 × completed/failed/killed 冻结及8轮保留；重复停止；旧代 completed/failed/killed/markRunning；同步 abort 回调重入；未知/非法/未来/逆序/零；12组 sync/async × failed/killed × report/visible/hidden 的模拟 runner + 真实 finalizeAgentTool；真实 runAgent + 模拟 gateway 跨代迟到及 transcript generation [1,2]；sync/async 三轮 failed → aborted → completed 的 partial 状态、归档及清理；真实 current/history timing/visibleText 刷新；损坏/未标记/跨代 preview DTO 拒绝；两次进程中断恢复不伪造 stop；恢复后续跑。
- `npx --prefix engine tsx engine/src/agents/smoke-agent-lifecycle.ts`：4组 PASS，包括旧代防覆盖、8轮保留及原续跑报告行为。
- 曾经刷新丢字段的失败已通过追加授权 DTO 修改修复；曾经 subagent-tools 直接重启终态的测试失败已改为 prepareResume + markRunning 真链路并通过。未降低任何生产保护。

所有本次写入 UTF-8 无 BOM、LF；无 Web/index/App/core/types/session 修改，无 CSV 状态修改，无提交。其他人的既有变更保留。

## 追加授权：OBS-04 实时安全预览

已实现 `AgentProgressSnapshot.visibleText?: { channel: "visible"; runGeneration: number; text: string; truncated: boolean }`。

- 只接 `assistant.delta` 且 `displayChannel === "visible"`，仅 running、显式正整数捕获 generation 匹配当前 task generation 时追加。
- 保留全部空白，仅保留末尾4000 UTF-16字符；截断后 truncated 保持 true。这是实时预览，不是报告、全文或新 transcript 存储。
- 不接未标记/analysis/隐藏文本，不从 lastText 或 mixed/final message 回填；最终 message 不重复追加。
- prepareResume 重建 progress 自然清空；旧代事件整个 no-op。agent-tool sync/async 两个事件更新点明确传捕获 generation。
- 不做 reader 最终秘密脱敏，主 index 仍需脱敏。已追加授权的 task-persistence progress allowlist 保存 visibleText，严格校验 channel、generation、text、truncated；刷新实时预览缺失时用 transcript resolver 读取允许正文，不以 lastText 兜底。
- 专项预览及 DTO 刷新测试均通过，never 类型错误全部修复；最终联合69项全通过。限定生产/既有测试文件 diff --check 通过。
