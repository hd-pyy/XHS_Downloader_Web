import { Router, Response } from 'express';
import { randomUUID } from 'crypto';
import * as path from 'path';
import * as fs from 'fs';
import { EventEmitter } from 'events';

import { WebFileStorage } from '../platform/FileStorage';
import { WebLivePhotoWriter } from '../platform/LivePhotoWriter';
import { ConsoleDownloadCallback } from '../platform/DownloadCallback';
import {
  DownloadOrchestrator,
  ProgressEvent,
  SavedFile,
} from '../core/download/DownloadOrchestrator';

export interface DownloadDeps {
  rootDir: string;
  publicBaseUrl: string;
}

export interface JobState {
  id: string;
  emitter: EventEmitter;
  status: 'pending' | 'running' | 'done' | 'error';
  result?: { ok: boolean; savedFiles: SavedFile[] };
  errorMsg?: string;
  /** 所有 SSE 客户端订阅者;广播用。 */
  clients: Set<Response>;
}

const JOB_TTL_MS = 30_000;
const MAX_ACTIVE_JOBS = 3;

/** 简单 in-memory job store;重启即清,够 web 版用。 */
class JobStore {
  private jobs = new Map<string, JobState>();

  create(): JobState {
    const id = randomUUID();
    const state: JobState = {
      id,
      emitter: new EventEmitter(),
      status: 'pending',
      clients: new Set<Response>(),
    };
    // EventEmitter 默认上限 10 listeners,SSE 多客户端可能超;提到 0 = 无限
    state.emitter.setMaxListeners(0);
    this.jobs.set(id, state);
    return state;
  }

  get(id: string): JobState | undefined {
    return this.jobs.get(id);
  }

  activeCount(): number {
    let n = 0;
    for (const j of this.jobs.values()) {
      if (j.status === 'pending' || j.status === 'running') n++;
    }
    return n;
  }

  scheduleCleanup(id: string): void {
    setTimeout(() => {
      const j = this.jobs.get(id);
      if (j) {
        try {
          j.emitter.removeAllListeners();
        } catch {
          /* ignore */
        }
        this.jobs.delete(id);
      }
    }, JOB_TTL_MS).unref();
  }
}

/** SSE 写一帧;若响应已结束则不抛。 */
function sseWrite(res: Response, event: string, data: unknown): void {
  if (res.writableEnded) return;
  try {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  } catch {
    /* ignore */
  }
}

