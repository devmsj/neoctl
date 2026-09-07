# OBS04/07 agent-content 真实 HTTP 专属测试记录

2026-09-07。接手前任 `task_mtqox8ur_tw37zu` 的仅 HTTP 测试任务。

## 修改边界

- 接手时 `engine/src/web/smoke-agent-content-http.ts` 已存在（214 行），保留其真实 server/router fixture 并补齐收尾；未删除重建测试策略。
- 本次只修改该测试文件，新增本专属记录。
- 已读 `OBS-04-07-reader-preparation.md`、`engine/src/web/agent-content-detail.ts` 和 `smoke-terminal-output-http.ts`。
- 未修改生产/index/App/CSV，未暂存、未提交。主 UI、浏览器交互不在本任务范围。

## Fixture 与只读边界

- 使用真实 `runWebServer`、私有 HTTP router、`WebRepl` 实例及其生命周期内单例 resolver，不直接调用 resolver 或私有 snapshot 投影来替代 HTTP 验收。
- 复用 terminal HTTP smoke 的临时端口和 `http.createServer` 捕获模式；退出时恢复原方法、关闭连接/server 并删除临时根目录。
- 真实 `TaskStore` 将 task.json 写入临时 owner/child 目录，再在请求前显式 `loadSession`。每个 owner 各有独立真实 store（`list()` 使用 active session，不能用一个最后 bind 到 B 的共享 store 测 A 的 snapshot）。
- HTTP 边界内拦截 bind/load/activate/resume/upsert/progress/complete/fail/kill/message/flush 等变更入口；engine/model/repl 的模型或 submit 入口为计数拒绝函数。
- 用临时根目录递归文件清单、SHA-256、大小、mtime、mode 对照验证请求阶段无新建/改写文件；fixture 的初始写入、追加尾行和最终清理明确不属于 GET 只读测量边界。不能据此声称监测了整台机器的所有文件写入。
- 当前任务及所有已加载任务 JSON 对照；测试注入的内存 source/status/generation 变化均恢复，不调用真实任务生命周期修改来制造读取场景。

## 实际覆盖

1. 成功响应 raw `AgentContentPage`、owner/task/run 身份、200 与 no-store；没有 ok/value wrapper。
2. timeline 大量旧轮过滤后的空 partial 页仍有 nextCursor；超过 24/8 条、长单行汉字/emoji 多页、真实 tool use 对象与失败结果；按 id+offset 拼接无遗漏/重复，同 cursor 重读幂等，所有 continuation 保持 snapshotId 与 upper bound。
3. delegation/report 多页完整拼接、描述明确截断；当前 incomplete/failed 报告不变成成功；current/runHistory 精确来源、旧轮淘汰 missing、不回退当前；无报告 missing 与真实空报告 complete 区分。
4. 三 view 均测跨 owner/task/run 游标，跨 view 和篡改游标拒绝；委派/报告源变化拒绝旧 cursor，无 cursor 重读可取得空新源。
5. 增量 refresh 仅接受已耗尽 timeline cursor；追加后的旧 cursor 上界冻结；新追加正确轮数据、旧轮过滤、pending JSONL tail 不修复写盘、补齐后只出现一次、空刷新稳定。scalar refresh=true 拒绝，改为无 cursor 重读。
6. Origin 与 Sec-Fetch-Site 403、同源 200；无效 owner/task/view 404；403 在 runtime 创建前拒绝。
7. 实际 router 的 tabId 优先级不能让 A runtime 读取 B；同 child agentId 在两 owner 只返回各自内容；ownerSessionDir/ownerSessionId/agentId/path/sessionDir 伪造与重复 query scope 不绕过绑定；非法数值拒绝。
8. runtime secret、Bearer、结构化 api_key 不出现在全文响应；hidden/system/旧轮正文排除。脱敏全文期望使用公开 redaction primitives 的实际三阶段组合，另独立检查原秘密串确实不在 wire 中。
9. 真实 `/api/state`：仅当前 generation + visible channel 的 visibleText 可展示且注册表脱敏，保留 truncated 标记；终态/活动态旧 visibleText、hidden channel、legacy lastText 无公开回退；owner 隔离；活动态旧 result 不公开。
10. snapshot current/archive 的 startedAt/completedAt/durationMs 精确等于各轮真实字段；createdAt/updatedAt 特意不同，不当作计时依据；无计时字段的任务不伪造，终态 duration 不随重读增长。
11. 三 view 均在实际读取脱敏期间注入切轮，确认 hook 确实执行，响应 unavailable 且没有 items/delegation/report 晚到内容。
12. snapshot 全响应额外收集注册表 secret 泄漏；若发现则继续跑余下用例、完成清理后 exit 1，不静默放过生产缺陷。最新主 index 整体注册表脱敏接入后 `defects: []`。

