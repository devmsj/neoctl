# OBS-10 方案决策与撤回记录（2026-09-07）

## 当前结论
主审决定采用统一客户端原图 `Image.decode()` 方案覆盖 PNG/JPEG/WebP，不保留仅 PNG 的 CRC/zlib 手写验证器。独立客户端 helper 与专属测试完成后，已获 App.vue 独占授权并完成生产图片详情接入与真实 App Edge 验收。现已释放 App.vue 写权限；index.ts 请求尺寸投影由主代理独占处理，本代理未改。

## 已完成撤回
按当前文件逐段移除本代理新增内容，未使用 git checkout/reset，未以 HEAD 整文件覆盖。
- engine/src/core/image-storage.ts：撤去 PNG 验证器、zlib import、像素元数据持久化改动。
- engine/src/tools/builtins/image-generation-tool.ts：撤去 pixelMetadata 提取/透传。
- engine/src/types/messages.ts：撤去本次可选 pixelMetadata 类型/字段。
- 删除本代理新增的 engine/src/core/smoke-obs10-pixels.ts（仅验证被弃用实现）。
- 原方案生产差异为约 101 行新增、4 行删除，其中约 79 行为 PNG 专属验证器；目前上述三个生产文件 `git diff --exit-code -- <三文件>` 实际返回 0，差异为空。
- 未改 App.vue、engine/src/web/index.ts、CSV；未提交/推送、未读取秘密、未新增依赖。其他代理工作保留。

## 既有依赖检查
engine/package-lock.json 已锁定 image-size 1.2.1（传递依赖，不是 engine/package.json 直接依赖）。本机 engine 目录执行 require.resolve('image-size') 与读取其 package.json 成功，当前已安装可解析。
它可提供 PNG/JPEG/WebP 等原图文件头尺寸，但文件头尺寸不是完整解码成功证据；如未来采用应标 header 来源，并由客户端原图 decode 判断实际可用性。本次不引入对传递依赖的生产耦合。

## 原 UI 契约建议（以下为接入前决策，最终实现见文末）
- 原有 request size 保持不变；auto 是请求策略，不是像素。不得用 request size 回填实际。
- 为每张原图创建独立 Image，用受授权 originalUrl 设置 src，等待 decode 成功后读取 naturalWidth/naturalHeight；不得使用缩略图 DOM naturalWidth/naturalHeight。
- 成功后使用正整数像素；加载/解码失败为未知或不可获取，不把文件头元数据冒充成功解码。
- 按所属会话+调用+图片身份/原图URL隔离，切换后忽略迟到结果，不按同名 label 或首图缓存填其他图片。
- 请求尺寸与实际尺寸分别显示；只有具体请求像素与实际不同才提示差异，auto 不判像素差异。
- 不改生成参数、binary、下载身份、图片专业外观或动画。

## 接入前验证状态（历史阶段，最终验收见文末）
被撤回方案此前通过专属离线测试、engine typecheck 与 smoke:images，但这些不构成客户端方案验收。
撤回后的三生产文件 diff 已实际检查为空；下述独立客户端 helper 实现/测试已完成，实际生产 UI 接入尚未开始。
后续需覆盖 PNG/JPEG/WebP、auto、请求不一致、坏图/缺资源、多图同名、切换/迟到响应、详情/放大/下载及既有视觉保留的浏览器验收。OBS-10 整项仍未完成。

## 独立 helper API（已实现并完成 UI 接入）
新增文件：web/src/image-original-dimensions.mjs（70行）、web/image-original-dimensions.test.mjs、web/image-original-dimensions-browser.test.mjs。无服务端改动或依赖。

```js
const dimensions = createOriginalDimensions() // 默认64条LRU，15秒超时
// 会话切换时同步调用；清空旧缓存，旧pending返回stale。
dimensions.setSession(sessionId)
const result = await dimensions.load({ sessionId, originalUrl, available })
// result: {sessionId, originalUrl, state:'actual'|'unknown'|'unavailable'|'stale',
//          width?, height?, source?:'original-decode'}
const facts = originalDimensionFacts(requestSize, result)
// facts: {requested: string, actual: string, mismatch: boolean}
dimensions.invalidate(originalUrl) // 重试/资源失效时清除当前会话该项
dimensions.clear() // 组件卸载/明确清理；取消pending
```

