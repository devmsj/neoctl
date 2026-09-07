# OBS-04 / OBS-07 / OBS-11 / OBS-09 集成与主验收

## 范围与顺序

基线 d40cb8b67525b8646587480c43bce3854c153dca。按 OBS04 → OBS07 → OBS11 → OBS09 依赖验收登记。此记录不以数据准备或组件入口代替整项完成；最终状态以桌面规范目录完成索引.csv为准。无提交、推送或工作区清理。

## OBS-04：委派与可展示过程

- 新 Responses output_text 仅明确获准用户通道标记 displayChannel:visible；未知/analysis/system/非assistant优先拒绝。旧 lastText 不公开为正文。
- 子会话新 transcript message entry 顶层记录真实捕获 runGeneration；初始化、继承和续跑指令不伪标当轮正文。
- task live preview 只消费获准当前代事件，按task对象/代隔离的stream redactor先安全处理再4000尾裁剪。redactionVersion:1为安全管线版本；旧无标记裁剪尾部无法重建凭证边界，DTO和snapshot不公开。carry不序列化，终态不flush未完成秘密，resume不混代。
- 复用唯一GET /api/agent-content与AgentContentReader；view=delegation/timeline/report。委派为task.prompt/description，不声称是每轮resume指令。
- timeline只读所属真实子transcript，调用id、工具、实际对象、状态、错误/结果可分页；大于24/8条及长单项均不由progress.steps替代。
- owner/task/run/view/文件身份和上界绑定加密游标；固定上界、空partial扫描页、pendingTail、耗尽后refreshCursor、旧轮淘汰明确。GET不恢复、不bind、不写任务、不调用模型。
- 单条16MiB显式不可获取、引用扫描预算与游标过期边界见reader preparation；不伪装全集。

## OBS-07：完整报告

- 三view只读按owner/task/run读取current或唯一archive，不回退当前或输出文件。
- 所有终态报告，包括正常结束与failed/killed，均须来自真实成功report工具或明确visible正文，result.displaySource为agent_report/visible_text。旧已保存结果无来源证明时unavailable，不靠completed状态推断公开许可。
- 断流时已获准且经过安全过滤的delta收束成streamedPartial消息，保存到本轮正文并保留failed/incomplete，不把技术lastText或隐藏通道拼成partial。
- snapshot当前报告/error 1500、archive 600字符预览均先整值registry脱敏再裁剪；来源不明不返回文本。全文仍走同一只读resolver。
- 正文主宽区使用既有marked+sanitizeMarkdown，标题/列表/代码/链接安全渲染；复制下载标明全文/预览，失败可重试，日志和交付保留为辅助details。

## OBS-11：本轮计时

- pending→markRunning才记录startedAt。首次completed/failed/killed冻结durationMs/completedAt，0合法。缺失/异常/恢复中断未知结束不伪造。
- prepareResume归档清理，当前新代独立start，保留8轮历史，各轮真实计时不随当前增长。
- App使用服务端start派生运行耗时，刷新不归零；终态不tick，不用createdAt或页面打开时刻兜底。

## OBS-09：后台组合

- 保留主任务+N摘要、所有所属活动/历史导航；选择身份与reader相同。terminal历史复用已批准TTL store，不另建输出拼接器。
- 身份状态/当前轮事实在前，运行正文或终态报告为主，辅助技术日志与消息交付details在后；无数据明确未提供。
- AgentContentReader身份watch批量父prop patch（flush:pre），避免新taskId+旧generation中间GET；await后owner/task/run/view/epoch/signal隔离不变。
- 既有两模态与样式复用，无CSS文件改动；中央调用不按terminal session合并，目的顺序/重复、组头/分组/箭头/粉色次数/动画不改。

## 主已实际完成的验证

1. 正式App真实Edge、本地HTTP、原生scoped SSE：正文/报告/中央入口/真实新建切换5项与轮次计时/组合11项同次16/16通过。旧sync watcher导致3项失败，修复后同断言全部通过，不降低错误GET检查。
2. 真实server/router + 真实TaskStore/transcript HTTP：953断言、119请求，modelCalls=mutations=0。含3view分页/重试/固定上界/刷新、403/404、来源标记、注册秘密/结构化脱敏、hidden排除、三view读取中切代拒绝、文件hash/mtime不变。
3. typecheck与report安全/preview安全/resolver合计52/52主复跑通过（后续新增边界以最终统一回归为准）。
4. 390px无文档横溢出、实际wheel详情滚动、关闭头固定、Enter/Space/Escape、报告宽区、8轮导航、淘汰不回退、计时不重建中央DOM均包含在真实App测试。
5. 构建CSS始终index-WuTlWLu5.css；独立preservation基线比较保留中央group与purpose列表。

## 最终收尾与登记

- 最后mixed-provider两红测已修绿；新报告安全22项、preview安全18项、resolver15项通过。首轮统一45/45 exit0（包括113项web非browser）。
- 最后一处旧代理tool payload经普通详情/历史wire/代理timeline绕过报告来源已真实复现，加入共用sanitizeAgentToolPayload，保留task/run/status/交付事实，旧JSON/XML/plain正文明确unavailable；主普通详情HTTP先失败后34断言通过并检查history wire。新增payload安全15项通过。
- index事实投影与正文结构化脱敏分开，避免pending_messages=0被privateKey规则误伤；OBS08状态矩阵已再次通过。最终冻结版本46/46独立命令全部通过，exit0，211457ms；日志位于%TEMP%/neoctl-observability-final46.json。随后恢复OBS01完成，严格按OBS04→OBS07→OBS11→OBS09顺序逐项写两份索引，11有效项均完成、OBS02保持撤销。96个变更文本UTF8无BOM/LF/无行尾空白及git diff --check通过；冻结后的验收未再修改生产代码，未提交或推送。
- 基线已知core-loop的historyImageDowngraded=false见OBS-validation-baseline.md。旧agents两个smoke在基线通过、当前因合成gateway缺visible标记失败；内存对照确认后仅给合成正例补标，原命令现均通过，断言与等待预算不变，见OBS-agent-smoke-baseline.md。
- agent-tool-persistence.test.ts两处FIRST_RESULT/RESUMED_RESULT正例也明确visible，原持久化/续跑/归档断言保持且主统一回归通过。未为旧fixture放宽生产通道检查。
