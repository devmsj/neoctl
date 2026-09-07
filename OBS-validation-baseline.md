# 回归基线核对

2026-09-07，主代理以当前代码及 git 基线 `d40cb8b67525b8646587480c43bce3854c153dca` 分别实际运行 `engine/src/core/smoke-core-loop.ts`。

- 当前：exit 1，唯一布尔失败项 `historyImageDowngraded:false`，其余 query/stream/filter/thinking/tool checks 为 true。
- 基线：使用 `git archive` 导出 engine 到临时独立目录，复用现有 node_modules 的 junction，不改仓库；同命令 exit 1，同一 `historyImageDowngraded:false`。
- 临时基线目录：`C:\Users\qyq\AppData\Local\Temp\neoctl-baseline-check-a828df043c204fbc8930f2ed4f93e812`。
- 原始日志：`%TEMP%\neoctl-core-loop-current.log`、`%TEMP%\neoctl-core-loop-baseline.log`。
- 结论：该现有 smoke 失败在相同环境、未修改基线上真实复现，不是仅凭源码推断的基线问题。本轮未扩界修改图片模型能力测试，不把它报告为全库测试通过。

统一修复验收脚本：`node web/run-observability-checks.mjs`。每项独立捕获 exit，不能让 PowerShell 后续成功覆盖先前失败。最终完整结果另记录于完成索引。
