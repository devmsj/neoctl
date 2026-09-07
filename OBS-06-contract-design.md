# OBS06 前置范围 / contract 设计交付

日期：2026-09-07。**不是 OBS06 开始/完成声明；不变更 issue 状态。** OBS01 已有详情能力，OBS08 完成后由主代理按顺序接入、验收。本次只新增独立纯模块及测试，不接现有 reader/UI。

## 范围与来源

已阅读桌面规范 00–04。根因是展示层缺少独立参数分类，不是 purpose 覆盖了输入。

仅新增：
- `engine/src/web/tool-detail-fields.ts`
- `engine/src/web/tool-detail-fields.test.ts`
- 本记录

只读追踪：`tool-call-detail.ts` 的 `ToolCallDetail/DetailPart/readToolCallDetail/redactToolDetail` → `index.ts` 的 `toolCallDetail` 和 `/api/tool-call-detail` → `App.vue` 的 `loadToolDetail/state.toolDetailData` 及既有详情模态。参数身份核对 `tools/tool-catalog.ts`、文件 builtins、`search-tool.ts`、`agents/agent-tool.ts`、`tasks/subagent-tools.ts`。实际 grep 范围是 `grepPath`；代理结果轮次是 `run_generation`；resume 指令是 `directive`。

不修改 index.ts、App.vue、tool-call-detail.ts 或其他既有源码；不改 CSV，不提交推送。工作区原有及并行修改保留。不实现状态语义、终端/图片/稿件专业映射，不建立第二套模态、授权、脱敏、持久化或全文读取。

## 两个可复用入口

- `toolDetailFieldsFromDetail(detail, display?)`：直接接受现有 ToolCallDetail（类型只要求 toolName/input/result）。仅 JSON.parse 脱敏 part.text；完整性和 reason 保留。
- `classifyToolDetailFields(source)`：已授权且已脱敏的真实 JSON `input/output`，可显式传 inputCompleteness/outputCompleteness。调用方必须把已截断结果标 truncated；未传完整性时认为传入的是完整真实值。此纯模块不是安全边界，禁止传原始消息、隐藏推理或未经脱敏上下文。

输出 purpose/subject/object/keyParameters/actualPath/actualProvider；每个字段有 state、原值、来源、sourceKey、完整性。源缺失为 not-provided（未提供），仅完整结构化输入中省略的可选参数为 unspecified（未指定），不适用为 not-applicable；有效空返回单独以 result.empty 标记。保留 0/false/[]/空字符串/null，参数不裁剪。缺失、不可获取 part 不提取；合法截断 JSON 只提取已存在字段并保留 truncated，不能推断遗漏参数未指定；破损 JSON/文本/XML 不猜字段，原文继续由 OBS01 展示。

范围：文件 read/list/write/edit/search、web_search、已存在的八个 subagent 身份。read/list/write/edit/grep/search 按规范明确别名映射；不猜 Task*/Agent 等已不在当前注册合同里的历史名称，不使用 includes/prefix/title/purpose 分类。其他工具降级 other，由原详情承担全文。

purpose/subject 可传同调用已经脱敏的真实 display 元数据，不用于提取对象。未传 purpose 时读取 input.purpose 或 input.description，空字符串不被兜底覆盖。subject 缺失不从摘要制造。

文件路径优先结果实际绝对 path（grep 为 grepPath），否则保留输入真实 path。不以当前 cwd 补全历史相对路径。actualPath.copyValue 仅在路径来源完整且为绝对路径时提供；UI 不得复制 basename/summary 冒充完整路径。web provider 请求参数与结果实际 provider 分离，实际 provider 缺失不以请求/default 回填。代理保留 target 与解析后 task_id；轮次只取真实 run_generation，不推断生命周期或消息执行成功。

## OBS08 完成后的最小接入指令（本次未执行）

1. 主代理确认 OBS08 完成并重新读取当前文件，保留并行修改。在 `engine/src/web/index.ts` 添加 `toolDetailFieldsFromDetail` 导入。现有 `async toolCallDetail(sessionId, toolUseId, messageId?)` 内先以原参数调用 `readToolCallDetail` 保存为 detail；缺失仍返回 undefined；成功返回 `this.runtime.engine.redactDisplayValue({ ...detail, fields: toolDetailFieldsFromDetail(detail) })`。保留原授权、scope、session/message 身份检查、reader 的 redact 回调和最终脱敏。无需改 reader、本体 ToolCallDetail 或 HTTP 路由；fields 是详情响应的可选增量，不进状态快照。
2. `App.vue` 保留 loadToolDetail 的 abort/epoch/session/toolUseId/messageId 校验及同一 state.toolDetailData 赋值。在现有 `v-if="state.toolDetailData"` 模态内、input/result/error 全文区前，只在 `.fields` 存在时补对象/关键参数事实区。purpose/subject 用该调用现有 toolDisplay 元数据单独展示；不要将 friendly subject 送入路径提取，也不要改中央主文本的 purpose 优先规则。
3. 缺省标签按上述 state 映射；provided 使用类型感知字符串/JSON 序列化，不用 `value || '未提供'`。重复 key（如输入/输出 task_id、prompt）渲染键用 source+sourceKey+index，明确标注输入/实际返回；truncated 带预览说明。actualPath.copyValue 存在才开放“复制完整路径”；相对值仅标“输入路径”。实际 provider 单列。
4. 保留 input/result/error 的 reason、原文、现有复制/下载操作。新增字段不是全文替代品，不再触发工具/模型/代理消息。现有 OBS01 reader 已能加载受授权持久化结果；unavailable 继续显示原 reason，不新增任意路径读取接口。
5. 接入后主代理再跑 unit/typecheck 和 OBS01 详情浏览器回归；验收组内/非组失败工具、键盘焦点、切换会话/调用及迟到响应、截断/不可获取、完整路径复制。折叠仅 purpose、重复项/动画/组头及专业 diff 必须保持。此次不宣称这些 UI 验收已完成。

## 已实际验证

在 engine 目录运行：
- `npx tsx --test src/web/tool-detail-fields.test.ts`：9 tests，9 pass，0 fail。
- `npm run typecheck`：`tsc -p tsconfig.json --noEmit`，exit 0。

覆盖：别名与未知身份、防原型名称误匹配、purpose/subject 不反推、Windows/UNC/POSIX 路径优先级、offset/limit=0、编辑空创建规则/多行内容/false、缺省/空结果、搜索过滤与 provider 分离、真实代理 ID/轮次/长 prompt/message/directive、OBS01 脱敏和完整性适配、破损 JSON/文本不伪造。未运行 UI 测试，因为没有 UI 接入。
