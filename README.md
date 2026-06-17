# XHS Downloader · Web 版

> 版本:`0.1.0-web`
> 本仓库独立维护,独立发版,tag 命名 `v*.*.*-web`(如 `v0.1.0-web`)

## 这是什么

把 Kotlin KMP 项目里 `:core` 模块(解析 + 下载 XHS 笔记的算法)1:1 翻译成 TypeScript,
用 Node + Express + undici 重新实现一遍。前端是一个单 HTML 页面。

姊妹仓库:
- **Android / Windows 桌面端**(KMP + Compose Desktop):[NEORUAA/XHS_Downloader_Android](https://github.com/NEORUAA/XHS_Downloader_Android) — 解析算法的真正源头
- **iOS** :[NEORUAA/XHS_Downloader_iOS](https://github.com/NEORUAA/XHS_Downloader_iOS)

## 完整复用策略

- `src/core/url/LinkExtractor.ts` ← 翻译自 `:core/commonMain/.../url/LinkExtractor.kt`
- `src/core/url/UrlUtils.ts` ← `url/UrlUtils.kt`
- `src/core/url/PostIdExtractor.ts` ← `url/PostIdExtractor.kt`
- `src/core/url/UrlTransformer.ts` ← `url/UrlTransformer.kt`
- `src/core/parse/JsLiteralExtractor.ts` ← `parse/JsLiteralExtractor.kt`(状态机 1:1 翻译)
- `src/core/parse/InitialStateParser.ts` ← `parse/InitialStateParser.kt`
- `src/core/parse/NoteFinder.ts` ← `parse/NoteFinder.kt`(6 个优先路径)
- `src/core/parse/MediaUrlExtractor.ts` ← `parse/MediaUrlExtractor.kt`
- `src/core/parse/NoteDetailsParser.ts` ← `parse/NoteDetailsParser.kt`
- `src/core/naming/NamingFormat.ts` ← `naming/NamingFormat.kt`
- `src/core/naming/TemplateApplier.ts` ← `naming/TemplateApplier.kt`
- `src/core/download/MediaExtensionUtil.ts` ← `download/MediaExtensionUtil.kt`
- `src/core/download/DownloadOrchestrator.ts` ← `download/DownloadOrchestrator.kt`(OkHttp → undici, File → fs/promises, 协程 → async/await, 4 并发内联)
- `src/http/xhsHttp.ts` ← undici + UA/cookie/Referer 封装,所有外发请求的唯一入口

平台层:

- `src/platform/FileStorage.ts` ← `core/desktopMain/.../platform/FileStorageDesktop.kt`(默认 `Pictures/xhsdn`、`Videos/xhsdn` 目录 + `(1)` 防重名)
- `src/platform/LivePhotoWriter.ts` ← Web 版先返回 false,fallback 拆 jpg + mp4
- `src/platform/DownloadCallback.ts` ← 控制台日志占位

> ⚠️ 不要尝试把 `:core` 的 Kotlin 代码直接 require() — 它依赖 OkHttp + `java.io.File`,
> `:core` 当前只配置了 `android` + `jvm("desktop")` 两个 target,没有 js/native target。

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

## API

- `POST /api/parse` body `{ text: string }` → `{ results: [{ postId, originalUrl, mediaUrls, livePhotoPairs, error? }] }`
- `POST /api/download` body `{ text: string }` → `{ ok, savedFiles: [{ absPath, publicUrl, fileName, isVideo, isLivePhoto, mimeType }], picturesDir, videosDir }`
- `GET /api/history` → `{ items: [{ fileName, absPath, publicUrl, isVideo, size, mtime }] }`
- `GET /api/health` → `{ ok, version, ts }`
- `GET /api/fetch?url=...` 代理 XHS 资源到浏览器(规避跨域)
- `GET /media/pictures/xhsdn/<file>` 静态文件(图片)
- `GET /media/videos/xhsdn/<file>` 静态文件(视频)

## 文件落盘

```
.
├── storage/
│   ├── pictures/xhsdn/    # 图片、Live Photo fallback 出来的 jpg
│   └── videos/xhsdn/      # 视频
└── public/                # 前端单页
```

`storage/` 已经在 `.gitignore` 里,不入库。

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

## 已知限制

- **Live Photo 不会合成 mov**。Web 版 `LivePhotoWriter.create()` 永远返回 false,
  fallback 路径会同时保存 `.jpg` + `.mp4`(命名 `<baseName>_img.jpg` / `<baseName>_vid.mp4`)。
  后续要合成可接 ffmpeg。
- **无任务管理**。Web 版用 `/api/history` 列出 storage/ 目录的文件,没有持久化元数据。
- **下载是同步阻塞的**。`/api/download` 会一直 hold 到所有文件下载完才返回;
  对长任务/多图笔记可能耗时 30s+。前端目前没有进度条,后续可接 SSE / WebSocket。

## 开源许可

AGPL-3.0,详见 [LICENSE](LICENSE)。本项目仅供个人学习和研究使用,下载后请于 24H 内删除。
