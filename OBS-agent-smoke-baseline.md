# Agent smoke：同环境基线对照与授权 fixture 修复

日期：2026-09-07。范围仅 `smoke-agents.ts`、`smoke-agent-lifecycle.ts`；全部使用脚本内合成 gateway/tool，没有调用真实模型，没有派生代理，未重跑已另有记录的 core-loop/historyImageDowngraded。

## 环境与基线完整性

- 当前仓库：`C:\Users\qyq\Desktop\work\neoctl`；HEAD 为 `d40cb8b67525b8646587480c43bce3854c153dca`，工作树原已有其他代理改动，未覆盖。
- 独立基线：`C:\Users\qyq\AppData\Local\Temp\neoctl-baseline-check-a828df043c204fbc8930f2ed4f93e812`，复用原目录，无 archive/覆盖操作。
- 运行前、内存对照后分别计算基线 169 个 tracked engine 文件的 Git blob SHA1，对照上述提交：均 `DIFFERENCES []`。
- 原有 `engine/node_modules` junction 指向当前仓库 `engine/node_modules`；Node `v22.12.0`。原始四次运行使用同一个捕获的继承环境，分别以各自 `engine` 为 cwd，顺序运行；不安装依赖、不调用 npm 生命周期。
- 原始两个 smoke 当前/基线字节完全相同，SHA256：
  - smoke-agents.ts：`770178336fc862d996079cc3b3b730b4640c004eafe357b82402e5b4c557647b`
  - smoke-agent-lifecycle.ts：`bc957765026911433fe598ad6df4374970388fb780c59909b0d72869709c2d0e`
- 原始每次执行前后监测 run-agent/query/query-engine/agent-tool/local-agent-task/messages 六个文件 SHA256，均未在该次运行内变化。随后检查发现另一代理继续修改了 query.ts；因此不宣称工作树在整个协作时间段被冻结。

## 原始命令与真实退出码（修复前）

分别在当前/基线 engine cwd 执行：

```text
node node_modules/tsx/dist/cli.mjs src/agents/smoke-agents.ts
node node_modules/tsx/dist/cli.mjs src/agents/smoke-agent-lifecycle.ts
```

通过 subprocess 的 returncode 独立记录每个 Node 退出码，不使用最后一个 PowerShell 成功命令覆盖测试失败。

| 原始测试 | 当前 exit / check | 基线 exit / check |
|---|---|---|
| smoke-agents | **1**，1.509s；`Timed out waiting for condition`，waitFor 原行376、main 原行234，等待 `Refined Delegate Smoke Title`；未到最终 JSON，不能把后续 check 记作 false/通过 | **0**，0.642s；下面14项布尔 check 全 true |
| smoke-agent-lifecycle | **1**，0.443s；原行64 `task.result?.content` 实际 `''`，预期 `'old-result'`；此前已执行的断言通过，四组 PASS 尚未输出 | **0**，0.600s；四组 PASS 完整 |

smoke-agents 全部14项布尔 check：`ok`, `syncOk`, `asyncOk`, `exploreToolsOk`, `exploreOk`, `missingReportOk`, `childProgressSemanticsOk`, `exploreReportOk`, `exploreDraftDidNotEndRun`, `exploreInheritedToolResultMemory`, `exploreNoProgressOnly`, `outputFileOk`, `childTranscriptOk`, `childSessionsHiddenFromList`。

基线附加事实：`afterInitialTitleCalls=3`、`afterRefinementTitleCalls=4`、`parentCalls=3`、`subagentCalls=10`、`reportRecoveryPrompts=1`、`forcedReportToolChoices=1`、`inheritedToolResultMemoryCalls=10`、`memoryCallsBeforeExplore=6`；sessionTitle 为 `Refined Delegate Smoke Title`，taskStatus 为 `completed`。

lifecycle 四组 PASS 原文：

```text
PASS running inbox reaches next fake-model request after paired tool results; terminal inbox retained/resumed; receipts; archived results; output reset
PASS cancelled stream closes; old generation cannot overwrite resumed result/messages
PASS bounded delivered receipt/run histories, message/batch character limits and already-aborted waiter
PASS report-required resume ignores historical report and requires new authoritative report
```

**这里的基线两项原本均成功；不是基线既有失败。**

## 根因：一个共因，两条失败链；未确认独立生产功能回归

