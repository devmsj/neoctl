# OBS-08 实施记录（2026-09-07）

## 范围与根因
在主代理确认 OBS-01 HTTP/跨会话验收完成后开始编码。仅改 index.ts、App.vue、agent-task-presentation.mjs 与专属状态模块/测试；不改执行器、CSV、OBS12 插件、图片 data，不提交推送。

原投影把 subagent_message.status 当任务状态并无条件附仅入队；subagent_output XML 未映射；agentToolStatus 用任务状态判调用状态；normalizeToolDisplay 跨域按 value 去重；最终调用结果把全部 running 步骤猜为 completed/failed。

## 契约
- engine/src/web/status-semantics.ts：call/task/delivery/readiness/completeness/launch 分域映射。ok:false 优先未入队，包含矛盾 queued payload 的防御测试。同步 subagent_run 的 completed/incomplete 视为报告完整性，不推断任务生命周期。
- XML 只接受从 retrieval_status 起始、按真实协议字段顺序且以 output 开标签结束的头部。不扫描报告正文；无完整性字段则不编造完整性。
- facts 按 label+value 去重，保留不同域相同值和 0。未知枚举显示未知状态，缺字段未提供，原值仍在 OBS01 原始详情。
- 终态调用未收到明确步骤结果的 running 步骤转 unknown；UI 显示阶段结果未提供，已明确 completed/failed 保留。历史 running 步骤在非 live 调用中同样标明缺省。
- 前端仅保留本地三分支 callStatus helper 和后台生命周期/完整性文案；工具 facts 使用服务端已分域 DTO。不依赖 engine/src 或 engine/dist，保留 local/package 构建模式和普通 Node 测试兼容。
- 后台历史任务结束状态与报告完整性分别显示，不再用 incomplete 替换 completed。

## 验收证据
1. 未知消息目标：真实 createSubagentMessageTool 返回失败，经过 restoreWebHistoryLines 显示调用失败/未入队且无仅入队，原错误保留。
2. queued、queued_for_resume：真实 TaskStore 消息工具；delivered/async_launched/resumed/unknown/缺字段/failed/killed：契约投影矩阵。not_ready 使用真实 subagent_output，正文伪造 status 标签不能影响头部事实。
3. completed+incomplete、同步报告 incomplete 单独标完整性；调用成功不会被运行中、任务失败或报告不完整改成调用失败。
4. 真实 editTool 未匹配，采集实际 read emit，经过 applyAvailableToolResult 为 unknown，不伪造 read failed；文件内容未改变。成功/失败最终调用均不会覆盖明确步骤终态。
5. Edge：同一套服务投影分别进入组内/非组普通工具，逐项检查 facts、调用 class、computed style 相同、失败 × aria-label、缺省步骤文案；折叠目的保留顺序重复且不含状态。subagent_get/list 既有隐藏规则不变，通用状态矩阵以可见 subagent_stop 验证两模板。
6. OBS01 Edge 回归通过：鼠标/键盘、焦点、重试、下载全文、延迟身份隔离、刷新、窄视口；只读请求。

## 已运行
- npm --prefix engine run typecheck / build：通过。
- npm --prefix web run build：通过，CSS 产物保持 index-WuTlWLu5.css。
- engine: npx tsx src/web/smoke-status-semantics.ts：通过，生成临时 obs08-browser-lines.json。
- node web/status-semantics-browser.test.mjs：真实 Edge 通过。
- node web/tool-call-detail-browser.test.mjs：OBS01 真实 Edge 通过。
- engine: npx tsx src/web/smoke-tool-call-detail.ts：45 断言通过。
- smoke:web-history、smoke:web-terminal-tasks、smoke:agents：通过。
- node --test web/agent-task-presentation.test.mjs web/observability-preservation.test.mjs：5 测试通过；旧测试修改为无调用成功证据时 unknown，不能再从 queued_for_resume 推断调用执行中。
- git diff --check（本项共享源码）：无错误；UTF8 无 BOM、LF，shebang 首行。

未满足的功能验收项：无已知。运行时为 Node 22.12 普通 node --test（未启用实验 TS）；未另安装 Node20 或进行发布部署。前端已删除所有新增跨 engine 导入，不新增构建依赖。OBS03 终端事实/存储、OBS04 过程全文、OBS06 参数分类不在本项范围。
