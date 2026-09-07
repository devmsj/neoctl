# OBS-12 实施记录（2026-09-07）

## 编码前定位与范围
已阅读全部七份规范，无依赖。仅修改本插件、web/artifacts.test.mjs，新增 web/xhs-version-browser.test.mjs。未修改 App.vue、engine、CSV、其他源码；未提交推送。主代理管理总计划和 CSV。

根因已通过 draft report 通知主代理：registry.update 无版本条件；get 内存优先，多 registry 可陈旧；模型 read-before-update 仅提示；iframe 独立 draft 不检查远端版本，保存响应无条件替换正在输入的草稿。不能由此断言既有数据已经丢失。

## 最终契约与方案
选择旧实例只读 + 最新版入口，不改原 CSS/布局模板。磁盘 version 为正整数，旧记录缺字段归一为 1；updatedAt 不再充当版本。手工 PUT 必须 expected_version，缺失/旧版本 HTTP 409，返回 code/current_version；并发持锁 HTTP 423 artifact_busy。独占 wx 文件锁内重读磁盘、CAS、递增、原子 rename；磁盘失败不发布内存新值。读取不依赖缓存，恢复 transcript 也在相同锁中防覆盖。损坏磁盘不偷偷用旧 transcript 回滚。

**兼容修订：初稿 read_token/expected_version 工具参数方案已撤回。** 模型工具 inputSchema 完全保持 artifact_id/payload，模型不需要提供未知字段。已只读检查 engine/src/tools/tool.ts 的真实 ToolUseContext。read 缓存按 context.session.sessionId + context.agentId + artifact_id 隔离，存已读 version，30 分钟有效、最多1000条，更新尝试前消费。open 在同一服务端锁内使用缓存版本 CAS；重启/过期/重放/无read拒绝并要求重新读取。模型仍按现有契约保留读取到的用户字段（服务器不猜测用户允许的语义修改）。手工保存与模型共享一个 version。

owner 非空且与传入 session 严格一致，缺 session 或不同 owner 不可读写有归属稿件；旧无owner记录不能成为跨会话公共稿件。当前插件 route 的 sessionId 仍来自既有请求查询参数，这不是新增身份认证系统。

页面按 session/artifact/iframe槽隔离 sessionStorage 草稿；输入立即备份。远端更新仅置只读，不替换草稿；支持下载、刷新恢复、加载最新、显式恢复草稿供人工核对。恢复仅将草稿相对原始版本改变的字段合入最新数据，未改字段（如远端 review）保留；恢复不自动保存。同字段冲突由用户核对后点击保存。

保存串行，响应只在草稿与发出内容一致时回填；飞行中输入继续保留并排队。轮询、focus、online 查询补偿模型更新；迟到版本检查不能将已完成新保存误标陈旧。frame 通知核验 origin、实际兄弟 source、artifact/session，再查询服务端，消息不直接写入内容。原 resize 消息补 artifact/session，父级现有处理未改。

## 验收证据
`node --test web/artifacts.test.mjs web/plugins/xhs-artifact/version.test.mjs web/xhs-version-browser.test.mjs`

- 既有8个 xhs 测试全部执行；其中旧测试的直接 update 增加 session/version，read 增加真实 session；另断言模型 schema 属性仍仅 artifact_id/payload。
- 新增服务端测试：缺版本/旧版本拒绝、跨registry新读、磁盘失败原值保留/锁释放、4个独立 Worker/registry竞争同版仅一个胜出；模型会话/agent/artifact隔离、read过期、重放、重启拒绝、用户保存抢先冲突、不丢已保存用户正文；历史缺版本1、HTTP409/423/404、锁人工解除后恢复。
- Edge 独立 HTTP fixture 实际加载 createPlugin.route（不是模拟 editor）：三个 iframe（同artifact两个+另artifact一个）、手工保存使其他frame只读、最新版入口、模型抢先更新、旧草稿409、草稿下载并读取文件内容、刷新旧草稿恢复、显式加载/恢复且不自动保存；700ms延迟保存期间继续输入并最终存入服务端；远端review保留；跨artifact消息不影响另稿、不同/缺session404、刷新最新状态；网络失败草稿不丢/重试成功、20000字符长草稿、空正文校验失败不覆盖已存正文；无 pageerror。
- 样式测试将生成页面 `<style>` 与 git HEAD 原始 `<style>` 完整字符串比较；现有 CSS 不变。浏览器覆盖编辑/预览模式切换，未进行人工像素截图判读。

## 命令与已知限制
完整定向日志：`$env:TEMP\neoctl-xhs-obs12-tests.log`。最终统计由交付报告给出。
`node --check` 检查插件脚本；`git diff --check` 检查授权路径。现有文件恢复到 git HEAD 的 LF，diff 不再全文件变化。
纠正旧记录：从仓库根目录运行 plugins.test 导致相对路径错误，并非基线缺陷。在 web 工作目录运行 `node --test plugins.test.mjs` 为4/4通过；本次综合回归也从 web 运行。全web测试仍由主代理统一管理，不声称全库全绿。

