# OBS04/07 独立只读 resolver 准备（非整项完成）

2026-09-07。仅新增 `engine/src/web/agent-content-detail.ts`、同名 `.test.ts` 和本记录。不接 UI/index，不改 agents/core/types/CSV，不改 fail/kill 生命周期，不提交。已阅读规范目录及最新 `OBS-04-data-preparation.md`。

## 主接入 API

```ts
import { createAgentContentDetailResolver } from './agent-content-detail.js';
const resolver = createAgentContentDetailResolver(); // server 生命周期单实例
const owner = {
  ownerSessionId: authorizedSession.sessionId,
  ownerSessionDir: authorizedSession.sessionDir,
  taskStore: alreadyLoadedTaskStore,
  redact: (value: unknown) => runtime.engine.redactDisplayValue(value),
};
const request = { taskId, runGeneration, pageChars: 16000 }; // 客户端字段
await resolver.timeline(owner, request);
await resolver.delegation(owner, request);
await resolver.report(owner, request);
```

- `owner` 必须来自已授权会话，尤其不能把客户端 sessionDir/agentId/path 放入 owner。路由层仍负责同源检查/会话授权；resolver 未提供 HTTP 路由。
- request 只允许 `taskId, runGeneration, cursor?, pageChars?, refresh?`；拒绝其他键。pageChars 为 256..65536 的整数，默认 16000。
- 所有结果带 `ownerSessionId/taskId/runGeneration`，以及 `state/reason`。调用方切换对象时必须核对请求身份及快照，丢弃迟到响应，不能仅按 taskId 更新。
- 三方法只调用 `TaskStore.getInSession`。**不得为 GET 临时 load/bind TaskStore**：现有 load 会恢复生命周期并写盘。宿主先加载；resolver 不执行恢复。

### timeline

源为 `<owner>/subagents/<task.agentId>/transcript.jsonl`，child 的 entry.sessionId 与 entry.agentId 均须等于 task.agentId，不是父 sessionId。

只取 `type: message` 且 entry 顶层 runGeneration 严格等于请求轮次。assistant 的 text block 仅 `displayChannel: visible`；工具仅 assistant/tool_use、tool_result/tool_result 对应角色。过滤 meta/system/继承无轮次/compact/未知正文通道/thinking，不读 task.messages、progress.steps 或 lastText 作为正文。

- `items[].kind` 为 assistant/tool_use/tool_result；content 分别为脱敏正文/JSON 参数/真实结果。工具带调用 id、工具名和源状态；tool_use 是 invoked，不推断仍在运行。tool_use.object 复用 OBS06 字段投影（补 terminal 命令/session_id），明确 missing/摘要截断；result 可通过 toolUseId 关联先前调用。不把目的用作对象。
- 分片 content 带 `offset/totalChars/hasMore`，UTF-16 偏移，避免截断代理对；先对整个有界源值执行 OBS01 + runtime 秘密脱敏，再分片，不能对原始秘密分片后脱敏。结构化输入/结果的分片应拼完后解析 JSON。
- 同一快照使用 `nextCursor` 继续；`items[].id = 原始行字节位置:block索引`，按完整 owner/task/run/snapshot 身份和 id+offset 幂等合并。同 cursor 重试不能直接重复追加。
- `state: complete` 仅表示上界内可读完整行耗尽，不证明任务完成、存在可展示正文或工具结果完整。各 content.state 独立为 complete/truncated/missing/unavailable。
- 耗尽后返回 `refreshCursor`。增量请求 `{...request,cursor:refreshCursor,refresh:true}` 从旧位置继续且更新上界；未提交尾行留在原位，`pendingTail:true`，补齐换行后再读。新快照从头读取须不带 cursor 且不设置 refresh:true，客户端应替换而不是追加；refresh:true 仅接受已耗尽的 timeline refreshCursor，无 cursor 时明确 unavailable。
- 游标使用服务实例内随机 AES-GCM 密钥，绑定 owner/task/agent/run/方法/文件身份/上界/位置；30 分钟或实例重启后失效。含文件首尾上界锚点及元数据校验，拒绝替换/缩短/检测到的非追加修改。**依赖现有 append-only transcript 契约；不是对恶意原地改写整文件的全文件认证**。

