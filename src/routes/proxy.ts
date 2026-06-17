import { Router } from 'express';
import type { Request, Response } from 'express';
import { request as undiciRequest } from 'undici';

import { determineFileExtension } from '../core/download/MediaExtensionUtil';
import { DEFAULT_UA } from '../http/xhsHttp';

/**
 * 微信小程序媒体代理路由。
 *
 * 小程序 `wx.downloadFile` 只允许 HTTPS,且无法直接拿小红书 CDN(域名不在白名单
 * 且 CDN 校验 Referer)。所以由服务器代理:
 *
 *   GET /api/proxy-image?url=<encoded XHS CDN url>
 *   GET /api/proxy-video?url=<encoded XHS CDN url>
 *
 * 关键差异 (vs /api/fetch):
 *   - **不写 Content-Disposition**:小程序 wx.downloadFile 只取字节流,
 *     带 attachment 头反而会让某些客户端推断为下载而非缓存。
 *   - 补 Referer: https://www.xiaohongshu.com/ —— 否则 XHS CDN 返回 403。
 *   - SSRF 白名单:host 必须是 XHS CDN / xiaohongshu.com 子域。
 *   - 长 Cache-Control:小程序端可以本地缓存。
 *   - 主动 abort:客户端断开时不让上游 leak。
 */

export const proxyRouter = Router();

// 允许的上游 host 白名单(正则)
const ALLOWED_HOST_RE =
  /^([a-z0-9-]+\.)?(xhscdn\.com|xiaohongshu\.com|xhslink\.com)$/i;

function isAllowedUpstream(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    return ALLOWED_HOST_RE.test(u.hostname);
  } catch {
    return false;
  }
}

async function proxyMedia(req: Request, res: Response, kind: 'image' | 'video'): Promise<void> {
  const url = typeof req.query.url === 'string' ? req.query.url.trim() : '';
  if (!url) {
    res.status(400).json({ error: 'url 不能为空' });
    return;
  }
  if (!/^https?:\/\//i.test(url)) {
    res.status(400).json({ error: 'url 必须以 http(s):// 开头' });
    return;
  }
  if (!isAllowedUpstream(url)) {
    res.status(400).json({ error: 'host 不在白名单' });
    return;
  }

  let aborted = false;
  let upstreamBody: { destroy?: (e?: Error) => void } | null = null;

  req.on('close', () => {
    aborted = true;
    try {
      upstreamBody?.destroy?.();
    } catch {
      /* ignore */
    }
  });

  try {
    const upstream = await undiciRequest(url, {
      method: 'GET',
      headers: {
        'User-Agent': DEFAULT_UA,
        Referer: 'https://www.xiaohongshu.com/',
        Accept: kind === 'video' ? 'video/*,*/*;q=0.8' : 'image/*,*/*;q=0.8',
      },
      maxRedirections: 5,
    });

    if (upstream.statusCode < 200 || upstream.statusCode >= 300) {
      // 把 body 排干,避免连接 leak
      try {
        await upstream.body.dump();
      } catch {
        /* ignore */
      }
      res.status(502).json({ error: `上游返回 ${upstream.statusCode}` });
      return;
    }

    // 透传 Content-Type / Content-Length
    const contentType =
      (upstream.headers['content-type'] as string | undefined) ||
      (kind === 'video' ? 'video/mp4' : 'image/jpeg');
    res.setHeader('Content-Type', contentType);
    const cl = upstream.headers['content-length'];
    if (typeof cl === 'string' && cl.length > 0) {
      res.setHeader('Content-Length', cl);
    }

    // 帮 wx.downloadFile 决定文件后缀:它会从 Content-Type 推断,但加 .mp4/.jpg 后缀更稳
    const ext = determineFileExtension(url);
    res.setHeader('X-Suggested-Filename', `xhs-${Date.now()}.${ext}`);

    // 小程序可缓存 1 天
    res.setHeader('Cache-Control', 'public, max-age=86400');
    // 关掉 nginx 缓冲,流式响应
    res.setHeader('X-Accel-Buffering', 'no');

    upstreamBody = upstream.body as unknown as { destroy?: (e?: Error) => void };

    for await (const chunk of upstream.body as AsyncIterable<Buffer>) {
      if (aborted || res.writableEnded) break;
      if (!res.write(chunk)) {
        await new Promise<void>((r) => res.once('drain', r));
      }
    }
    if (!aborted && !res.writableEnded) res.end();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!res.headersSent) {
      res.status(502).json({ error: `proxy 失败: ${msg}` });
    } else {
      try {
        res.destroy();
      } catch {
        /* ignore */
      }
    }
  }
}

proxyRouter.get('/proxy-image', (req, res) => proxyMedia(req, res, 'image'));
proxyRouter.get('/proxy-video', (req, res) => proxyMedia(req, res, 'video'));

// HEAD 支持 wx.downloadFile 偶尔的 size 探测
proxyRouter.head('/proxy-image', (req, res) => proxyMedia(req, res, 'image'));
proxyRouter.head('/proxy-video', (req, res) => proxyMedia(req, res, 'video'));
