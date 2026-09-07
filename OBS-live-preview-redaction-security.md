# Live preview 安全阻断修复（2026-09-07）

## 范围与协作接口

本任务只修改：
- `engine/src/agents/local-agent-task.ts`
- `engine/src/secrets/secret-redaction.ts`
- `engine/src/secrets/secret-types.ts`
- 追加授权：`engine/src/tasks/task-persistence.ts` **仅 visibleText 函数**（unique edit；result 函数由报告安全代理负责）
- 专属新测试 `engine/src/agents/live-preview-redaction-security.test.ts`
- 追加授权：`engine/src/agents/obs07-11-run-facts.test.ts` **仅 preview fixture/期望、legacy 拒绝**
- 本安全记录。

未修改 agent-tool/core/query/core/run-agent/index/App/CSV；未提交、未派生代理。仅使用合成凭据与临时 fixture，未读取真实秘密、未调用模型。

接口：

```ts
updateProgressFromEvent(task, event, runGeneration?, secretRedactions?: SecretRedactionRegistry): void
createStreamingRedactor(options?: { incompleteSecret?: "preserve" | "redact" })
// progress.visibleText 新增（兼容旧代码的可选类型）
redactionVersion?: 1
// 按主要求补充类型，产出与持久化 result 由另一写者负责
AgentToolResult.displaySource?: "agent_report" | "visible_text"
```

已检查另一写者的 agent-tool 两处调用均传入第四参 `input.context.secretRedactions`。主 index/HTTP 负责只展示 `redactionVersion === 1` 的 snapshot preview，以及报告/error/archive 整值先脱敏后裁剪；不将本测试结果冒充主侧 HTTP 测试结果。

## 先复现再修

修复前先写并真实执行前四项安全测试，结果 **0 pass / 4 fail**（exit 1）：
1. 注册 `SYNTHETIC_CREDENTIAL_0123456789` 后输入 `secret + 'x'.repeat(3990)`，原代码 4000 尾裁剪确实得到以 `0123456789` 开头的公开预览；此时再整值 redact 已无法匹配原秘密。
2. 逐字符 visible delta 在第一个 `S` 就公开秘密前缀。
3. 未完成秘密前缀进入 task.json 的 legacy `lastText`/visible preview。
4. 流创建后新注册秘密不更新旧 carryLength，导致前缀直接发布。

## 修复设计与取舍

- **先流式脱敏，再分别裁剪 visibleText 4000 / lastText 1000**，不将原始 delta 写进这两个 bounded 字段。
- `WeakMap<LocalAgentTask, state>` 按对象身份和 runGeneration 隔离。visible 和 legacy 分开 stream，未标记 delta 不进入 visible carry；不同 task（包括复用同 id 的不同对象）不共享 carry。
- carry 仅存于 stream 闭包，不挂在 task/progress/DTO；resume 更换 generation 后丢弃旧 carry，旧代事件在修改进度前拒绝。
- terminal/completed/failed/killed **不调用 flush**，直接释放未公开 carry。终态后迟到 delta 不再发布；完整消息也不成为 visibleText fallback。
- 已接入 registry 后省略第四参不会降级为明文。没有 registry 的真实 delta 保留无秘密环境兼容；只有整值 redact、无 streaming API 的 registry 则关闭 live 文本输出，避免逐 delta 猜测安全。
- streaming push 每次读取当前注册集合，仅保留可能成为秘密的后缀，普通尾部/空白即时发布。完整短秘密若同时是长秘密前缀则暂缓到消歧，避免长值残余泄露；支持 Bearer/trimmed 变体。
- **终端默认 flush 语义保留**：默认 `preserve` 返回整值脱敏后的普通/不完整尾部；新 `incompleteSecret: "redact"` 策略用 `[secret:incomplete]` 替代歧义尾部。live preview 选择 redact 策略但实际不 flush。未全局改成吞掉终端尾部。
- **旧 bounded preview 不可追溯修复**：新安全 delta 只继承标1的同代 preview；新 registry/新代初始化不将旧尾部作为安全种子。DTO visibleText 读写均拒绝无标记、版本0、字符串版本等；标1保留。恢复旧终态和归档时不等待任何新事件即可清除 legacy preview。
- `redactionVersion: 1` 仅表示当前“安全处理后再裁剪”的实现版本，并非密码学证明，也不保证将来才注册的秘密永远未曾出现。注册必须在秘密首次输出前完成；已经公开的未知秘密前缀无法由任何流事后收回。完整报告仍走整值脱敏，不从 preview 重建。

## 实际验证

最终执行（非模型、真实 TaskStore/临时 task.json/真实子进程）：

| 命令（engine 下） | 结果 |
| --- | --- |
| `node --import tsx --test src/agents/live-preview-redaction-security.test.ts src/agents/obs07-11-run-facts.test.ts` | **43/43 pass**：新安全18 + 旧run-facts25 |
| `npm run typecheck` | **exit 0**（并行代理早先接口未对齐时曾失败；最终重新执行通过） |
| `node --import tsx src/secrets/smoke-secrets.ts` | **ok true**，包括 exec/redaction/splitChunk |
| `node --import tsx src/tools/smoke-terminal-output-chain.ts` | **13/13 checks**，含真实进程、跨chunk秘密、final flush、Unicode/CRLF、PTY、65次运行 |
| `node --import tsx --test src/tools/terminal-output-store.test.ts` | **19 pass / 0 fail / 1 skip**；skip仅Windows文件symlink权限，junction/hardlink实际运行 |
| `node --import tsx src/web/smoke-terminal-output-http.ts` | **318 assertions / 62 requests / modelCalls 0 / mutationCalls 0**，listeners/process/temp已清理 |

专属测试覆盖：secret+3990 x、每字符 delta、未完成前缀不进入 JSON、task/generation/visible与legacy隔离、terminal不flush、动态新注册（含较长新值）、所有切分点/Bearer/trimmed/前缀重叠、无registry/空registry/已注册registry 的 `0`、空串、空白、精确4000与sticky truncated、脱敏后长度、whole-value-only registry fail-closed、旧无marker终态与归档无新事件恢复拒绝、final message 不污染安全preview。

`git diff --check` 对本任务独占3个实现文件通过。共享 task-persistence 当前为 CRLF，默认检查将 CR 报 trailing whitespace；未越权整文件改行尾。使用 `git -c core.whitespace=cr-at-eol diff --check` 对含该DTO的授权实现文件通过。
