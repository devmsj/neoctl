# OBS09/11 正式 App 轮次计时与组合 Edge 回归

2026-09-07。仅新增 `web/agent-round-timing-browser.test.mjs` 与本记录；不修改生产/App/index/CSV，不暂存或提交。构建生成现有忽略目录 `web/dist`。工作区其他代理已有修改不属于本任务。

## 测试边界与真实运行方式

- 使用最新 `npm --prefix web run build` 产物，挂载完整 App，而非单组件/抽取 helper。
- 本机真实 Node HTTP fixture 服务提供 `/api/state`、`/events`、`/api/agent-content`、`/api/terminal-output`，Edge 使用原生 EventSource 和真实 SSE sync 帧；与 `terminal-transition-browser.test.mjs` 同类方式。
- 不使用 Playwright route，不覆写 EventSource、Date、timer，不读写 Vue state。`page.evaluate` 只读取 DOM/布局/UA、安装 DOM MutationObserver 证据；交互通过按钮、键盘与真实 mouse wheel。
- 所有 API/SSE 请求必须 GET；非 GET 立即 405，after hook 也核验无写请求。不启动模型、不执行终端/工具、不调用 resume；resume 是服务端 fixture facts 经原生 SSE 更新，用于验证实际 UI 处理。
- 这证明真实浏览器 + 正式 App + HTTP/SSE fixture 的消费行为，不声明本测试启动了 engine 生产服务、验证了持久化/权限/模型链路。报告来源、流式 partial、预览裁剪的安全复核与修复由主协调，不在本测试验收范围。

## 已适配主最新接入

不依赖旧 `background-task-agent-grid` 或旧 archives section。真实选择入口为 `nav[aria-label="代理轮次选择"]`：当前第11轮与第10..3轮共9个按钮，历史按钮显示各自“本轮耗时”。技术日志和交付位于正文后的 `details`：

- `辅助技术日志与最近步骤` 默认折叠；空 currentAction/steps 不生成进度日志 section；打开显示“未提供”。
- `消息交付与辅助信息` 默认折叠；报告阅读区使用父容器全宽，无旧双列 grid。
- 正文身份实际通过 GET 验证 owner/taskId/runGeneration，未接不再 skip。

## 11 项覆盖

1. generation1：多次真实 clock tick 持续增长，server startedAt 与 task createdAt 故意相隔一天；关闭/刷新后不从0开始。
2. generation2：同上，携带第一轮终态历史。
3. generation11：同上，携带第3..10轮八条历史；辅助空日志不是进度。
4. running → completed：SSE 更新已选任务，12s 冻结，等待/关闭重开/reload 仍12s；resume2新起点增长，历史1按钮仍12s。
5. running → failed：同上。
6. running → killed：同上。
7. 12种旧字段/异常计时，DOM均应“未提供”；合法一致0ms冻结。包括缺 start、第二轮缺 start、非法/数字/未来 start、pending、终态缺事实/非法 end/负duration/不一致/字符串duration/end早于start。
8. 当前11+八历史按钮真实顺序与数值；第3..10轮混合 completed/failed/killed，各自4.2s..11.2s按现有UI精度显示并冻结，不保留“最近3轮”文案。
9. OBS09：两个running+completed/failed/killed+terminal history共6个任务，逐个选中唯一active；主摘要 first-running +1 始终不因选中改变；terminal history真实GET读取；报告宽区、折叠交付；390×844无document横向溢出，真实wheel滚动详情、关闭头不移动，Enter/Space任务导航、Enter关闭，其他项覆盖Escape。
10. 运行中gen2任务 → 失败gen11任务，正文身份GET与最终DOM必须匹配，不能新taskId混旧generation。
11. 历史3/7/10阅读导航；选择旧10时resume12不跳当前；选择当前后SSE13自动跟随；旧10被服务端淘汰时卸载reader、明确“已清理”，不发当前轮兜底GET；用户点当前13才读取。

MutationObserver 在计时、SSE与任务/轮次GET阅读期间检查中央 tool-group、组头、三条 purpose DOM原节点未被移除重建，组头文本未变，重复 purposes 顺序严格保留 `DUPLICATE_PURPOSE, DUPLICATE_PURPOSE, LAST_PURPOSE`。页面reload属于明确重载，不声称它保留旧DOM。

