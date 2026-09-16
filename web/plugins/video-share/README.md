# video-share：独立视频播放插件

仅依赖 Node.js 20+ 标准库，无 npm 依赖、不需要构建、不导入宿主或 downloads 插件的任何模块。通过 `neo-plugin/v1` 的工厂上下文、tools、promptSections、presentToolResult 和 route 接口接入；整个目录可复制或移除。播放器 HTML/CSS、文件存储、HTTP Range 逻辑、测试全部在插件内部，不修改 Vue 或宿主路由。

## 功能

- `expose_videos({ paths: [绝对视频路径, ...] })`：每批最多 20 个，返回视频元数据、供程序使用的 `url` / `mediaUrl`、内嵌展示 `_ui`，以及 `expiresAt: null`。不再返回 Markdown 链接；文字回复不得贴视频 URL、Markdown 链接或 HTML 视频标签，只需说明视频已就绪。
- `revoke_videos({ ids: [视频 ID, ...] })`：用户要求时手动撤销链接并删除路径映射，不删除或修改原视频。已下载内容和正在传输的数据不能追回。
- `/api/video-share/<id>`：插件自带 HTML5 播放器，由聊天页面以同源 iframe 直接嵌入，带播放/暂停、拖动、音量、全屏控件；页面中没有新窗口或直链按钮。
- `/api/video-share/<id>/media`：正确的视频 MIME、`Content-Disposition: inline`，支持 GET、HEAD、单段 Range / 206 / 416 和 If-Range。未知单位或多段 Range 回退完整 200 响应。
- 无自动过期和定时清理；每条视频以随机 192 位 token 发布，独立原子落盘记录，支持并发发布和跨进程恢复。
- 接受 `.mp4`、`.m4v`、`.mov`、`.webm`、`.ogv`，检查基本容器签名，但不做解码或转码。推荐 MP4（H.264 / AAC）或 WebM。扩展名和容器合法不保证浏览器支持内部编码。
- 播放器直接显示在消息中，不需要点击链接，不打开新页面，不触发附件下载。通过现有 `kind: embed` 和 `presentationLevel: primary` 通用协议实现，不改宿主 Vue 代码。部分成功的批量结果也显示成功视频；历史工具结果可经 presenter 重新展示，但历史助手文字不会被自动改写。

## 存储行为

视频与 downloads 一样采用**零复制**：仅保存原始绝对路径映射，不复制、不移动视频、不创建硬链接或软链接。原视频可在任意目录（需服务具有读取权限），访问时从原路径流式读取，支持 Range 拖动。原视频移动或删除后，播放页和视频直链均返回 404；不可读时请求失败，不查找新位置、无副本兜底。

映射跨重启保留、无自动过期。原路径内容更新后播放新内容；若该路径重新出现文件，链接可再次访问。重复发布只新增很小的 JSON 映射。撤销仅删除映射，不触碰原视频。这里的零复制指不创建磁盘副本，网络传输仍采用 Node.js 流。

升级说明：旧 v1 记录没有原始路径，不能自动转换；旧视频链接将返回 404，需要重新暴露原视频。不会自动删除旧副本，确认不再需要后可手动清理旧 ID 目录。

默认目录是宿主传入的 `<appDataDir>/video-share`；无宿主数据目录时使用 `~/.neo-video-share/video-share`。`NEO_VIDEO_SHARE_DIR` 可覆盖整个存储位置。

“无自动过期”仍以服务运行、插件启用、发布数据存在为前提。删除插件数据、撤销链接或停止服务会影响访问。请备份映射目录，并保留原始视频路径，保持链接的域名/端口不变。中断发布可能遗留 `.pending-*`，撤销清理失败可能遗留 `.revoked-*`；这些不是公开记录，可在停止服务后手动清理。

## 安装与配置

将整个 `video-share` 目录放入宿主扫描的插件根目录（本仓库为 `web/plugins`）。在插件设置中启用并重启服务；如果 `NEO_WEB_PLUGINS` 使用显式列表，也要加入 `video-share`。

可选环境变量：

```powershell
$env:NEO_VIDEO_SHARE_DIR = 'D:\neo-data\published-videos'
$env:NEO_VIDEO_SHARE_PUBLIC_ORIGIN = 'https://videos.example.com'
```

`NEO_VIDEO_SHARE_PUBLIC_ORIGIN` 只接受 HTTP(S) origin，不含路径、查询参数或凭据。该配置仅影响程序使用的 `url` / `mediaUrl`；聊天内嵌资源始终使用同源相对路径，避免跨域 CSP 拒绝嵌入。设置后直链返回完整 URL，需由你配置该域名到插件路由的反向代理，插件不会自动开放网络或修改防火墙。

非 neo 宿主也可以直接 `import { createPlugin } from './index.mjs'`，传入 `{ appDataDir, env }`，将返回的 `route(req, res, new URL(...))` 接到 Node HTTP 服务，并调用返回工具的 `execute`。宿主渲染时使用 `_ui` 或 `presentToolResult` 的 embed 资源。无宿主 SDK 依赖。

## 安全边界

持有链接即可访问，没有逐视频登录验证。只有明确暴露的文件可访问；URL 不接受本地路径，没有公开目录列表或发布/撤销 HTTP 接口。文件名经过 HTML 转义，播放器使用 CSP 和 no-referrer。`Cache-Control: no-store` 只控制缓存，并非链接过期。

保护存储目录的文件系统权限；不要分享敏感视频。远程共享时仅代理视频路由并使用 HTTPS，不要把整个具备文件修改和执行命令能力的 Agent 工作台直接暴露到公网。

## 独立测试

```powershell
cd C:\Users\qyq\Desktop\work\neoctl\web\plugins\video-share
node --test ../../tests/plugins/video-share/video-share.test.mjs
```

测试使用带容器头的合成字节验证 HTTP、Range、HEAD、零复制、移动/删除失效、原文件更新、持久性、撤销安全、旧版边界、输入校验、转义、并发和独立进程恢复；它不是浏览器真实视频解码测试。
