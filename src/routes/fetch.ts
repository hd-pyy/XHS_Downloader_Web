import { Router } from 'express';

import { determineFileExtension } from '../core/download/MediaExtensionUtil';
import { fetchStream } from '../http/xhsHttp';

/**
 * 单文件代理下载 —— 不落盘,服务端 fetch XHS CDN URL 后原样 stream 回浏览器。
 *
 * 浏览器收到 `Content-Disposition: attachment` 后会弹原生下载框,文件落到用户本机。
 * 多文件场景由前端循环 N 次请求,每次拿到一个独立文件。
 *
 * Query:
 *   url      必填,XHS CDN 链接
 *   name     可选,自定义下载文件名;缺省时从 url 推断扩展名
 *
 * 流式:不再 collect 到内存,直接 for-await 把上游 chunk 写回响应;
 * 上游 Content-Length 透传,便于前端 fetch + ReadableStream 自己算字节进度。
 */
export const fetchRouter = Router();

fetchRouter.get('/fetch', async (req, res) => {
  const url = typeof req.query.url === 'string' ? req.query.url : '';
  const customName = typeof req.query.name === 'string' ? req.query.name : '';
  if (!url) {
    return res.status(400).json({ error: 'url 不能为空' });
  }
  // 只放行 http(s),防止 SSRF
  if (!/^https?:\/\//.test(url)) {
    return res.status(400).json({ error: 'url 必须以 http(s):// 开头' });
  }

  const handle = await fetchStream(url);
  if (!handle) {
    return res.status(502).json({ error: `fetch 失败: ${url}` });
  }

  // 文件名:优先用前端传过来的,否则用 url hash + 扩展名
  const ext = determineFileExtension(url);
  const fileName = customName
    ? customName.replace(/[\\/:*?"<>|]/g, '_')
    : `xhsdn-${Date.now()}.${ext}`;

  res.setHeader('Content-Type', handle.contentType);
  if (handle.contentLength !== undefined) {
    res.setHeader('Content-Length', String(handle.contentLength));
  }
  res.setHeader(
    'Content-Disposition',
    `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
  );
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Accel-Buffering', 'no');

  let aborted = false;
  req.on('close', () => {
    aborted = true;
    handle.abort();
  });

  try {
    for await (const chunk of handle.stream) {
      if (aborted || res.writableEnded) break;
      if (!res.write(chunk)) {
        await new Promise<void>((r) => res.once('drain', r));
      }
    }
    if (!aborted && !res.writableEnded) res.end();
  } catch (e) {
    if (!res.headersSent) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(500).json({ error: msg });
    } else {
      try {
        res.destroy();
      } catch {
        /* ignore */
      }
    }
  }
});