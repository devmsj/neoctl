# OBS-03 / OBS-05 独立 TerminalOutputStore 交接

日期：2026-09-07。结论：独立模块及定向验证已交付；**OBS-03 / OBS-05 整项不标完成**。未接 manager、exec-tool、web index、App.vue、session 或共享 types。未修改 CSV、未提交。本次仅新增本记录及 engine/src/tools/terminal-output-store.ts、terminal-output-store.test.ts。

已读取桌面待修复-AI修复规范目录全部 7 文件。前置状态以主代理最新通知为准（OBS08/OBS06 已完成），不据此越权接运行链。

## 精确 API（全部同步，不返回 Promise）

```ts
new TerminalOutputStore({
  sessionsRoot,
  resolveOwnerSessionDir?: (ownerSessionId: string) => string | undefined,
  now?: () => number,
  maxBytesPerRun?: number,
});
restoreSession(ownerSessionId, ownerSessionDir);
start(ownerSessionId, ownerSessionDir, runId, metadata);
append(ownerSessionId, runId, redactedTerminalChunk(stream, offset, text));
finalize(ownerSessionId, runId, facts);
evict(ownerSessionId, runId);
read(ownerSessionId, runId, { stream, offset?: number, limitBytes?: number });
listHistory(ownerSessionId, { offset?: number, limit?: number });
sweep();
```

- 单进程单实例单写者，每个 sessionsRoot 一份。没有定时器、manager 订阅、全局实例或槽位策略。
- 返回 StoreResult<T>：`{ok:true,value:T}` 或 `{ok:false,reason}`；reason 为 invalid-input / unsafe-path / not-found / conflict / io-error。集成层不得把存储失败转换为进程执行失败。
- start/append/finalize/evict 返回 RunView：`{record,persistence:'stored'|'memory-only'}`；append 另含 duplicate。memory-only 指最新元数据尚未持久化，正常 running append 也会出现，并不单独代表 I/O 故障。
- record.availability 为 available / expired / evicted / lost / io-error，与 lifecycle running / terminal / lost 分域。
- metadata：必需 startedAt；可选 processId、tty、sessionId（真实终端 session_id）、status（原始启动状态）、command、cwd、shell、description。文本必须已经脱敏。UTF-8 字节上限分别 command=4096、cwd=2048、shell=256、description=2048、status=120、sessionId=160；超限明确 invalid-input，不静默截断。不存 env、stdin、运行时对象；缺失保持未提供。
- facts：finishedAt、exitCode:number|null、signal:string|number|null、terminationReason:string|null、durationMs:number|null；可选 status 保存真实终态 manager 状态。**终态展示使用 exit.status，不使用 metadata.status 的启动快照**。不由退出码猜状态、信号或持续时间。0/null 原样保留。重复相同 finalize 幂等，不同事实拒绝覆盖。lost 不允许伪 finalize。
- runId 是存储身份，建议直接使用真实 terminal session_id，同时 metadata.sessionId 明确保存；所有读写必带 owner。不得创建第二份历史元数据存储。
- read 返回 OutputPage：RunView + stream、offset、nextOffset、text、endOfStoredOutput。两个流独立 UTF-8 字节游标，无跨流顺序。每页默认 64KiB，允许 4B–256KiB；仅接受 Unicode 边界游标，返回完整 UTF-8 前缀。`text:null` 表示不可获取，`text:''` 才是有效空结果。endOfStoredOutput 不等于进程结束或全文未截断。
- listHistory 只返回 terminal/lost 元数据，不含正文或预览；offset/limit 默认 0/50，最大 200，返回 records/nextOffset。分页是当前历史列表，若运行转终态同时改变列表，UI 应重新加载，不能视作固定快照游标。

## manager 集成顺序与边界

1. 从可信会话注册表提供 sessionsRoot 和真实 ownerSessionDir。默认只接受 root/ownerID；agent child 由 resolveOwnerSessionDir 回调映射真实嵌套路径，不接受 HTTP 参数指定目录。回调自身是授权边界，不是任意路径放行函数。
2. 启动恢复对已授权会话显式 restoreSession，执行 lost 转换和过期清理；不扫描所有会话。start 首次绑定也会恢复该会话。
3. 进程创建时 start（保存真实 sessionId/命令/目录/状态）；之后只从**按流 streaming redactor 输出及最终 flush**建立 redactedTerminalChunk。该工厂是显式信任声明，不是脱敏算法；运行时拒绝无品牌普通对象，不能证明调用者真的脱敏。
4. offset 是该流脱敏后累计 UTF-8 字节数（包括超预算丢弃部分），不是原始字符数、合并 liveText 游标或 drain 计数。连续新片段必须 offset 精确接续；已消费区间重试不再追加（信任源同位置内容不可变），空洞/部分重叠拒绝。不使用 drain / 有界预览 / 累计快照作为源。
5. finalize 必须在真实退出及 redactor flush 后调用。store 不接触进程，也不生成退出事件。
6. 现有 manager 全局 64 槽位淘汰时调用 evict；不得增加 store 每会话数量策略。即使显式 evict 运行中输出，真实退出 facts 仍可随后 finalize。
7. 集成层定期 sweep，读取本身也同步检查 TTL；不依赖定时器及时触发来授权读取。UI/API 只分页读取，不把正文塞入 state 快照。不能声称本交付已经接入复制/下载/UI。

