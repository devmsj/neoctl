# OBS-04 前置数据准备（非整项完成）

日期：2026-09-07。仅准备独立数据能力；正式 OBS-04 仍待前项按序接入。未接共享 Web/UI、GET reader，未修改 CSV、提交、提示、供应商配置或任务生命周期。复用既有 child transcript，不新增日志库或保留政策。

## 修改范围

- `engine/src/types/events.ts`：`assistant.delta.displayChannel?: 'visible'`。
- `engine/src/types/messages.ts`：text block `displayChannel?: 'visible'`。
- `engine/src/model/model-gateway.ts`：`assistant_delta.displayChannel?: 'visible'` 类型；不修改请求或 raw provider 行为。
- `engine/src/model/openai-responses-mapper.ts`：Responses output_text 源标记，最终文本按标记边界保留分块。
- `engine/src/core/query.ts`：透传标记；在既有 AssistantOutputFilter 外追踪暂存字符来源，不改变其过滤规则。
- `engine/src/core/run-agent.ts`：可选真实 generation 输入；仅 query 新产出 message 写入该轮次。
- `engine/src/session/session-store.ts`：transcript message entry 可选 generation 字段。
- 额外授权 `engine/src/agents/agent-tool.ts`：仅两个 runAgent 调用点增加已捕获 `runGeneration`，无其他逻辑改动。
- 专项测试 `engine/src/core/obs04-visible-data.test.ts`；扩充 `engine/src/agents/agent-tool-persistence.test.ts` 的真实 transcript 断言。

## 字段来源与可展示边界

### displayChannel

唯一新增生产标记来源是 Responses mapper 的可信 `response.output_text.delta` / 非流式 `message.content[].type === 'output_text'` 分支。标准 Responses 没有显式 channel 的 output_text 按其用户输出契约标记；显式通道只允许 commentary、answer、final，phase 只允许 commentary、answer、final、final_answer。

检查 event、已关联 output item、content part 的 role/channel/phase；任意显式 analysis/system/hidden/未知通道或非 assistant role 均不标。reasoning/thinking 事件与块从不新增标记。对象响应中的旧 text 分支可继续保留原内容，但不授予 visible。不同标记的最终文本分块，不将混合文本整体升级为 visible。

query 保留既有安全过滤器规则，用暂存片段长度携带来源；例如未标记 `W` 被暂存，下一次 visible `x` 释放 `Wx` 时只有 `x` 标记 visible，反方向只有 `W` 标记。最终文本块经过 sanitize 和 session 恢复/compact checkpoint 后保留原标识。

这不是公开完整 assistant/message/provider_event 的授权。旧无标记记录、lastText、hidden/thinking/system 均不得作为 reader 可展示正文 fallback。标记不是凭证脱敏或会话权限校验，后续 reader 必须独立执行授权与脱敏。

### runGeneration

原 RunAgentOptions/Dependencies 没有此输入。现由 agent-tool.ts 的同步、后台/续跑两个 runAgent 调用点传入它们已捕获的 generation（放在 executionOptions spread 后）。续跑通过既有 prepareResume 后的轮次链路取值；不根据创建时间、当前时间或 transcript 内容推测。

`RunAgentOptions.runGeneration?: number` → query 新 message → `SessionStore.recordMessage(message, { runGeneration })` → `SessionTranscriptEntry` 的 message 分支顶层 `runGeneration?: number`。

只保存显式正安全整数；缺失/无效时不添加字段。新 assistant、thinking、tool_use、tool_result message 可以携带轮次事实，但轮次事实本身不授权正文展示。初始化、父上下文继承、历史 repair、resume directive、pending 输入、report reminder 不补当前轮次。Message 本体不新增 generation，不改变模型输入或恢复上下文语义。

## 后续 reader 可用契约

1. 先由已授权所属父会话和 task 身份解析真实 agentId，绑定既有 `<parentSessionDir>/subagents/<agentId>/transcript.jsonl`；不能接受任意本地路径。
2. 从 append-only transcript 的 `type === 'message'` entry 读取过程；要求 `entry.runGeneration === requestedRunGeneration`，同时核对真实 sessionId/agentId。
3. 正文仅取 `entry.message.role === 'assistant'` 且 `block.type === 'text' && block.displayChannel === 'visible'`，再执行 reader 脱敏。不能公开整个 message 或把未标记旧文本作为 fallback。
4. 工具步骤可使用同轮次 message 中真实 tool_use/tool_result 的调用身份，经独立字段允许列表与脱敏后返回；thinking 块即使带轮次也不公开。
5. compact entry 的 replacementMessages 是恢复上下文，不是新的当前轮次产出，不作为过程追加。generation 保存在原始 message entry 顶层，不在 getInitialMessages 的 Message 本体里；reader 不应从恢复快照反推 generation。
6. 缺 generation 的旧/继承/初始化记录按“未记录轮次”处理，不混入任何指定轮次。缺 visible 则无允许正文，不代表可公开 lastText。
7. 分页、实时订阅绑定、权限、脱敏、资源缺失/保留说明与 GET/UI 接入仍属于后续正式 OBS-04，不在本次宣称完成。

## 实际验证

最终执行结果：

- `npm run typecheck`（engine）：退出码 0。
- `npx tsx --test src/core/obs04-visible-data.test.ts src/core/run-agent-persistence.test.ts src/agents/agent-tool-persistence.test.ts src/session/session-store-safety.test.ts`：33 项，32 passed、1 既有 skipped、0 failed，退出码 0。
- 专项覆盖 Responses visible vs analysis/system/hidden/unknown/reasoning；最终块；query 暂存尾字跨通道、流结束 flush；恢复和 compact 标识；继承/初始化/pending/resume 排除；跨轮次 7/11；旧无 generation；新工具调用和结果记录 generation。
- 真实 agent-tool persistence 覆盖同步/后台 launch → fresh TaskStore → prepareResume，读取磁盘 transcript，产出轮次为 `[1, 2]`，初始化/续跑输入不带轮次。
- `npm run smoke:responses`：通过，`ok: true`。
- `npm run smoke:session`：通过，`ok: true`。
- 限定文件 `git diff --check`：通过。
- 额外 `npm run smoke:core` 未全绿：`historyImageDowngraded: false` 导致退出码 1；该次输出中 query 尾字、安全过滤、thinking 持久化/排除、工具顺序等检查为 true。未扩大范围修改图片逻辑，未声称此失败已修复或确认为基线失败。
- 中途全仓 typecheck 曾被并行 `terminal-output-store.test.ts` TS2339 阻塞；最新完整执行已退出 0。

## 编码与范围说明

本次写入文件为 UTF-8 无 BOM、LF。HEAD 中 model-gateway.ts、types/messages.ts、openai-responses-mapper.ts 原有混合行尾，转为 LF 导致普通 diff 包含行尾差异；`git diff --ignore-space-at-eol` 可查看实际代码增量。未触及其他工作者的既有修改。

结论：完成本次 OBS-04 前置数据准备范围；不等于 OBS-04 整项完成，CSV 状态未变更。
