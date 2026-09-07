# OBS-03/05 终端输出真实 HTTP 测试记录

- 日期：2026-09-07
- 仓库：`C:\Users\qyq\Desktop\work\neoctl`
- 环境：Windows / Node v22.12.0 / PowerShell
- 本次仅新增：`engine/src/web/smoke-terminal-output-http.ts`、本记录。
- 未修改生产文件、`index.ts`、`App.vue`、manager、CSV、package scripts；工作区其他修改属于并行任务，未提交或覆盖。

## 执行与结果

工作目录：`C:\Users\qyq\Desktop\work\neoctl\engine`

```powershell
.\node_modules\.bin\tsx.cmd src/web/smoke-terminal-output-http.ts
.\node_modules\.bin\tsc.cmd -p tsconfig.json --noEmit
```

最终版本连续执行 smoke 两次，每次均：

- **318 条成功断言 / 62 次实际 loopback HTTP 请求 / exit 0**。
- `modelCalls: 0`、`mutationCalls: 0`。
- 每次创建三个真实 HTTP server 生命周期，用于初始读取、刷新恢复、过期后再次刷新。
- stdout 返回 `ok: true`，stderr 为空。
- 最终全量 TypeScript `--noEmit`：**exit 0**，stdout/stderr 为空。
- 初版曾执行 303 条断言 / 61 次请求并通过；后续补充 running→0、磁盘脱敏、同 run history 退出事实等断言后，以 **318/62** 为最终数据。

## Fixture 边界

复用 `smoke-tool-detail-fields-http.ts` 的真实 `runWebServer` + 捕获 `http.createServer` 以便关闭监听的 fixture。使用真正的 `WebRepl` 实例和生产 router、`terminalOutput`、`snapshot`、`backgroundTasks`、`terminalTaskHistory`，不重写 HTTP handler、不直接以调用 reader 代替 HTTP 验证。

只注入最小 runtime/engine/taskStore fixture：会话 A/B 均为 `os.tmpdir()` 下全新目录，实际目录是嵌套的 `runtime-sessions/actual-A|B`，不是按用户参数拼出的目录。读取过程使用真实 `ExecProcessManager`、真实 `TerminalOutputStore`、真实磁盘和真实 Node 子进程。独立 store 注入假 clock；只有跨 owner 同 run-ID 的 B 记录用公开 store API 准备，以保证确定性的身份碰撞，结果仍通过真实 HTTP 验证。

未实例化外部模型 provider，不调用外部模型，不读取真实用户会话。engine mutation/submit 入口设置计数并抛错；所有 HTTP 请求只发往 `127.0.0.1`。

## 覆盖断言

1. **完整双流和非消费 GET**
   - 真实进程输出多行、空行、空白行、重复行、中文和 emoji。
   - stdout/stderr 内容刻意完全相同；分别读取均逐字等于原文，无去重或合流。
   - 多次 GET 保持原文；其后第一次真实 `interact` drain 仍得到双流全文，第二次 drain 为空；再 GET 仍得到全文。
   - 200 envelope 的 owner/run 与 record 的 owner/run 一致，`Cache-Control: no-store`。
2. **64 KiB UTF-8 游标**
   - 155,540 字节输出分成三个 HTTP 页面，首个 emoji 从 byte 65,535 开始，首游标精确停在 65,535。
   - 每页不超过 65,536 字节，`nextOffset-offset` 等于该页 UTF-8 字节数，不出现 replacement character。
   - 全页拼接严格等于原文，不重不漏；EOF 返回空字符串且游标稳定；真实空 stderr 同样为空而非 null。
3. **owner/run 身份与 snapshot**
   - A/B 同 run-ID 读取各自原文；A exit 7、B exit 0 的 history 保持各自事实。
   - B 请求 A 独有 run 返回 404。
   - A/B 同时运行时各 snapshot 仅有自己的一个 active 任务，计数、owner 身份、history 均隔离。
   - active/history 不携带 output，lines 始终为空。
4. **退出事实**
   - 非零与零退出进程均先经 HTTP 观察到 running 和 exit=null，再以 stdin 触发真实 exit 7/0。
   - 真实 kill 后 HTTP 与 manager 的 status、exit code、signal、termination reason 相符。
   - 被停止任务退出 active 并进入 history，保留 `killed` / `user_kill`；零退出保持 `exited` / `completed`。
5. **脱敏**
   - 真实 secret registry 登记测试 secret，进程分两次写出 secret，stdout/stderr 最终为脱敏 marker。
   - 读取所有 fixture 磁盘文件，确认已持久化 marker 且注册 secret 原文不存在；HTTP record/metadata 也无原文。
   - 另一个测试值在进程退出后才登记，验证生产 `WebRepl` 最终响应脱敏，并确认游标仍针对已存 UTF-8 字节而不是脱敏后的响应长度。
6. **访问守卫与拒绝**
   - 跨 origin、错误 Origin 均 403，同 origin 200；403 在创建 runtime 前发生。
   - 非 GET、缺失 session/run、未知 owner/run、路径穿越、Windows 绝对路径/保留名、NUL、错误 stream 均拒绝。
   - 负数、小数、NaN、Infinity、不安全整数、越过已存输出、落在 UTF-8 continuation byte 的 cursor 均拒绝；非法 limit 均 404。
7. **刷新恢复和 lost**
   - 重新构造 store、manager、server、router、runtime，HTTP 仍读到已完成全文和同 run-ID 的 owner 隔离。
   - 旧 manager 的真实 B 子进程仍确实运行，新的 manager 恢复其持久化 running 记录后通过 HTTP 展示 lost，output=null、exit=null、lostAt 非空；不伪造成功/失败退出。
   - 刷新 snapshot 无该残留 active，history 为 lost；已知 exit 7 保留。
8. **TTL**
   - 检查过期时间等于 finishedAt + 五分钟。
   - fake clock 推到 expiresAt-1 时全文可读，精确到 expiresAt 时双流 null，availability=expired，完整 exit 对象/lifecycle 保留。
   - history 保留 exit 和 expired 状态，再次全量刷新不复活输出或续期。
9. **只读与释放**
   - 比较所有非 terminal-output 文件的字节级快照：无新增/修改，包括预置 `transcript.jsonl`。
   - model/submit 和 mutation 计数均为零。
   - finally 关闭 HTTP 连接/监听，恢复 `http.createServer`，终止并等待所有真实进程不再 running，删除临时会话根目录；清理断言计入 318。

## 范围说明与缺陷

- 最终覆盖范围内未发现失败断言或生产缺陷，不存在绕过 HTTP 的通过路径。
- lost 测试是“真实运行进程对应的持久化记录 + 新 manager 恢复”的边界测试，并非操作系统崩溃仿真；旧进程由 finally 负责终止。
- 不宣称本测试覆盖浏览器 Vue 展示、真实用户登录授权、host 崩溃注入、64 MiB 容量淘汰或 symlink/junction 攻击。这些不是本文件已执行的断言。
- 文件使用 UTF-8、LF。