## 调试与边界发现（已告知主）

- 前任基线首次运行 exit 1：期望只考虑 runtime secret placeholder，但 resolver 还有第二次结构化脱敏，placeholder 也会匹配；已修测试期望，没有改生产脱敏。
- 增加 snapshot 时修正 fixture 为每 owner 独立预加载 store；这是测试构造问题，不归为生产缺陷。
- 修复测试 scope union spread 的 `undefined` 类型问题，显式 `Record<string, string>[]`；修正 NaN 经过 JSON 变成 null 的 HTTP 身份期望，非法请求依旧必须 unavailable。
- 一次运行恰逢主并发编辑 index，遇到 index.ts:1453 `Expected ')' but found ';'`；未改该文件，待主完成后重跑成功。
- 最新实际 HTTP 中 `refresh=not-a-boolean` 被转为 false，不是 resolver 参数类型拒绝。属于路由参数校验宽松问题；未观察到 scope 绕过，建议主决定是否收紧，不在本测试任务改生产。
- 未知路径/owner 参数在 HTTP 层被丢弃，而不是传给 resolver 触发 unknown-key rejection。已实测不能改变可信 scope；不能把 resolver 的严格未知键拒绝说成 raw URL 行为。
- preparation 文档关于“refresh 不带 cursor 从头”与当前实现不一致：实际 `refresh=true` 无 cursor unavailable；新快照须不带 cursor 且不设 refresh=true。测试按真实实现与代码注释的 drained cursor 契约验收，提请主统一文档。

## 主代理后续修复与复验

- 新增当前报告/error 的1500字符边界、归档报告/error 的600字符边界真实 `/api/state` 回归。注册秘密跨裁剪边界时，旧实现实际 exit1 暴露秘密前缀；主修 index 先整值脱敏再裁剪后通过，源对象不修改。
- HTTP `refresh` 现在仅接受省略/true/false，其他拼写404。测试从宽松行为记录改成拒绝断言；没有降低权限校验。
- preparation 已明确新快照无 cursor 且不设 refresh:true。未知附加参数仍被丢弃且不能覆盖可信 owner/task/run。
- 增加 `redactionVersion:1` 安全预览管线来源：无标记旧裁剪尾部不公开；报告 `displaySource:agent_report|visible_text` 来源不明时 current/archive 全文接口 unavailable，snapshot 不返回旧文本，不回读 output.txt 或猜其他轮次。
- 主最新真实运行 `node node_modules/tsx/dist/cli.mjs src/web/smoke-agent-content-http.ts`：exit0，953断言、119 HTTP、5 runtime，modelCalls=mutations=0，defects=[]，清理完成。此前927/115与932为新增来源拒绝前的中间计数。

## HTTP子任务原最终实际运行（历史）

工作目录：`C:\Users\qyq\Desktop\work\neoctl\engine`，Windows，Node v22.12.0。

```text
.\node_modules\.bin\tsx.cmd src/web/smoke-agent-content-http.ts
exit 0
ok: true
assertions: 923
requests: 114
runtimeCreations: 5
modelCalls: 0
mutations: 0
defects: []
cleanup: HTTP closed; temporary root removed
```

```text
npm.cmd run typecheck
> tsc -p tsconfig.json --noEmit
exit 0
```

最终数字为新增空源/变化和三 view 切轮后的结果；此前 848 断言/106 请求是中间通过结果，不作为最终验收数。

本记录只代表 HTTP 专项及此次 typecheck，不代替其他 22 项/主 UI/artifact 测试，也不标 OBS 整项完成。