## 文件、预算与故障契约

- ownerSessionDir/terminal-output/r-SHA256(runId)/ 下仅 metadata.json、stdout.txt、stderr.txt。路径由身份派生，元数据不含可用作读取/删除的任意路径。
- 共享 64MiB **输出**预算，可注入更小值测试但不能提高。两个流共享容量，首次超额后保留既有完整 UTF-8 前缀，后续仅累计 observedBytes，明确 truncated；storedBytes 为已保留量，不伪造省略正文。元数据独立上限 16KiB。
- running append 仅同步写对应输出文件，不 fsync、不重写整份元数据。终态前 fsync 两流，然后 wx 临时元数据 + fsync + rename 原子替换；启动、淘汰、恢复及异常转换保存元数据。遵循现有 task 存储模式，没有新依赖。
- 输出终态后严格 300000ms 内可读；精确到期拒绝，输出文件清理后元数据与退出事实随所属会话保留。evict 可提前撤销输出。过期拒绝不因清理失败变成空白成功。
- 重启残留 running 标 lost，exit/expiresAt 仍 null，不伪造 finishedAt、完成或失败；输出立即撤销并尝试清理。lost 的计数仅为最后元数据检查点（不代表崩溃前完整总量），不能当全集统计。没有重新开放五分钟窗口。
- I/O 错误明确 availability=io-error；保存失败 persistence=memory-only，真实退出事实仍可在当前进程读取。磁盘不可写时无法承诺重启保留失败那次事实，不以工具失败掩盖存储失败。start 尚未能安全建目录时可能直接返回 StoreResult 失败，集成仍须继续执行原进程。
- read 路径/文件安全错误可能返回 StoreResult 失败而非 OutputPage，调用者必须同时处理 ok 和 availability。

## 安全实现与明确限制

逐级 lstat/realpath 检查根到实际 owner 路径及存储子目录，拒绝 symlink/junction；普通文件只接受 nlink=1，并在打开后/使用后比较文件身份。Windows 运行时 lstat.dev=0 而 fstat.dev 为真实卷值，因此 Windows 比较 bigint inode（避免 JS Number 文件 ID 丢精度）；非 Windows 同时比较 dev。支持时使用 O_NOFOLLOW。

复用现有存储的安全/原子写入做法，不直接导入 task-persistence（会引入代理运行时依赖）。清理仅处理已注册且元数据验证过的记录、固定 stdout/stderr 文件；不递归 rm、不删除未知文件、不清扫任意目录、损坏记录不覆写。单写者/同 OS 权限信任模型，不宣称防御恶意同权限进程并发换目录的所有 TOCTOU，亦不宣称多进程锁或断电事务。

## 测试证据

2026-09-07 Windows，在 engine 目录运行：

- `npx tsx --test src/tools/terminal-output-store.test.ts`：20 项，19 pass、0 fail、1 skip，约 1.63s。
- skip：文件 symlink 创建缺 Windows 权限；并未伪称通过。真实 root/session/storage/run junction、嵌套中间 junction、输出/元数据 hardlink 测试均通过。
- `npm run typecheck`：通过。
- `git diff --check`：通过。
- 覆盖：双流多行/空行/缩进/Unicode 分页、非消费读取、owner 隔离、路径攻击、品牌输入、重试/间隙、100 append 元数据不变化、小预算/零预算/共享容量、0/非0/信号/null、假时钟精确 TTL、刷新及 lost 恢复、65 条记录不自行淘汰、写盘失败、原子目标失败保留旧 JSON、元数据白名单及大小、嵌套 owner 绑定和清理边界。
- 前两次失败已真实定位并修复：Windows dev 差异导致误拒绝，以及测试辅助函数断言后的 TS never 收窄。临时 debug 输出已删除。

后续必需验收属于 manager/API/UI 集成：真实分流脱敏和 flush 来源、退出事件不丢、64 槽位 evict 通知、后台/中央一致读取、终态详情保持与重开、刷新授权、复制下载。整项保持未完成；本模块是唯一待接入存储，不另写第二套。
