# XHS Downloader · Web 版

> 版本:`0.1.0-web` · 本仓库独立发版,tag 命名 `v*.*.*-web`(如 `v0.1.0-web`)
> 许可证:AGPL-3.0 —— 仅供个人学习研究,下载内容请于 24 小时内删除。

把 Kotlin KMP 项目里 `:core` 模块(解析 + 下载小红书笔记的算法)1:1 翻译成 TypeScript,
用 Node + Express + undici 重新实现。除了网页前端,本仓库同时承担**微信小程序后端**
(解析 + 媒体反代)的能力,HTTPS 部署后可直接给 `wx.request` / `wx.downloadFile` 用。

## 原作者 / 同作者其他平台实现

- **原作者** :[NEORUAA](https://github.com/NEORUAA) —— 本仓库的 `:core` 解析算法 1:1 来自其 KMP 项目
- **Android / Windows 桌面端**(KMP + Compose Desktop):[NEORUAA/XHS_Downloader_Android](https://github.com/NEORUAA/XHS_Downloader_Android) —— 解析算法的真正源头
- **iOS** :[NEORUAA/XHS_Downloader_iOS](https://github.com/NEORUAA/XHS_Downloader_iOS)

## 功能概览

- 🔗 **链接解析** —— 从用户分享文案里抽取 `xhslink.com` 短链 / `xiaohongshu.com` 长链,自动 follow redirect
- 🖼 **无水印媒体** —— 抓取笔记详情页,跑状态机解析出 `window.__INITIAL_STATE__` 里的媒体 URL,自动转换 CDN 参数去水印
- 📦 **批量下载** —— 一段分享文案可包含多条笔记,逐条解析后并发下载(默认 4 并发 / 3 次重试)
- 🎞 **Live Photo 兜底** —— 不合成 `.mov`,直接落盘为 `<base>_img.jpg` + `<base>_vid.mp4`
- 📡 **异步 SSE 进度** —— 长任务用 `/api/download/start` + `/api/download/events` 推 byte-level 进度,前端进度条实时显示
- 📥 **浏览器原生下载** —— 文件不一定要走服务器落盘,`/api/fetch` 可以流式代理回浏览器,通过 Blob + `<a download>` 触发保存
- 📁 **历史记录** —— `GET /api/history` 列出 `storage/` 下所有已下载文件
- 📱 **微信小程序适配** —— `GET /api/wx/parse` 给出 `code/data` 兼容结构,`/api/proxy-image` 与 `/api/proxy-video` 反代小红书 CDN(带 SSRF 白名单 + Referer 修复),可直接给 `wx.request` / `wx.downloadFile` 调用

## 架构

```
                          ┌──────────────────────────────┐
   浏览器 / 小程序 ─────►  │  Express (src/server.ts)     │
                          │  ├─ /api/parse               │
                          │  ├─ /api/fetch    (流式代理) │
                          │  ├─ /api/download (同步)     │
                          │  ├─ /api/download/start      │◄──┐
                          │  ├─ /api/download/events  ───┼───┘ SSE
                          │  ├─ /api/wx/parse             │
                          │  └─ /api/proxy-{image,video}  │
                          └────────────┬─────────────────┘
                                       ▼
                          ┌──────────────────────────────┐
                          │  core/  (与 KMP :core 1:1)    │
                          │  ├─ url/   抽取/变换 URL      │
                          │  ├─ parse/ 状态机解析 HTML    │
                          │  ├─ naming/ 文件名模板        │
                          │  └─ download/                 │
                          │     DownloadOrchestrator      │
                          │     (4 并发,3 重试,候选 URL) │
                          └────────────┬─────────────────┘
                                       ▼
                          ┌──────────────────────────────┐
                          │  http/xhsHttp.ts  (undici)    │
                          │  platform/                    │
                          │   ├─ FileStorage  (落盘)      │
                          │   └─ LivePhotoWriter (fallback)│
                          └──────────────────────────────┘
```

### 代码复用对照(1:1 翻译自 `:core`)

| 本仓库(TS) | 原版(Kotlin) |
| --- | --- |
| `src/core/url/LinkExtractor.ts` | `url/LinkExtractor.kt` |
| `src/core/url/UrlUtils.ts` | `url/UrlUtils.kt` |
| `src/core/url/PostIdExtractor.ts` | `url/PostIdExtractor.kt` |
| `src/core/url/UrlTransformer.ts` | `url/UrlTransformer.kt` |
| `src/core/parse/JsLiteralExtractor.ts` | `parse/JsLiteralExtractor.kt`(状态机 1:1 翻译) |
| `src/core/parse/InitialStateParser.ts` | `parse/InitialStateParser.kt` |
| `src/core/parse/NoteFinder.ts` | `parse/NoteFinder.kt`(6 个优先路径) |
| `src/core/parse/MediaUrlExtractor.ts` | `parse/MediaUrlExtractor.kt` |
| `src/core/parse/NoteDetailsParser.ts` | `parse/NoteDetailsParser.kt` |
| `src/core/naming/NamingFormat.ts` | `naming/NamingFormat.kt` |
| `src/core/naming/TemplateApplier.ts` | `naming/TemplateApplier.kt` |
| `src/core/download/MediaExtensionUtil.ts` | `download/MediaExtensionUtil.kt` |
| `src/core/download/DownloadOrchestrator.ts` | `download/DownloadOrchestrator.kt`(OkHttp → undici,File → `fs/promises`,协程 → `async/await`,4 并发内联) |
| `src/http/xhsHttp.ts` | undici + UA/Referer 封装,所有外发请求的唯一入口 |
| `src/platform/FileStorage.ts` | `desktopMain/.../FileStorageDesktop.kt`(默认 `Pictures/xhsdn`、`Videos/xhsdn`,同名 `(1)` 防重) |
| `src/platform/LivePhotoWriter.ts` | Web 版先返回 `false`,fallback 拆 jpg + mp4 |
| `src/platform/DownloadCallback.ts` | 控制台日志占位 |

> ⚠️ 不要尝试把 `:core` 的 Kotlin 代码直接 `require()` — 它依赖 OkHttp + `java.io.File`,
> `:core` 当前只配置了 `android` + `jvm("desktop")` 两个 target,没有 js/native target。

## 目录结构

```
.
├── src/
│   ├── server.ts                 # Express 入口
│   ├── core/
│   │   ├── url/                  # 链接抽取、变换、提取 noteId
│   │   ├── parse/                # HTML 状态机解析
│   │   ├── naming/               # 文件名模板
│   │   └── download/             # DownloadOrchestrator(核心编排)
│   ├── http/xhsHttp.ts           # undici 封装(全项目唯一外发入口)
│   ├── platform/                 # FileStorage / LivePhotoWriter / Callback
│   └── routes/                   # Express 路由
│       ├── parse.ts              # /api/parse
│       ├── fetch.ts              # /api/fetch(浏览器流式下载)
│       ├── download.ts           # /api/download + /download/start + /download/events
│       ├── wx.ts                 # /api/wx/parse + /api/wx/ping
│       └── proxy.ts              # /api/proxy-image + /api/proxy-video
├── public/                       # 前端单页(HTML + CSS + vanilla JS)
├── storage/                      # 下载落盘(pictures/xhsdn/、videos/xhsdn/)
│   ├── pictures/xhsdn/
│   └── videos/xhsdn/
├── deploy/
│   ├── nginx.conf                # Nginx 反代模板(HTTPS + SSE/proxy 优化)
│   └── xhsdn-web.service         # systemd unit
├── DEPLOY-WX.md                  # 微信小程序部署详细说明
├── package.json
└── tsconfig.json
```

`storage/` 已在 `.gitignore` 里,不入库。

## 跑起来

需要 Node 18+。

```bash
npm install
npm run build     # tsc → dist/
npm start         # 启 Express 在 :3000
# 或开发热重载:
npm run dev
```

打开 http://localhost:3000

### 环境变量

| 变量 | 含义 | 默认 |
| --- | --- | --- |
| `PORT` | Express 监听端口 | `3000` |
| `WX_TOKEN` | 小程序端可选鉴权 token;非空时校验 `x-wx-token` header / `?token=` query | 空 = 不校验 |

## API

### 网页端

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/parse` | body `{ text }`,返回 `{ results: [{ postId, originalUrl, mediaUrls, livePhotoPairs, error? }] }` |
| `POST` | `/api/parse`(Accept: `application/x-ndjson`) | 同上,但走 NDJSON 流式响应(`parse_start` / `parse_progress` / `parse_done` / `parse_error`) |
| `POST` | `/api/download` | body `{ text }`,**同步**返回落盘结果 `{ ok, savedFiles, picturesDir, videosDir }` |
| `POST` | `/api/download/start` | body `{ text }`,**异步** —— 立即返回 `{ jobId }`,后台开始执行 |
| `GET` | `/api/download/events?jobId=...` | SSE 进度通道,推 `phase` / `note_start` / `note_done` / `media_start` / `media_progress` / `media_done` / `livephoto_done` / `done` / `error` |
| `GET` | `/api/fetch?url=&name=` | 代理 XHS 资源流式回浏览器,带 `Content-Disposition: attachment` 触发浏览器原生下载 |
| `GET` | `/api/history` | 列出 `storage/` 下文件 `{ items: [{ fileName, absPath, publicUrl, isVideo, size, mtime }] }` |
| `GET` | `/api/health` | 健康探针 `{ ok, version, ts }` |

### 微信小程序端

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/wx/parse?url=<xhslink>` | 小程序友好结构,`code: 0` 成功 / `-2` 入参错 / `-3` 链接解析失败 / `-4` 限流 / `-5` 内部错误,`data: { type: '图文'\|'视频', title, cover, images?, url? }` |
| `GET` | `/api/wx/ping` | 健康探针,小程序联调用 |
| `GET` | `/api/proxy-image?url=` | 反代小红书 CDN 图片流,带 `Referer: https://www.xiaohongshu.com/` 修复 403 |
| `GET` | `/api/proxy-video?url=` | 同上,视频流 |
| `HEAD` | `/api/proxy-image\|video` | 给 `wx.downloadFile` 偶尔的 size 探测用 |

`/api/proxy-*` 额外做了:

- SSRF 白名单:host 必须是 `xhscdn.com` / `xiaohongshu.com` / `xhslink.com` 子域
- 主动 abort:客户端断开时 `destroy()` 上游,防止连接 leak
- `X-Accel-Buffering: no` 关掉 nginx 缓冲
- `X-Suggested-Filename` 头帮 `wx.downloadFile` 推断后缀

### 静态资源

- `GET /media/pictures/xhsdn/<file>` —— 已下载图片
- `GET /media/videos/xhsdn/<file>` —— 已下载视频
- `GET /media/...` —— 同上(根挂载点)

`Cache-Control: public, max-age=3600`。

## 前端使用

`public/` 下的单页前端调用顺序:

1. **解析** —— `POST /api/parse { text }` 拿结果,渲染预览网格(图片 `<img>`,视频 `<video>`)
2. **下载到本机** —— `POST /api/download/start` 拿 `jobId` → 订阅 `/api/download/events` SSE
   - `note_start` → 切到 note 计数 `N/M`
   - `media_start` → 并行 `fetch /api/fetch?url=...&name=...`,通过 `ReadableStream` 累加字节更新副进度条
   - 拉完一个文件 → `Blob + <a download>` 触发浏览器原生下载
   - `media_done` → 文件计数 +1
   - `done` / `error` → 收尾

## 部署

`deploy/` 下放了两份模板:

- `nginx.conf` —— HTTPS 模板,内含 SSE / proxy-video 的关键参数(`proxy_buffering off`、`proxy_read_timeout 300s`、`X-Forwarded-For` 透传)
- `xhsdn-web.service` —— systemd unit(`user=xhsapp`,`WorkingDirectory` 指向项目根)

详细步骤见 [DEPLOY-WX.md](DEPLOY-WX.md),含:

- 域名 / 备案 / certbot
- `useradd xhsapp` + 项目目录权限
- `WX_TOKEN` 鉴权与小程序端 `wx.request` 的 header 配合
- Nginx → Node 的 SSE 路径调优

## 版本管理(发版流程)

本仓库独立发版:

```bash
git checkout main
git pull
# 改 package.json 里的 version,如 0.2.0-web
npm version 0.2.0-web -m "chore: bump to 0.2.0-web"
git push origin main
git tag -a v0.2.0-web -m "Web 版 0.2.0"
git push origin v0.2.0-web
```

## 已知限制 / TODO

- **Live Photo 不会合成 `.mov`**。`LivePhotoWriter.create()` 永远返回 `false`,
  fallback 路径会同时保存 `<base>_img.jpg` + `<base>_vid.mp4`。后续可接 ffmpeg 自动合成。
- **任务状态是 in-memory**。`JobStore` 进程重启即清空;job TTL 30 秒后自动清理;同时活动 job 上限 3 个。
- **`/api/download`(同步接口)会一直 hold 到所有文件下载完才返回**,
  对长任务/多图笔记可能耗时 30s+。**推荐**新接入用 `/api/download/start` + SSE 通道。
- **无持久化元数据**。`/api/history` 通过遍历 `storage/` 目录得到,**没有数据库**。
  文件一旦从磁盘删除,历史里就看不到。
- **并发档位写死**。`DownloadOrchestrator` 内 `CONCURRENCY=4`、`MAX_ATTEMPTS=3` 常量,暂不暴露配置。
- **`/api/parse` 1mb body 上限**。Express `json({ limit: '1mb' })` 写死在 `server.ts`,超大段分享文案需要先在客户端裁切。

## 安全提示

- 小程序端 `/api/wx/parse` 有 IP 限流(30 req / min / IP,内存桶,定期清理),生产环境建议加 Nginx 维度的限流。
- `/api/proxy-*` 严格 host 白名单,只代理小红书自家域。
- 反代部署时务必设置 `app.set('trust proxy', true)`(已在 `server.ts` 写好),否则 `req.ip` 会拿到 `127.0.0.1`,限流粒度失效。
- 启用 `WX_TOKEN` 时请用 32+ 位随机串,避免被猜到。

## 开源许可

AGPL-3.0,详见 [LICENSE](LICENSE)。
本项目仅供个人学习和研究使用,下载后请于 24 小时内删除。
