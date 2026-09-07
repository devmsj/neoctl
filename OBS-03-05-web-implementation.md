# OBS-03 / OBS-05 Web 接入记录（已完成）

## 实现

- 唯一 `TerminalOutputStore` 经真实 manager 安全分流输出落盘；数据链见 `OBS-03-terminal-data-chain.md`。
- `GET /api/terminal-output` 按 runtime 实际所属 sessionId/sessionDir + runId 授权。双流独立 UTF-8 字节游标；响应再次经注册秘密脱敏，游标始终寻址存储字节，不按显示文字长度计算。跨站 403、跨会话/身份/参数错误 404，no-store。
- 中央调用投影不再 stringValue 折叠 stdout/stderr；独立 previews 保留换行/空白，即使双流相同也不去重。调用本次返回与运行全集不混同，退出码/信号/终止原因/耗时缺失明确，0合法。
- `TerminalOutputReader.vue` 复用于既有中央详情和后台详情；按流分页、刷新、复制下载全部已保留输出，运行标快照、截断标已保留前缀。过期/清理/失联清除已显示正文，但保留真实退出事实。重试与晚到响应 generation/owner/run 隔离；取消请求，不调用模型。
- SSE 改为 `{ownerSessionId,sessionId,invalidated:true}`，不把混流片段当全集、不在快照复制正文；已排队跨 owner 通知丢弃。reader 自己通过只读接口定时刷新。
- 新 `terminalTaskHistory` 使用同一存储退出事实，所属会话历史完整取得，活动/历史同身份去重。终态时现有详情保留；主动关闭可在最近结束重开。终态 durationMs 冻结，不把数值 completedAt 交给 Date.parse。
- 中央卡外观、目的列表/重复/分组不变；CSS文件未更改。阅读组件仅局部换行/overflow规则，CSS hash仍 WuTlWLu5。

## 主代理已实际验证

- store + visible provenance + message persistence + terminal presentation 组合单测退出0，Windows文件symlink权限缺失的2项明确skip，junction/hardlink实际通过。
- typecheck + `smoke-terminal-output-chain.ts` 主复跑13组通过，包括65真实进程、真实PTY、跨流秘密、Unicode/CRLF、TTL、重启/失联。
- `smoke-terminal-output-http.ts` 主复跑318断言 / 62 HTTP请求 / modelCalls=0 / mutationCalls=0。
- `terminal-output-browser.test.mjs` 实际Edge通过：中央两个独立调用、超过64KiB分页/双流/空白、反复读取无重复、真实剪贴板及下载、到期撤销、后台重开及刷新、390视口。Windows系统剪贴板LF转CRLF，测试仅归一化该系统换行，下载/DOM按原文字断言。
- 综合22组暂19通过：OBS01旧snapshot单测fixture缺新增history方法已补；并行代理新测试TS控制流错误在修；OBS12四Worker竞争间歇错误已恢复负责人排查。未将综合失败隐去。

## 待收尾

- 补充 `terminal-transition-browser.test.mjs` 已主复跑9/9：原生SSE完成0/非0/主动停止不关闭（MutationObserver无卸载重建）、活动历史去重、503重试、运行快照/截断导出、TTL自动撤销、真实新建和切换会话同run跨owner迟到隔离、390px文档宽精确390和键盘导航。已按顺序登记OBS03/05完成。
- 综合回归需在稳定代码后重跑并更新完成索引。
