# OBS06 正式实施交付

2026-09-07，按最新授权在 OBS08 完成后正式接入。此记录取代 `OBS-06-contract-design.md` 中的“尚未接入”阶段结论；CSV 由主代理管理，本代理未修改 CSV、未提交推送。

## 变更范围

- `engine/src/web/tool-detail-fields.ts`：独立纯分类；metadata 改为 input.purpose → input.description → display 摘要，subject 独立。display 完整性为 summary，不伪装成完整输入。真实参数、实际对象仅从授权脱敏 input/result 取得。
- `engine/src/web/index.ts`：仅增加分类模块导入；既有 `toolCallDetail` 先取 OBS01 reader 详情，再追加 fields，保持最终脱敏、原身份/授权/缺失语义。不修改 reader 和 API 路由。
- `web/src/App.vue`：仅详情辅助函数和既有详情模态增加字段区（无新 engine import）。subject 缺失时取当前同调用 line.toolDisplay，显式标“展示摘要（不是完整输入）”；purpose 真实源优先。复用既有 pre 区样式、复制逻辑和模态，没有改中央主文本、折叠、卡片、CSS、组头或专业展示。
- 专属测试：`engine/src/web/tool-detail-fields.test.ts`、`engine/src/web/smoke-tool-detail-fields-http.ts`、`web/tool-detail-fields-browser.test.mjs`。
- 前置设计记录仍保留，当前记录为正式接入事实。

## 必选验收

1. 文件 path/result 实际绝对路径优先；复制完整路径使用原样 copyValue，不用 basename/summary，不按当前 cwd 补历史路径；read offset/limit=0 和 edit oldString/newString/replaceAll=false 保留。HTTP 和 Edge 实际剪贴板通过（组内 read、非组 edit）。
2. 搜索 query/path/glob/大小写/限制和 provider/date/domain 分类；grep 实际范围取 grepPath；请求 provider 与结果实际 provider 独立；未指定过滤与有效空结果区分。unit、HTTP、Edge 均覆盖对应层。
3. subagent 实际 task_id、请求 target、prompt/message/directive、调用控制值和真实 run_generation 独立；长委派 unit 不截断、长消息及 edit 内容 Edge textContent 全量相等（约 4 万字符）。没有推断任务/投递状态。
4. 0、false、[]、空字符串明确呈现。missing/unavailable 不能提取事实；truncated 字段保留来源、不能复制为完整路径；原 OBS01 reason/全文/预览复制下载继续可达；破损 JSON/文本/XML 不反推。旧缺输入记录 Edge 显示未提供，合法截断结果显示已截断来源。
5. purpose 完整源优先，不被 display 短摘要覆盖；subject 独立来源标识，不冒充实际对象。中央折叠仅 purpose、重复顺序和原主文本优先级保持。
6. 保留取消/epoch/身份/焦点陷阱/焦点返回/失败重试和原复制下载；OBS01/08 实际浏览器回归通过，包括跨会话同调用 ID、迟到请求、刷新、窄屏、调用与任务状态分域和无写请求。所有新增事实由同一只读详情请求返回，不发模型任务，不新增模态。

## 实际执行结果

- `npm --prefix engine run typecheck`：exit 0。
- `npm --prefix engine run build`：exit 0。
- `npm --prefix web run build`：Vite 成功，exit 0。
- `node --import ./engine/node_modules/tsx/dist/loader.mjs --test engine/src/web/tool-detail-fields.test.ts`：9/9 pass。
- `node engine/dist/web/smoke-tool-detail-fields-http.js`：39 assertions pass；真实 production HTTP route + WebRepl + 磁盘持久化，fields、provider、长 message、截断及缺输入，GET-only/403/404/跨会话及 junction 拒绝。
- `node engine/dist/web/smoke-tool-call-detail.js`：OBS01 45 assertions pass。
- `node engine/dist/web/smoke-tool-call-http.js`：OBS01 19 assertions pass。
- `node engine/dist/web/smoke-status-semantics.js`：OBS08 real tools/projection/status matrix/anchored XML/zero facts/edit unknown phase pass。
- `node --test web/agent-task-presentation.test.mjs web/observability-preservation.test.mjs`：5/5 pass。
- `node web/tool-detail-fields-browser.test.mjs`：实际 headless Microsoft Edge pass，使用真实 OBS01 reader + 构建后的分类器产出详情 fixture。
- `node web/tool-call-detail-browser.test.mjs`：OBS01 Edge pass。
- `node web/tool-call-session-browser.test.mjs`：OBS01 跨会话/迟到 Edge pass。
- `node web/status-semantics-browser.test.mjs`：OBS08 Edge pass，组内非组计算样式一致。

本轮所有编辑文件 UTF-8/LF。实现和测试已完成，释放 index.ts/App.vue/tool-detail-fields 及测试文件给主代理/OBS03 后续工作；不再持有共享文件写入权。
