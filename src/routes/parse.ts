import { Router } from 'express';
import type { Response } from 'express';

import { extractLinks } from '../core/url/LinkExtractor';
import { extractPostId } from '../core/url/PostIdExtractor';
import { parse as parseNoteDetails } from '../core/parse/NoteDetailsParser';
import { fetchHtml, resolveShortUrl } from '../http/xhsHttp';

export const parseRouter = Router();

interface ParseRequest {
  text?: string;
}

interface ParseResultRow {
  originalUrl: string;
  postId: string | null;
  mediaUrls: string[];
  livePhotoPairs: Array<{
    imageUrl: string | null;
    videoUrl: string | null;
    isLivePhoto: boolean;
  }>;
  error?: string;
}

/**
 * 写一行 NDJSON —— 若 res 已关闭则不抛。
 */
function writeNdjsonLine(res: Response, obj: unknown): void {
  if (res.writableEnded) return;
  try {
    res.write(JSON.stringify(obj) + '\n');
  } catch {
    /* ignore */
  }
}

/**
 * 默认走单 JSON 响应(向后兼容旧前端);
 * 当 `Accept: application/x-ndjson` 时改写为逐行 NDJSON,前端可用 ReadableStream
 * 读 `parse_start / parse_progress / parse_done / parse_error`。
 */
parseRouter.post('/parse', async (req, res) => {
  const { text } = (req.body ?? {}) as ParseRequest;
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'text 不能为空' });
  }

  const accept = String(req.headers.accept ?? '').toLowerCase();
  const useNdjson = accept.includes('application/x-ndjson');

  try {
    const urls = extractLinks(text);
    if (urls.length === 0) {
      if (useNdjson) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
        writeNdjsonLine(res, { type: 'parse_error', message: '未在输入中找到 XHS 链接' });
        res.end();
        return;
      }
      return res.status(400).json({ error: '未在输入中找到 XHS 链接' });
    }

    if (useNdjson) {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('X-Accel-Buffering', 'no');
      if (typeof (res as unknown as { flushHeaders?: () => void }).flushHeaders === 'function') {
        (res as unknown as { flushHeaders: () => void }).flushHeaders();
      }
      writeNdjsonLine(res, { type: 'parse_start', total: urls.length });
    }

    const resolved: string[] = [];
    for (const u of urls) {
      if (u.includes('xhslink.com')) {
        const r = await resolveShortUrl(u);
        resolved.push(r ?? u);
      } else {
        resolved.push(u);
      }
    }

    const out: ParseResultRow[] = [];

    for (let i = 0; i < resolved.length; i++) {
      const url = resolved[i];
      const postId = extractPostId(url);

      if (useNdjson) {
        writeNdjsonLine(res, {
          type: 'parse_progress',
          current: i + 1,
          total: resolved.length,
          postId: postId ?? undefined,
        });
      }

      const html = await fetchHtml(url);
      if (!html) {
        const row: ParseResultRow = {
          originalUrl: url,
          postId,
          mediaUrls: [],
          livePhotoPairs: [],
          error: 'fetch 失败',
        };
        out.push(row);
        if (useNdjson) writeNdjsonLine(res, { type: 'parse_error', message: 'fetch 失败', index: i });
        continue;
      }
      const result = parseNoteDetails(html);
      const row: ParseResultRow = {
        originalUrl: url,
        postId,
        mediaUrls: result.mediaUrls,
        livePhotoPairs: result.livePhotoPairs.map((p) => ({
          imageUrl: p.imageUrl,
          videoUrl: p.videoUrl,
          isLivePhoto: p.isLivePhoto,
        })),
      };
      out.push(row);
    }

    if (useNdjson) {
      writeNdjsonLine(res, { type: 'parse_done', results: out });
      if (!res.writableEnded) res.end();
      return;
    }
    return res.json({ results: out });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (useNdjson) {
      writeNdjsonLine(res, { type: 'parse_error', message: `解析异常: ${msg}`, fatal: true });
      if (!res.writableEnded) res.end();
      return;
    }
    return res.status(500).json({ error: `解析异常: ${msg}` });
  }
});