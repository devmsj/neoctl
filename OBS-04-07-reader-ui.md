# OBS04/07 独立 AgentContentReader 交付（非整 App 验收）

2026-09-07。只新增组件、专属 helper/test 和本记录。不改 App.vue、index、CSV、CSS，不提交。规范目录及 OBS-04-07-reader-preparation.md 已读。用户确认 OBS03/05 已验收登记；OBS04/07 正式 App 接入及验收由主代理按序完成。

## 精确接入

```vue
<AgentContentReader
  :owner-session-id="selectedTask.ownerSessionId"
  :task-id="selectedTask.taskId"
  :run-generation="selectedRun.runGeneration"
  :status="selectedRun.status"
  :visible-preview="selectedRun.runGeneration === selectedTask.runGeneration ? selectedTask.progress?.visibleText : undefined"
  :render-markdown="renderAgentMarkdown"
/>
```

```js
import AgentContentReader from './AgentContentReader.vue'
function renderAgentMarkdown(text) {
  return sanitizeMarkdown(marked.parse(text))
}
```

上面 selectedTask/selectedRun 是接入示意名，需由 App 现有选中对象提供，不是要求新增另一套任务状态。已核对 index 投影 `progress.visibleText` 的结构恰为 `{channel:'visible',runGeneration,text,truncated}`，可直接传给 visiblePreview。组件不得传入 progress.lastText/currentAction/父 context。所属 owner 必须来自任务，不可用当前父会话兜底。读取旧轮时传该轮真实 status、runGeneration；不传当前轮预览，不猜旧轮次。runHistory 选择入口由 App 负责。

必需 props：ownerSessionId:string、taskId:string、runGeneration:number（正安全整数）、status:string。
可选 props：view:'delegation'|'timeline'|'report'、renderMarkdown:(string)=>安全 HTML、visiblePreview:上述对象。
无事件、无任务控制、无额外 modal。现有后台 modal 和中央 agent 工具详情直接内嵌复用。日志、delivery、轮次导航/耗时仍留 App 外。建议报告占原详情主阅读区，不能保留旧窄列报告并重复显示。

view 未传时初次/身份切换按 pending/running 默认 timeline，其余默认 report。组件内部可切三视图；status 更新不强制打断用户已选阅读位置。若终态需立即切 report，App 可显式传 view；不要每个轮询覆盖用户正在阅读的视图。未传 Markdown callback 时 Vue 转义纯文本；不复制项目安全解析器。

唯一网络请求：
`GET /api/agent-content?sessionId=<ownerSessionId>&taskId=<taskId>&runGeneration=<runGeneration>&view=delegation|timeline|report&pageChars=16000[&cursor=<opaque>][&refresh=true]`
直接接收 AgentContentPage。已核对主 index 新接 GET 与字段相符；不由本组件调用模型/续跑/消息，也不依赖 transcript 外的隐藏通道。

## 文件与行为

- web/src/AgentContentReader.vue：模态内嵌三视图；按需分页、3 秒运行态已保存过程只读刷新、refreshCursor 增量、取消/重新快照、复制/下载、只读跟随。
- web/src/agent-content-reader.mjs：纯身份/路由/分片合并/完整性/导出语义 helper。
- web/agent-content-reader.test.mjs：纯 helper 测试。
- web/agent-content-reader-browser.test.mjs：独立 Vite fixture 编译真实 SFC，复用现有 CSS，并运行时读取 App 的现有 sanitizeMarkdown/safeHref/highlightCodeBlocks/normalizeCodeLanguage。真实 Edge DOM/剪贴板/下载验证；API 用匹配契约 fixture，未挂载 App。

委派明确 scope=task，不作为指定轮次 resume 指令；说明摘要截断与 prompt 正文全文分开。timeline 从较早记录向后分页，id+offset 幂等，超长单条接续，下一页要求同 snapshot，refresh 允许上界快照更新；空 partial 仍推进游标、不判整轮无正文，pendingTail 标未提交。工具展示真实对象、调用 ID、源状态、结果摘要和展开原文。invoked 不推断仍在运行。

实时 visiblePreview 单独显示，严格 visible+匹配 run+字符串+truncated 事实；未知/旧通道不展示，不用 lastText。该预览不与落盘正文拼接、不用于全文导出。此最小预览协议无 owner/task 字段，App 必须从同一选中任务原子提供；组件不能证明一个手工错配但轮次相同的预览属于谁。

所有 fetch/json/nextTick/clipboard/readPage await 之后检查 owner/task/run/view/requestEpoch 与 AbortSignal；身份切换、重新读取、取消、卸载均 abort+epoch 隔离。响应还检查身份、快照、分片范围/重复/冲突。分页读不到全文时明确预览；错误保留此前可见预览且禁用全文导出，可重新快照重试。全文操作按需读完所有剩余页后才执行，源 truncated/missing/unavailable/pendingTail 禁止当全文；已保存 stopped/failed/incomplete 报告可导出保存正文全文，但始终保留真实任务状态、报告完成标记和错误，不称任务成功或报告已完成。

复用 background-task-* / tool-call-detail-actions / markdown-body，无 style 块或 CSS 文件修改；局部 min-width、overflow、pre-wrap 和按钮换行保护窄屏。不重构中央卡片或组头。

## 验证记录

- `node --test agent-content-reader.test.mjs`（web）：11 tests / 11 passed / 0 failed / 0 skipped。
- `node agent-content-reader-browser.test.mjs`（web）：退出 0，独立真实 Edge PASS，22 次全部 GET。验证安全 Markdown 标题/列表/代码/链接、XSS 无执行、报告跨页完整复制/真实下载、task 委派、visible 实时预览和旧/未知通道拒绝、实际 3s 空 partial 扫描及增量、重复项幂等、真实工具对象/ID/失败状态、503 重试、源截断/缺失/有效空报告、错误 owner 拒绝、owner/task/run 迟到响应隔离、同身份重读 epoch、卸载、390px 宽度及无横向撑宽。
- 三个 mjs `node --check`：退出 0。
- 最后新增文件 UTF-8/LF/无 BOM/无 CR/无行尾空白检查见终端验证；未暂存提交。

以上为独立组件任务原结论，不单独登记整项。主后续已正式接入后台和中央两个既有modal、host sanitizer、owner/task/run导航；真实App5+round11共16项通过，正式HTTP953断言119请求通过，包含完整报告/停止失败/8历史/窄屏/真实会话迟到隔离。sync逐prop导致混身份GET已修为pre批处理并保持await隔离。安全来源与最终整体验收见OBS-04-07-09-11-integration.md，状态以完成索引.csv为准。