export function buildDownloadRouter(deps: DownloadDeps): Router {
  const router = Router();
  const fileStorage = new WebFileStorage(deps.rootDir);
  const livePhotoWriter = new WebLivePhotoWriter();
  const callback = new ConsoleDownloadCallback();
  const jobStore = new JobStore();

  /**
   * 旧同步接口,保留以避免破坏历史调用方。
   * 推荐新接入使用 /download/start + /download/events。
   */
  router.post('/download', async (req, res) => {
    const text = req.body?.text;
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'text 不能为空' });
    }

    try {
      const orchestrator = new DownloadOrchestrator({
        fileStorage,
        livePhotoWriter,
        callback,
        baseUrl: deps.publicBaseUrl,
      });
      const result = await orchestrator.downloadContent(text);
      return res.json({
        ok: result.ok,
        savedFiles: result.savedFiles,
        picturesDir: fileStorage.picturesDir(),
        videosDir: fileStorage.videosDir(),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return res.status(500).json({ error: `下载异常: ${msg}` });
    }
  });

  /**
   * 新异步入口。立即返回 jobId,后台跑 orchestrator,进度通过 SSE 推到 /download/events。
   */
  router.post('/download/start', async (req, res) => {
    const text = req.body?.text;
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'text 不能为空' });
    }
    if (jobStore.activeCount() >= MAX_ACTIVE_JOBS) {
      return res.status(429).json({ error: '当前活动 job 数已达上限,请稍候' });
    }

    const job = jobStore.create();
    job.status = 'running';

    // 启动后台任务
    setImmediate(async () => {
      const orchestrator = new DownloadOrchestrator({
        fileStorage,
        livePhotoWriter,
        callback,
        baseUrl: deps.publicBaseUrl,
        onProgress: (e: ProgressEvent) => {
          job.emitter.emit('progress', e);
        },
      });
      try {
        const result = await orchestrator.downloadContent(text);
        job.result = result;
        job.status = 'done';
        job.emitter.emit('progress', {
          type: 'phase',
          phase: 'parse',
          message: 'completed',
        } as ProgressEvent);
        sseBroadcast(job, 'done', {
          ok: result.ok,
          savedFiles: result.savedFiles,
          picturesDir: fileStorage.picturesDir(),
          videosDir: fileStorage.videosDir(),
        });
        job.emitter.emit('end');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        job.errorMsg = msg;
        job.status = 'error';
        sseBroadcast(job, 'error', { message: msg, fatal: true });
        job.emitter.emit('end');
      } finally {
        jobStore.scheduleCleanup(job.id);
      }
    });

    return res.status(200).json({ jobId: job.id });
  });

  /**
   * SSE 进度通道。客户端拿 jobId 来订阅。
   */
  router.get('/download/events', (req, res) => {
    const jobId = typeof req.query.jobId === 'string' ? req.query.jobId : '';
    const job = jobStore.get(jobId);
    if (!job) {
      return res.status(404).json({ error: 'job not found' });
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof (res as unknown as { flushHeaders?: () => void }).flushHeaders === 'function') {
      (res as unknown as { flushHeaders: () => void }).flushHeaders();
    }

    job.clients.add(res);

    // 立即推一条 phase 让前端知道通道通
    if (job.status === 'done') {
      sseWrite(res, 'phase', { phase: 'parse', message: 'completed' });
      sseWrite(res, 'done', {
        ok: job.result?.ok ?? false,
        savedFiles: job.result?.savedFiles ?? [],
        picturesDir: fileStorage.picturesDir(),
        videosDir: fileStorage.videosDir(),
      });
      job.clients.delete(res);
      res.end();
      return;
    }
    if (job.status === 'error') {
      sseWrite(res, 'phase', { phase: 'parse', message: 'error' });
      sseWrite(res, 'error', { message: job.errorMsg ?? 'unknown', fatal: true });
      job.clients.delete(res);
      res.end();
      return;
    }
    sseWrite(res, 'phase', { phase: 'parse', message: 'started' });

    const onProgress = (evt: ProgressEvent) => sseWrite(res, evt.type, evt);
    job.emitter.on('progress', onProgress);

    const onEnd = () => {
      clearInterval(hb);
      job.emitter.off('progress', onProgress);
      job.emitter.off('end', onEnd);
      job.clients.delete(res);
      if (!res.writableEnded) {
        try {
          res.end();
        } catch {
          /* ignore */
        }
      }
    };
    job.emitter.on('end', onEnd);

    // 心跳
    const hb = setInterval(() => {
      if (res.writableEnded) {
        clearInterval(hb);
        return;
      }
      try {
        res.write(': keep-alive\n\n');
      } catch {
        clearInterval(hb);
      }
    }, 15_000);

    req.on('close', onEnd);
  });

  router.get('/history', async (_req, res) => {
    // 简单列出 storage 目录下的文件,前端展示历史
    const picDir = fileStorage.picturesDir();
    const vidDir = fileStorage.videosDir();
    const items: Array<{
      fileName: string;
      absPath: string;
      publicUrl: string;
      isVideo: boolean;
      size: number;
      mtime: number;
    }> = [];

    async function walk(dir: string, isVideo: boolean) {
      try {
        const entries = await fs.promises.readdir(dir, { withFileTypes: true });
        for (const e of entries) {
          if (!e.isFile()) continue;
          const abs = path.join(dir, e.name);
          const stat = await fs.promises.stat(abs);
          const rel = abs
            .substring(fileStorage.rootDir().length)
            .replace(/\\/g, '/')
            .replace(/^\/+/, '');
          items.push({
            fileName: e.name,
            absPath: abs,
            publicUrl: `${deps.publicBaseUrl}/media/${rel}`,
            isVideo,
            size: stat.size,
            mtime: stat.mtimeMs,
          });
        }
      } catch {
        // 目录不存在时静默跳过
      }
    }

    await walk(picDir, false);
    await walk(vidDir, true);
    items.sort((a, b) => b.mtime - a.mtime);
    return res.json({ items });
  });

  return router;
}

/** 给 job 上所有 SSE 客户端广播。 */
function sseBroadcast(job: JobState, event: string, data: unknown): void {
  for (const res of job.clients) {
    sseWrite(res, event, data);
  }
}