### delegation / report

- delegation 仅 task.prompt、task.description；scope=task，明确不是该轮 resume directive。prompt 分页，description 2048 字符明确截断。不混父上下文、executionOptions、pendingMessages。
- report 精确选择当前 task.result 或唯一 runHistory 匹配轮；旧轮淘汰为 missing，不回退当前。result.agent_id 必须匹配 task.agentId。不存在报告时仍保留真实 taskStatus/error；空报告与 missing 区分。
- report.reportStatus 仅返回源 completed/incomplete（未知不默认完成）；content.state 是保存内容完整性，taskStatus 是生命周期，三者独立。error 保留真实源文本并脱敏，超 4096 字符明确截断。
- report/委派游标绑定脱敏内容和元数据摘要；源改变拒绝继续拼接，重新无 cursor 读取。无 output.txt 读取或拼入 prompt。没有报告时不启动模型获取。

## 安全与有界限制

- 所有路径祖先、owner/subagents/child、引用 tool-results 均检查 lstat/realpath，拒绝链接/junction。普通文件 nlink 必须为 1；读取前后检查句柄与命名文件身份。Windows 的 lstat.dev=0 与 fstat.dev=卷号差异已实测，Windows 用 file index+birthtime 对照，目录另行检查。
- 不创建目录/文件，不写文件，不打开 SessionStore，不调用模型、续跑、消息或任务状态变更。错误不给底层异常路径/原始上下文。
- 每次扫描约 4 MiB 的完整行后可返回空 partial 页；单行可超过 pageChars 并分片，但最大 16 MiB。超限/损坏明确 unavailable，**不跳过并假装全文**。单页最多 64 fragments。内存只缓存有界当前 entry，不加载全 transcript。
- 工具秘密/config 类工具不展示；其它工具值复用 redactToolDetail，并要求注入 runtime 脱敏。此标记/过滤不是任意模型上下文公开授权。
- persisted-output 仅接受 child/tool-results 下严格由调用 id 派生的 txt/json 路径。扫描上界内所有轮调用，拒绝 lossy 文件名碰撞/重复调用/缺用例；路径 dot 等模糊 id 保守拒绝。扫描上限 32 MiB、引用文件上限 16 MiB，无法证明时 content unavailable 且不输出原始引用预览。
- 引用文件本身没有 runGeneration：旧轮一律不解引用；当前轮也要求 transcript 未增长且调用唯一，读取后再检查。不能冒用续跑覆盖的工具结果。内嵌原始结果仍按精确轮分页。
- 读取期间 task 当前轮变化会丢弃该响应并返回 unavailable；接入方仍须隔离发送后切换轮次的迟到请求。

## 验证

中途测试类型错误已改为 `import test, { type TestContext } from 'node:test'`；首轮 Windows 文件 dev 差异误拒绝已修复。最终执行 `npx tsx --test src/web/agent-content-detail.test.ts`：14 tests、14 passed、0 failed、0 skipped；随后 `npm run typecheck`，整条命令退出码 0。三个新增文件经严格 UTF-8 解码检查，无 BOM、无 CR、无行尾空白，git 状态均为未跟踪新增，未暂存或提交。

专项覆盖真实 task.json/transcript.jsonl、>24/8 条、多个 block、空文本、长 UTF8/emoji 单行、多页无重复遗漏、同 cursor 重试、追加上界/未提交尾行刷新、跨 owner/run/方法/篡改游标、文件替换、嵌套/文本/runtime 秘密、真实工具对象与失败结果、当前/旧/淘汰/重复轮报告、报告空值与变化、junction（owner/subagents/child/tool-results）、hardlink（task/transcript/引用）、引用越权/碰撞/缺失/旧轮、损坏和超限拒绝、有界过滤扫描、读取前后目录/文件 hash+mtime 和 task 对象无变化。

剩余：正式 HTTP/UI 接入、取消/迟到响应展示验收、复制/下载及完整 OBS04/07 验收未做；不标整项完成、不改 CSV。
