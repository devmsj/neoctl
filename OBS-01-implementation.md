# OBS-01 实施记录

## 编码前确定（2026-09-07）
已完整读取 00/01/02/03/04；初始 git status --short 为空。仅 OBS-01，无前置依赖。

根因链：tool_use.input → run-tool-use.ts 校验/执行 → tool_result.output（大结果经 FileToolResultMemory 存为 sessionDir/tool-results，消息保留 persisted-output 引用）→ SessionStore.recordMessage/getDisplayEntries（刷新恢复仍有源记录）→ web/index.ts formatToolResultLine 仅摘要 → App.vue 普通组内及非组分支缺少详情入口；旧 openToolDetail 仅渲染 line.text，不等于原始输入/结果。kind=error 带 toolName 已被 shouldCollapseToolLine 接纳，保留这一行为。

契约与范围：新增 web/tool-call-detail.ts 服务端只读投影，以已解析 runtime 的 sessionId + toolUseId + 可选 messageId 定位，仅读取 tool_use/tool_result，不公开系统/思考消息。读取现有大结果时仅允许当前会话 tool-results 下由调用 ID 确定且与持久化引用一致的文件，拒绝越界、符号链接、碰撞身份；不接收客户端路径，不改变保留策略。详情分 input/result/error，状态 complete/truncated/missing/unavailable，全文指脱敏后保存的调用数据，不保证上游工具未自行截断。结构化错误优先，字符串结果仅失败时 fallback。接口沿用本地单用户 runtime scope 权限模型，额外限制同源访问和会话/调用归属；不是新增多用户鉴权体系。

拟修改：engine/src/web/index.ts 只读路由/调用错误投影，新增详情模块；web/src/App.vue 复用通用模态、两个普通入口、加载/重试/迟到隔离/焦点及复制下载；相关服务端和真实 Edge 浏览器测试。大数据不进入快照。旧数据缺输入或已清理明确降级。

禁止变化：中央工具 CSS、组头、折叠 purpose 顺序/重复/动画/分组、专业工具能力、两个 CSV、提交/推送。明确排除 OBS-03/04/05/06/07/08/09/10/11/12 的领域映射、状态语义、任务历史、图片与编辑器改造。

## 实施与验证结果
- 增加 QueryEngine.redactDisplayValue，复用现有运行时 secret registry；磁盘全文读取后、输入、错误和接口最终响应均应用脱敏。新增 toolError 的 snapshot / delta append / delta patch 同样应用 registry。camelCase lastText、context/messages、隐藏推理字段被屏蔽。
- GET /api/tool-call-detail?sessionId=...&toolUseId=...&messageId=... 返回 ToolCallDetail；输入/结果/错误各为 {state,text,reason}。缺失身份/不归属/禁止工具 404，跨站浏览器请求 403。scope 按既有本地单用户模型解析，实际文件根来自 runtime.sessionDir，不接受客户端路径。未引入多租户授权模型。
- 普通工具组内/非组统一详情按钮；保留目的第一主展示，错误跟随目的；失败 × aria-label 不变。模态纯文本输出，支持重试、AbortController＋epoch＋响应身份校验、会话切换关闭、焦点回归和 Tab 环绕、复制/下载全文或预览。
- 既有文件恢复为 Git HEAD 的 LF，消除整文件行尾噪声；未改中央 CSS。

已实际执行且通过：
1. npm --prefix engine run typecheck。
2. npm --prefix web run build。
3. node engine/node_modules/tsx/dist/cli.mjs engine/src/web/smoke-tool-call-detail.ts：45 assertions。实际运行 file_read 缺路径、file_edit 未匹配、参数校验、subagent_message 未知目标，真实原因分别为 read.path does not exist、String to replace not found in file、input.path must be a string、Unknown agent；另覆盖大结果真实磁盘读取、SessionStore 落盘重开、清理/越界、身份不匹配、重复身份、空值、缺输入、截断、运行时注册秘密、snapshot/delta 脱敏。
4. node web/tool-call-detail-browser.test.mjs：真实本地 Edge（临时 playwright-core），实际 DOM/键盘/剪贴板/下载验证；API 用只读夹具。组内3条＋非组1条错误，重复目的不丢，折叠无错误，加载503后重试、焦点回归/Tab 环绕、全文尾部复制下载、预览按钮、迟到响应不串用、错误身份拒绝、刷新重开、390px视口、无非GET请求、无pageerror。
5. npm --prefix engine run smoke:web-history、smoke:session、smoke:secrets 均通过。
6. node --test web/observability-preservation.test.mjs：2/2；node --test web/agent-task-presentation.test.mjs：3/3。
7. git diff --check（本项已跟踪源码）通过。

## 补验收（仅专属测试，未改已交OBS08独占的源码）
- 新增 web/tool-call-session-browser.test.mjs，已实际Edge通过：A详情挂起，用户关闭并经会话管理打开B，复用相同line/call ID；B详情显示后释放A，B内容保持且不含A；全部网络操作为GET。
- 新增 engine/src/web/smoke-tool-call-http.ts，调用真实runWebServer/生产route/WebRepl.toolCallDetail，注入仅存储runtime以避免模型调用；两个临时会话真实FileToolResultMemory文件分别读取，不串用。真实Windows junction将A/tool-results指向B，已实测isSymbolicLink=true、响应unavailable且不含B内容。
- 补测发现原新增路由statusCode被sendJson默认200覆盖；已由主代理修复两处sendJson显式status参数，本子代理未修改独占源码。修复后实际复跑：真实HTTP 19断言全部通过（GET成功/no-store、POST不执行、403跨站、404不存在/跨会话messageId、双会话独立磁盘全文、真实junction拒绝）；服务端smoke45断言通过；Edge跨会话迟到隔离通过；engine typecheck通过。OBS-01必选验收现已全部有实际测试证据，无已知剩余必选缺口。

验收边界/非必选未验证：浏览器测试真实运行 Edge，API 为夹具；另由真实HTTP生产路由＋真实磁盘测试及真实工具smoke覆盖服务端链，未冒充浏览器直连生产引擎的一体端到端验收。未做桌面壳/生产web代理转发链联调或人工像素对比；本轮已明确不将这两项作为必选。跨会话浏览器切换、真实Windows junction攻击拒绝、真实路由HTTP403/404已补齐。现有系统为本地单用户信任边界，不声称新增多用户认证授权。未改两个CSV、未提交推送。其他代理并发变更不属于本项，也未撤销。