- 只有 actual 携带 width/height/source；decode成功且正整数才构造 actual。available=false 立即不可获取并清旧缓存，不发图片请求。失败/超时为unknown，不回填请求值。
- key为JSON编码的sessionId+originalUrl；同key pending返回同一Promise。maxEntries可设1..512，默认64，包含pending与完成项；LRU淘汰将pending结束为stale；缓存unknown可用invalidate后重试。
- setSession不是load内部隐式执行：旧会话迟到load不能把缓存切回旧会话。UI会话watch应先setSession；旧会话load返回stale，不请求。
- setSession/clear/invalidate/淘汰会使未完成旧调用返回stale，后续decode不会覆盖；已resolved的Promise无法撤回，因此UI赋值前仍必须比较当前会话+当前目标原图URL/调用身份，并忽略stale。不要把不同图片的结果写入同一个无身份槽。
- originalUrl必须由现有授权资源映射提供，禁止传preview/thumbnail兜底。helper不接收缩略图参数，也不能辨别调用方错误传入的缩略图URL。相同会话内多个调用引用完全相同原图可共用尺寸缓存。
- actual事实字符串为W × H；请求auto显示auto（自动策略），mismatch=false；未知/不可获取无mismatch。缺请求显示未提供。
- 可用性更新必须重新load({available:false})或invalidate；缓存不是资源监控，无法自行检测服务器清理。不要将历史actual当作当前资源仍可用的证据。

## 本轮实际测试
- node web/image-original-dimensions.test.mjs — PASS：pending去重、缓存上限/LRU、切会话/迟到隔离、available=false、非法像素、超时、自动策略/差异。
- node web/image-original-dimensions-browser.test.mjs — PASS：真正headless Microsoft Edge（断言UA Edg/），浏览器canvas生成PNG/JPEG/WebP原图31×17、32×18、33×19；独立缩略图2×1；真实Image.decode、多图、坏图、HTTP404、不可用不发请求、已缓存资源失效、跨会话/迟到隔离、auto/请求差异。
- 浏览器测试使用独立localhost空白页面与helper模块，不依赖/修改共享App.vue、index.ts或dist，不执行模型任务。生产模板/详情/动画/下载验收留到UI接入授权后。


## 最终生产 UI 接入与验收（App.vue 已释放）
本次授权范围已完成。生产修改仅 App.vue + 原图helper，无 CSS/组头/计数/分组/图片生成语义变更；主代理在 index.ts 修改请求尺寸标签，不属于本代理变更。

App.vue 新增 imageDimensionTarget（session + line/call/message身份 + 逐图原图URL/availability/identity）和epoch校验；打开/切换详情清缓存并重验原图，await后目标或epoch不同即丢弃。实际像素放在现有 image2-detail-grid / image2-detail-prompt 内容区逐图展示。卡片原size chip仅明确为请求尺寸，auto显示自动策略；详情每图请求/实际独立，差异提示保留原图。没有原图仅缩略图时未知；available=false不可获取。

normalizeImagePreview 保留原下载/放大 originalUrl 规则，额外 originalDecodeUrl 只接受 explicit originalSrc/original.src/originalUrl/原始data，不使用preview/thumbnail/src兜底。请求来源不因前端缺原图被推测。

实际App测试发现：仅new Image原URL即使关闭重开，Edge已解码图片缓存也可能让后来404资源仍报告像素。最终helper对HTTP原图先fetch(cache:no-store, AbortSignal)取得Blob，再Image.decode；对象URL在成功/失败/取消/超时释放，原图HTTP失败为unknown，无预览fallback。data/blob原图直接decode。保留默认64条LRU与15秒超时，无新依赖/decoder。跨源资源CORS不允许读取时明确unknown，不绕过权限。

### 实际通过的最终检查
1. npm --prefix web run build — PASS（Vite，CSS资产hash保持WuTlWLu5）。
2. node web/image-original-dimensions-app-browser.test.mjs — PASS，实际构建App+Edge，不是helper替代：请求1024x1024实际31×17；PNG/JPEG/WebP多图31×17/32×18/33×19；auto；2×1预览不回填；坏原图/404/available=false/仅缩略图；曾成功后过期重开unknown；真实新会话按钮切会话并隔离旧pending；原图放大入口、缩略图URL、下载事件保留。所有模拟API请求均GET，不执行模型。
3. node web/image-original-dimensions.test.mjs — PASS。
4. node web/image-original-dimensions-browser.test.mjs — PASS（实际Edge独立模块）。
5. node web/observability-preservation.test.mjs — PASS（2/2，组头/重复目的/终端身份分组不变）。
6. node web/tool-call-detail-browser.test.mjs — PASS（OBS01）。
7. node web/tool-detail-fields-browser.test.mjs — PASS（OBS06）。
8. node web/status-semantics-browser.test.mjs — PASS（OBS08，含组内/非组computed style一致）。
9. App.vue git diff --check — PASS；App/helper/专属App测试字节检查UTF8无BOM、LF — PASS。

首轮App测试失败真实暴露过期图片缓存，已改为no-store原图Blob解码后通过。跨会话fixture最初直接推送其他session被既有runtime绑定守卫拒绝，后改用真实新会话按钮测试，无放宽守卫。曾误调用不存在的tool-parameters-browser测试，已定位正确tool-detail-fields-browser并实际通过。

最终：OBS10本次授权UI与功能验收完成；中央视觉/专业入口保留。未改CSV，未提交推送，已明确通知主代理立即释放App.vue；主代理复核其index投影标签后一并判定整项完成。
