# Core 原生计时

## 事实源与范围

`core/query-timing.ts` 的 `QueryTimingState` 是计时事实源，不依赖 Web、SSE 订阅或浏览器。耗时仅用 `performance.now()` 单调时钟计算；`Date.now()` 只记录可读 ISO 日期。系统时间回拨不会改变耗时。测试可注入 `TimingClock`。

- **query**：从进入 `query()` 的循环前开始，到循环返回终态或异常/提前关闭为止。覆盖上下文准备、模型调用、重试、工具及多轮循环；不包含 QueryEngine 初始化、输入图片入库、Web 上传与 Web 输入排队。异步生成器消费者施加的等待属于此次 query 的实际生存时间。
- **firstOutputMs**：第一次非空文本/思考/工具参数增量、工具调用或非空最终 assistant 消息到达 core 的延迟。不是供应商 TTFT，也不是用户可见首字时间；最终 query 记录与实时快照提供此字段。
- **tool queueMs**：整批进入调度到实际 worker 开始执行的等待，包括串行前置工具、并发限额等待。
- **tool durationMs**：worker 进入 `runToolUse` 到完成结果处理的耗时，包含参数校验、权限检查及工具执行，不等价于子进程 lifetime。开始和完成均在调度回调采样，不在 Web 消费事件时采样。

保留 legacy `tool.started` 的整批卡片创建语义，不再将其当成真实执行起点。同一调用 ID 在后续轮次重用时会分配新的计时记录 ID。

## 事件、持久化与恢复

`AgentEvent` 新增 `timing.updated`，携带 version=1 的独立 `TimingRecord`。每次 query 有随机 runId；工具记录通过 runId 关联 query，通过 toolUseId 关联调用。

- query 正常/失败/取消终态保存 `finishedAt`、`durationMs`、`outcome`；终态记录在 terminal 事件之前持久化。
- `finally` 不 yield，消费者 `return()` 也通过 sink 保存最终记录，避免终态丢失。
- query 关闭时还未结束的工具标为 `interrupted`，不伪造最终 duration/finishedAt。取消并不能证明不配合取消的工具/外部进程已经停止；迟到回调不得改写已关闭计时。
- SessionStore 以独立 `{type:"timing", timing:...}` transcript 行保存状态跃迁，不按每秒刷新写盘。子代理记录仍携带已有 runGeneration。
- 恢复时按 record ID 折叠最新状态。进程退出前未结束的记录恢复为 interrupted/process_interrupted，不用墙钟补算耗时。旧会话没有记录则为未知。
- `QueryEngine.getTimingRecords()` 提供历史事实与当前 live 快照，返回独立拷贝。reset/newSession 清理，resume 恢复。

## 缓存隔离约束

计时只走观测事件、独立 transcript 行和展示层。不写入：

- Message 正文、blocks、metadata；
- 工具 output、ToolUseContext、工具定义；
- system prompt、动态上下文、ModelRequest；
- prompt cache identity/key 或缓存诊断输入。

恢复后的 `getInitialMessages()` 和 display entries 也不包含 timing 行。原有工具自身输出的业务 duration 与子代理生命周期协议不在此次迁移范围内，保持原语义。

回归测试用不同墙钟、单调时钟步长和随机 runId，对比 Chat/Responses 完整 wire body、缓存 identity 与 context metrics；覆盖普通回复、截断续传、工具多轮及持久化恢复。此验证证明新增观测字段不污染模型输入，**不代表实测供应商缓存命中率**；没有调用付费模型。额外本地记录会产生少量执行开销，不改变缓存输入结构。

## Web 展示

Web 从 core 快照接收 elapsedMs，运行中只用浏览器单调时钟做展示插值；最终只显示 core durationMs。刷新/重连重新取得 core 基准，绝不以页面挂载或 SSE 到达时间充当执行起点。断线停止插值，回到最后确认的 core elapsed（可能小幅回退），重连后校正。

普通工具和图片工具共用此路径；排队显示“排队中”。最终工具时长保留在 UiLine 的独立展示字段，当前状态只携带最近 query 的工具记录，避免每个 delta 重发全部历史工具计时。历史调用 ID 关联不唯一时宁可不显示，不猜测。底部展示最近一轮最终用时；完整历史 query 计时仍可通过 core API 读取。

本次未实现每个模型请求/phase 的完整 profiling，也未替换已有子代理/后台进程生命周期计时。

## 验证命令

```powershell
cd engine
npm run typecheck
node --import tsx --test tests/core/query-timing.test.ts tests/web/core-timing.test.ts
npm run build
cd ../web
node --test tests/core-timing.test.mjs
npm run build
node tests/core-timing-browser.test.mjs
```

浏览器测试需要安装 playwright-core 与 Edge（或设置 BROWSER_CHANNEL）；使用构建后的实际 App 与受控传输数据，不调用模型、不运行真实工具。