锁崩溃残留采取保守拒绝，不自动删除可能仍有活跃写者的锁；需确认所有写者已退出后人工清理。已测该拒绝和清理后恢复，未模拟操作系统强制断电。sessionStorage 仅当前标签页会话保存，不新增长期保留政策；存储配额异常提示下载备份。浏览器文件下载、版本冲突与刷新已测；全屏、实际上传API、不同源恶意站点的完整攻击测试未新增实跑，原入口/外观未改。父页面现有resize消费者不在授权修改范围，未声明修改其校验策略。

## 执行状态
- [x] 全规范、根因/契约固定并通知主代理
- [x] 存储、模型兼容契约、HTTP实现
- [x] 编辑器只读、草稿恢复、飞行中保护
- [x] 服务端与Edge定向验收、既有xhs测试
- [x] 行尾及语法检查；全库基线失败交由主代理归档

## 竞争偶发失败复查（最新恢复任务，替代旧完成结论）
先强化失败诊断，不放宽loser断言：输出每个Worker code/message/syscall/path/stack、轮次；要求恰好一个version2胜者、恰好三个busy/conflict失败者，磁盘body必须等于胜者，version必须为2。通过 XHS_CAS_ROUNDS 可重复独立竞争。

实际复现：
- 修改生产代码前，200轮目标在round36失败：EPERM，syscall=rename，临时JSON→目标JSON；另外一个Worker成功v2。日志 TEMP/neoctl-xhs-cas-repro.log。
- 只增加rename重试后，500轮目标在round57再次失败：EPERM，syscall=open，路径*.json.lock。日志 TEMP/neoctl-xhs-cas-fixed-500.log。未将这两次失败算通过。

根因范围：Windows并发文件操作的暂时访问拒绝没有被处理。rename原子替换与无锁读取重叠、删除中的锁路径独占创建均可能暂时EPERM（日志确认系统调用/路径；未用内核句柄追踪进一步区分读者与杀毒软件）。原实现只将锁EEXIST视为争用并且rename一次失败直接外溢；HTTP又将任意code错误映射409，混淆存储失败和版本冲突。

修复：只对Windows EPERM/EACCES/EBUSY的rename和exclusive wx创建做最多20次额外重试、每次10ms。rename全过程持有原CAS锁，不重新取版本、不先删除目标、不释放锁重试。锁获取每次仍由wx成功建立排他所有权，绝不依据exists判断拥有锁；真实EEXIST直接busy。持续失败为artifact_write_failed，HTTP500带storage_code，不能冒充版本409；失败临时文件清理，旧磁盘JSON不变，正常释放锁。

新增确定性故障注入：短暂rename失败两次后成功、重试期间第二registry仍busy；持续EPERM/ENOSPC返回500且版本/正文不变、无临时文件残留、下一次成功；lock.open短暂EPERM可恢复，持续EACCES为500而非冲突。竞争测试并未把artifact_write_failed放入可接受loser列表。

模型语义限制：同session+同agent+同artifact的并行read会更新同一个缓存；原schema无token无法分辨各更新意图，调用者必须按最近read返回的完整payload保留用户编辑。不同agent、session、artifact已测试隔离。不引入额外未知模型参数或新合并策略。

最终压力/回归结果以本次交付报告记录，不沿用先前14/14一次通过代替压力验证。原工具schema、CSS完全不变，UTF8 LF，不提交推送。

### 本次最终验证结果
全部在 `C:\Users\qyq\Desktop\work\neoctl\web` 执行：
1. `$env:XHS_CAS_ROUNDS='1000'; node --test --test-name-pattern='parallel workers' plugins/xhs-artifact/version.test.mjs`：exit0，1000轮/4000Workers严格竞争全部通过，64153ms。日志 TEMP/neoctl-xhs-cas-fixed-1000.log。
2. `node --test artifacts.test.mjs plugins/xhs-artifact/version.test.mjs xhs-version-browser.test.mjs plugins.test.mjs`：exit0，20/20通过，6842ms；包含新增2个确定性Windows故障测试，Edge、原schema和CSS、plugins4/4全部通过。日志 TEMP/neoctl-xhs-final-regression.log。
3. 第二批 `$env:XHS_CAS_ROUNDS='500'` 后运行同一综合命令：exit0，20/20通过，其中竞争重复500轮/2000Workers，35029ms。日志 TEMP/neoctl-xhs-cas-repeat-500-regression.log。合计两批1500轮/6000Workers，不含常规回归额外轮次。
4. node --check artifacts.mjs/version.test.mjs、授权路径git diff --check：exit0。

本次生产修改仅artifacts.mjs，测试/记录仅version.test.mjs、OBS-12.md；未再次改schema、CSS、浏览器源码、App.vue、engine或CSV。未模拟真实断电/杀毒内核句柄；故障注入验证持续IO拒绝安全失败，并不声称所有存储故障都会恢复成功。