1. **安全 provenance 契约收紧，旧合成 gateway 的可见正例未适配。** `engine/src/core/run-agent.ts:320-324` 的 `extractFinalText` 从接受所有 assistant text 收紧为非 meta 且 `block.displayChannel === "visible"`；`finalizeAgentTool:218-231` 依此生成 content/displaySource。`types/messages.ts:65-70` 的通用 `createTextMessage` 不赋予可见性，两个旧 smoke 却直接用它构建公开 gateway 文本。
   - lifecycle 原 `smoke-agent-lifecycle.ts:36` 发出未标来源的 `old-result`，在 `:64` 观察到安全过滤后的空 content。不是 inbox 丢失：此前 next request、tool_result 排序、delivered receipt、terminal pending 的断言已通过。
   - agents 原 `smoke-agents.ts:167-175` 的 title 同样未标来源。`query-engine.ts:618-638` 使用 requiresReport=false 的 runAgent 并从 result.content 取标题，`:681-687` 把空标题归为 undefined，故最终标题等待超时。不是凭超时泛指标题调度竞态。
   - 生产 Responses mapper `openai-responses-mapper.ts:120-123,326-330` 对经过 visible 判定的输出明确携带该标记。这是合理 fail-closed 边界，不应为了旧 fake 放开任意 assistant/analysis/hidden。
2. **已有测试等待弱点，仅解释报错位置，不列为本轮新回归。** 原 `smoke-agents.ts:227` 给 waitFor 传 boolean，helper 原 `:369-377` 只将 undefined 视为未就绪；false 会立即返回。因而走到 :234 不证明 initial title 已成功。该代码基线相同，本轮按授权不修改断言/helper/等待预算。

## 修改文件之前的内存因果对照

仅读两个原 smoke 到内存，局部将其 createTextMessage 导入改为别名，加包装：仅 assistant text block 加 `displayChannel: "visible"`；相对导入解析到各自原生产文件，TypeScript transpile 后经 data URL 执行。命令载体为 `node --import tsx --input-type=module`，源码经 stdin 传递，不落盘或修改测试/生产。没有伪造 `displaySource`，生产路径不变。这是诊断变体，不冒充原命令验收。

| 内存 visible fixture 对照 | 当前 exit | 基线 exit |
|---|---|---|
| smoke-agents | **0** / 1.616s，14项 true | **0** / 1.207s，14项 true |
| smoke-agent-lifecycle | **0** / 1.247s，四组 PASS | **0** / 1.245s，四组 PASS |

内存包装也会标记同文件直接构造的 assistant 文本，因此正式文件修改采用更窄的 gateway 调用替换，保留非 gateway 负例。正式修复后同样全通过，排除靠宽包装改变负例才能成功的可能。

## 后续明确授权与最小修复

用户在收到内存证据后明确授权修改**这两个 smoke 的合成 gateway 正例**，保留 analysis/hidden 负例，不改生产/断言/等待预算。实际修改：

- 两个文件各新增局部 `createVisibleSmokeMessage(text)`，仅构造带 `displayChannel: "visible"` 的 assistant text。
- smoke-agents 的3个 gateway assistant_message 调用点使用该 helper；原 `missingReport` 直接 `createTextMessage("assistant", "I will continue checking files.")` **保持未标 visible**，其断言不变。
- lifecycle 的4个 gateway 调用点使用 helper；其中 `stale-result` 仍是合法可见文本，负例性质来自旧 generation，原“不可覆盖/不可进入 messages”断言不变。`No new report yet` 仍不是 authoritative report，原恢复/必须重新 report 的断言不变。
- 没有改变任何 analysis/hidden 输入、生产文件、CSV、assert、check 聚合、等待条件或 timeout；基线目录仍未改。

## 授权修改后：原命令复验

| 原命令复验 | 当前 exit / 精确 check |
|---|---|
| smoke-agents | **0** / 0.908s，上述14项 true；sessionTitle=`Refined Delegate Smoke Title`，initial/refinement calls=3/4，reportRecoveryPrompts=1，forcedReportToolChoices=1；`exploreOutput.displaySource="agent_report"` |
| smoke-agent-lifecycle | **0** / 0.612s，上述四组 PASS 全部输出 |

`git diff --check -- engine/src/agents/smoke-agents.ts engine/src/agents/smoke-agent-lifecycle.ts` 无错误；diff 仅 helper 与7个 gateway 调用点，断言及等待预算原样。已向主代理发送修复完成/两个原命令 exit0 通知，供其统一45jobs继续验收；本记录不代替尚未完成的统一验收结果。

## 原始日志

所有10次 Node 运行各有独立 stdout/stderr/exit JSON，目录：

`C:\Users\qyq\AppData\Local\Temp\neo-agent-smoke-compare-gm2qk3_7`

文件前缀：

- 原始四次：`{current,baseline}-{smoke-agents,smoke-agent-lifecycle}`
- 内存对照四次：上述前缀加 `-visible-fixture-memory`
- 授权修复后两次：`current-{smoke-agents,smoke-agent-lifecycle}-authorized-fixture-fix`
- 扩展名：`.stdout.log`、`.stderr.log`、`.json`。原始 JSON 另含 cwd、完整命令、每次监测源码的 before/after SHA256。

smoke 自身输出在临时 session 目录及 `%USERPROFILE%\.neoctl\agent-tasks`，不在仓库。此次代理主动编辑范围仅本记录和后续用户授权的两个 smoke；没有触碰其他代理修改。
