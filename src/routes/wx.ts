import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';

import { extractLinks } from '../core/url/LinkExtractor';
import { extractPostId } from '../core/url/PostIdExtractor';
import { parse as parseNoteDetails } from '../core/parse/NoteDetailsParser';
import { determineFileExtension, isVideoUrl } from '../core/download/MediaExtensionUtil';
import { fetchHtml, resolveShortUrl } from '../http/xhsHttp';

/**
 * 微信小程序适配路由。
 *
 * 小程序端 (`redBookMiniprogram/pages/xhslink/xhslink.js`) 期望的契约:
 *   GET  /api/wx/parse?url=<xhslink>
 *   200  { code: number, data: { type: '图文'|'视频', title, cover, images?, url? } }
 *   code: 0 成功 / -2 入参错 / -3 链接解析失败 / -4 限流 / -5 内部错误
 *
 * 小程序代码已经按 `apiResult.data.type === '视频'` 分支取 `data.url`,
 * 按 `data.images` 取图集,所以这里**必须**完全对齐这个结构。
 *
 * 安全:
 *   - 简单 in-memory IP 限流 (30 req/min)
 *   - SSRF 白名单:只接受 xhslink.com / xiaohongshu.com
 *   - 可选 token (env WX_TOKEN);留空则不校验
 */

export const wxRouter = Router();

// ─── token 校验(可选) ─────────────────────────────────────────────
const WX_TOKEN = process.env.WX_TOKEN ?? '';
function checkToken(req: Request, res: Response, next: NextFunction): void {
  if (!WX_TOKEN) {
    next();
    return;
  }
  const t =
    (req.header('x-wx-token') ?? '') ||
    (typeof req.query.token === 'string' ? req.query.token : '');
  if (t !== WX_TOKEN) {
    res.status(401).json({ code: -1, error: 'unauthorized' });
    return;
  }
  next();
}

// ─── 极简内存限流:30 req / min / IP ────────────────────────────────
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 30;
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

function rateLimit(req: Request, res: Response, next: NextFunction): void {
  const ip =
    (req.header('x-forwarded-for') ?? '').split(',')[0].trim() ||
    req.ip ||
    'unknown';
  const now = Date.now();
  const bucket = rateBuckets.get(ip);
  if (!bucket || bucket.resetAt < now) {
    rateBuckets.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    next();
    return;
  }
  if (bucket.count >= RATE_MAX) {
    res.status(429).json({ code: -4, error: '请求过于频繁,请稍候再试' });
    return;
  }
  bucket.count++;
  next();
}

// 定期清理过期桶,避免无限增长
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateBuckets) {
    if (v.resetAt < now) rateBuckets.delete(k);
  }
}, RATE_WINDOW_MS).unref();

wxRouter.use(checkToken);
wxRouter.use(rateLimit);

// ─── /api/wx/parse ─────────────────────────────────────────────────
wxRouter.get('/wx/parse', async (req: Request, res: Response) => {
  const rawUrl = typeof req.query.url === 'string' ? req.query.url.trim() : '';
  if (!rawUrl) {
    return res.json({ code: -2, error: 'url 不能为空' });
  }
  if (!/^https?:\/\//i.test(rawUrl)) {
    return res.json({ code: -2, error: 'url 必须以 http(s):// 开头' });
  }
  if (!/(xhslink\.com|xiaohongshu\.com)/i.test(rawUrl)) {
    return res.json({ code: -2, error: '不是小红书链接' });
  }

  try {
    // 1. 抽取标准化链接(小程序传过来的有可能是含中文标点的分享文案)
    const links = extractLinks(rawUrl);
    if (links.length === 0) {
      return res.json({ code: -3, error: '未在输入中找到小红书链接' });
    }
    const firstLink = links[0];

    // 2. 短链 follow redirect
    let realUrl = firstLink;
    if (firstLink.includes('xhslink.com')) {
      const resolved = await resolveShortUrl(firstLink);
      if (resolved) realUrl = resolved;
    }

    // 3. 提取 noteId
    const postId = extractPostId(realUrl);
    if (!postId) {
      return res.json({ code: -3, error: '无法提取 noteId' });
    }

    // 4. 抓取 HTML
    const html = await fetchHtml(realUrl);
    if (!html) {
      // fetchHtml 失败原因可能是网络/限流/被风控,统一按 -4
      return res.json({ code: -4, error: '抓取页面失败,可能被风控,请稍候再试' });
    }

    // 5. 解析
    const result = parseNoteDetails(html);
    const mediaUrls = result.mediaUrls;
    if (!mediaUrls || mediaUrls.length === 0) {
      return res.json({ code: -5, error: '解析失败,未找到媒体' });
    }

    // 6. 区分图文 / 视频
    const videoUrl = mediaUrls.find((u) => isVideoUrl(u));
    const imageUrls = mediaUrls.filter((u) => !isVideoUrl(u));
    const isVideo = !!videoUrl && imageUrls.length === 0;

    // 标题:NoteDetailsParser 当前没透出 title,这里用 postId 兜底,后续可扩展
    const title = `小红书 ${postId}`;

    if (isVideo) {
      const cover = imageUrls[0] ?? mediaUrls.find((u) => !isVideoUrl(u)) ?? '';
      return res.json({
        code: 0,
        data: {
          type: '视频',
          title,
          cover,
          url: videoUrl,
        },
      });
    }

    // 图文 (含 Live Photo:把 mediaUrls 整列返回,小程序按 images 数组处理)
    const cover = imageUrls[0] ?? mediaUrls[0];
    return res.json({
      code: 0,
      data: {
        type: '图文',
        title,
        cover,
        images: imageUrls.length > 0 ? imageUrls : mediaUrls,
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return res.json({ code: -5, error: `内部错误: ${msg}` });
  }
});

// 健康探针(给前端联调和 nginx upstream 监控用)
wxRouter.get('/wx/ping', (_req, res) => {
  res.json({ code: 0, data: { pong: true, ts: Date.now() } });
});

// 显式导出扩展名工具供 proxy 用(避免循环引入)
export const __probe = { determineFileExtension };
