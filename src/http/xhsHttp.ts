import { request } from 'undici';

/**
 * XHS HTTP 公共 helper。Android 风格 UA、短链 follow redirect、抓 HTML。
 * 抽出来给 /api/parse 与 /api/stream 共用,避免两处复制。
 */

/**
 * 流式抓取句柄 —— 上游 body 以 AsyncIterable<Buffer> 暴露,
 * 配合 onChunk 回调实现字节级进度推送(SSE)。
 *
 * 与旧的 `fetchBytes` 区别:不一次性 collect 到内存,适合大视频;
 * 调用方拿到 `stream` 后逐 chunk 处理即可。
 */
export interface FetchStreamHandle {
  /** 字节流,每个 chunk 是一个 Buffer;消费完即结束。 */
  stream: AsyncIterable<Buffer>;
  /** 上游 content-type;失败时为 'application/octet-stream'。 */
  contentType: string;
  /** 上游 content-length;若上游未给则 undefined(走 chunked)。 */
  contentLength?: number;
  /** 主动取消(关闭底层连接);失败不抛。 */
  abort: () => void;
}

export interface FetchStreamOptions {
  /** 单次请求失败重试次数(默认 3)。 */
  maxAttempts?: number;
  /** 每个 chunk 到达时回调(bytes = 本 chunk 字节数)。失败/中止时不调。 */
  onChunk?: (bytes: number) => void;
}

export const DEFAULT_UA =
  'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36 xiaohongshu';

/** 跟随短链重定向,返回最终 URL;失败返回 null。 */
export async function resolveShortUrl(shortUrl: string): Promise<string | null> {
  try {
    const res = await request(shortUrl, {
      method: 'GET',
      headers: { 'User-Agent': DEFAULT_UA },
      maxRedirections: 10,
    });
    if (res.statusCode >= 200 && res.statusCode < 300) {
      const finalUrl = (res as unknown as { url?: string }).url ?? shortUrl;
      await res.body.dump();
      return finalUrl;
    }
    return null;
  } catch {
    return null;
  }
}

/** 抓笔记详情页 HTML;失败返回 null。 */
export async function fetchHtml(url: string): Promise<string | null> {
  try {
    const res = await request(url, {
      method: 'GET',
      headers: {
        'User-Agent': DEFAULT_UA,
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=1.0,image/avif,image/webp,image/apng,*/*;q=1.0',
      },
      maxRedirections: 5,
    });
    if (res.statusCode >= 200 && res.statusCode < 300) {
      return await res.body.text();
    }
    return null;
  } catch {
    return null;
  }
}

/** 抓二进制(图片/视频);失败返回 null。带简单重试。 */
export async function fetchBytes(
  url: string,
  maxAttempts = 3,
): Promise<{ bytes: Buffer; contentType: string } | null> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await request(url, {
        method: 'GET',
        headers: { 'User-Agent': DEFAULT_UA },
        maxRedirections: 5,
      });
      if (res.statusCode >= 200 && res.statusCode < 300) {
        const bytes = Buffer.from(await res.body.arrayBuffer());
        const contentType =
          (res.headers['content-type'] as string | undefined) ?? 'application/octet-stream';
        return { bytes, contentType };
      }
      await res.body.dump();
    } catch {
      // 网络错误,继续重试
    }
  }
  return null;
}

/**
 * 流式抓取二进制。失败返回 null;成功返回 FetchStreamHandle。
 *
 * - 使用 undici.request 拿到 res.body(Readable),用 for-await 暴露为 AsyncIterable<Buffer>
 * - 每个 chunk 调 onChunk(bytes) 用于 SSE 进度推送
 * - 调用方处理完 stream 后可选择调 handle.abort()(只在你想提前断开时调)
 * - 不会自动 retry;retry 由调用方(Orchestrator)在 candidate 循环里控制
 */
export async function fetchStream(
  url: string,
  opts: FetchStreamOptions = {},
): Promise<FetchStreamHandle | null> {
  const maxAttempts = opts.maxAttempts ?? 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await request(url, {
        method: 'GET',
        headers: { 'User-Agent': DEFAULT_UA },
        maxRedirections: 5,
      });
      if (res.statusCode >= 200 && res.statusCode < 300) {
        const contentType =
          (res.headers['content-type'] as string | undefined) ?? 'application/octet-stream';
        const contentLengthHeader = res.headers['content-length'];
        const parsedLen =
          typeof contentLengthHeader === 'string' && contentLengthHeader.length > 0
            ? Number(contentLengthHeader)
            : Number(contentLengthHeader);
        const contentLength = Number.isFinite(parsedLen) && parsedLen > 0 ? parsedLen : undefined;

        const body = res.body as AsyncIterable<Buffer> & { destroy?: () => void };
        let aborted = false;

        const asyncIterable: AsyncIterable<Buffer> = body;

        // wrap 一层 iterator 以触发 onChunk
        const wrapped: AsyncIterable<Buffer> = {
          [Symbol.asyncIterator]() {
            const inner = asyncIterable[Symbol.asyncIterator]();
            const onChunk = opts.onChunk;
            const iterator: AsyncIterator<Buffer> = {
              async next(): Promise<IteratorResult<Buffer>> {
                if (aborted) return { value: undefined as unknown as Buffer, done: true };
                const r = await inner.next();
                if (r.done) return r;
                if (onChunk && r.value && r.value.length > 0) {
                  try {
                    onChunk(r.value.length);
                  } catch {
                    /* 回调异常不影响流 */
                  }
                }
                return r;
              },
            };
            return iterator;
          },
        };

        const handle: FetchStreamHandle = {
          stream: wrapped,
          contentType,
          contentLength,
          abort: () => {
            aborted = true;
            try {
              body.destroy?.();
            } catch {
              /* ignore */
            }
          },
        };
        return handle;
      }
      try {
        await res.body.dump();
      } catch {
        /* ignore */
      }
    } catch {
      // 网络错误,继续重试
    }
  }
  return null;
}