## 实际命令与发现

- `npm --prefix web run build`：退出0；最新已运行产物 `dist/assets/index-b5G2-1Yk.js`，41 modules，build 1.92s。
- `node --check web/agent-round-timing-browser.test.mjs`：退出0。
- `node --test web/agent-round-timing-browser.test.mjs`：最终完整复跑11 tests / 8 passed / 3 failed / 0 skipped / 0 cancelled，退出1，TAP duration 41862.2966ms。已包含新增的resume期间历史按钮DOM冻结断言和正文全宽/折叠交付断言；此前两次完整运行也为8/3。不是全绿，不登记OBS09/11整体验收完成。
- 最小定位命令 `node --test --test-name-pattern="current task identity" web/agent-round-timing-browser.test.mjs`：1 test / 0 passed / 1 failed / 0 skipped，退出1。

### 真实阻塞：任务与轮次 prop 半更新时的错误 GET

从 `reader-running` generation2 切换到 `reader-failed` generation11，真实服务器收到：

```text
GET /api/agent-content?sessionId=round-owner&taskId=reader-failed&runGeneration=2&view=timeline&pageChars=16000
```

该新任务只存在current11/history3..10，并无run2。随后才收到正确run11并显示正确正文。最终DOM正确不能掩盖中间错误GET。fixture严格拒绝未保留轮次，记录完整URL，after hook使测试失败，不假造旧轮数据、不降低断言、不skip。

同类混配发生于异常计时案例的任务切换：`missing-run-start/1`（实际current2）、`invalid-start/2`（实际current1）；OBS09混合任务也发生。因此第7/9/10项虽然计时/选中/布局DOM断言通过，仍在请求身份核验after hook失败，不能记为PASS。

只读代码线索：AgentContentReader身份watch使用 `flush: 'sync'`；App复用同reader时逐prop更新可能先暴露新taskId/旧runGeneration。此为定位假设，不声称已修复。已报告主代理，由生产拥有者修复原子身份切换，之后重新build跑同一测试。报告来源/partial/裁剪安全问题不由本测试修改。

已通过的具体DOM证据：generation1/2/11计时样本约18000→19000→20000ms；三类终态冻结12s；历史8轮值正确冻结；历史导航/淘汰不回退通过。390布局实测 `viewport=390, doc=390, client=390, left=0, right=390, top=0, bottom=844`，真实wheel与键盘交互成功。但OBS09组合项仍因上述错误GET失败。

## 主代理修复与复验（后续结果，取代上述未修复状态）

- 已确认根因并修改 `web/src/AgentContentReader.vue`：身份 watcher 从 sync 改为 pre，让同一次父组件 prop patch 批量完成后再发请求，避免新 taskId + 旧 generation。每次 await 后的 owner/task/run/epoch/signal 检查仍保留，不以延后请求放松迟到响应隔离。
- 主真实执行：web cwd `node node_modules/vite/bin/vite.js build` 后运行 `node --test agent-round-timing-browser.test.mjs agent-content-app-browser.test.mjs`，退出0，16/16 passed，0 failed/skip，TAP 42275.128ms。原3项失败均通过，错误GET断言未降低。
- build CSS 仍 `index-WuTlWLu5.css`，JS `index-BQi08Vdq.js`。计时11项与正文/报告/中央入口/跨会话5项在同次复跑全部通过。此结论不代替另行进行的报告来源与流式脱敏安全回归。

## 原子任务收尾记录（修复前历史）

最终完整运行结果如上。两个新增文件经Node TextDecoder fatal UTF-8解码与字节/正则检查：UTF-8/LF、无BOM、无CR、无行尾空白，退出0；git限定路径状态均为未跟踪新增，未暂存提交。无生产修复、无CSV登记。剩余接点不是历史UI缺失：主已完成接入；当前明确阻塞是任务切换发出错误身份GET。中央Agent工具详情正文的专门导航、跨owner真实会话权限与报告完整性安全不声明由本文件验收。
