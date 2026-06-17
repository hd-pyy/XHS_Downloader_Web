// XHS Downloader Web 版前端 —— 单文件 vanilla JS。
// 「下载到本机」:起 /api/download/start 后台 job,订阅 /api/download/events SSE
// 拿解析阶段进度 (note_start / note_done) + 文件阶段进度 (media_start / media_done);
// 每个文件通过 fetch + ReadableStream 拉 /api/fetch 字节流,累加字节/Content-Length
// 显示进度,拉完后用 Blob + <a download> 触发浏览器原生下载。

const $ = (id) => document.getElementById(id);
const textInput = $('text-input');
const btnParse = $('btn-parse');
const btnDownload = $('btn-download');
const statusEl = $('status');
const resultsSection = $('results-section');
const resultsEl = $('results');

// 下载进度 UI
const dpCard = $('download-progress');
const dpCurrent = $('dp-current');
const dpTotal = $('dp-total');
const dpBar = $('dp-bar');
const dpSubbarWrap = $('dp-subbar-wrap');
const dpSubbar = $('dp-subbar');
const dpDetail = $('dp-detail');

function setStatus(msg, kind = '') {
  statusEl.textContent = msg;
  statusEl.className = 'status' + (kind ? ' ' + kind : '');
}

/**
 * 重置进度条 UI 到初始状态。
 * @param {number} total 总文件数(用于显示 0/N)
 */
function resetProgress(total) {
  dpCard.hidden = false;
  dpCard.classList.remove('done', 'error');
  dpCurrent.textContent = '0';
  dpTotal.textContent = String(total || 0);
  dpBar.style.width = '0%';
  dpSubbar.style.width = '0%';
  dpSubbarWrap.hidden = true;
  dpDetail.textContent = total ? '准备中…' : '解析中…';
}

/**
 * 更新进度条 UI。
 * @param {object} s
 * @param {string} s.phase 'parse' | 'download' | 'done' | 'error'
 * @param {number} [s.current] 已完成文件数
 * @param {number} [s.total] 总文件数
 * @param {string} [s.fileName] 当前文件名
 * @param {number} [s.loaded] 当前文件已下载字节
 * @param {number} [s.totalBytes] 当前文件总字节(Content-Length)
 * @param {string} [s.detail] 自定义 detail 文本
 */
function updateProgress(s) {
  if (s.phase === 'done') {
    dpCard.classList.add('done');
    dpBar.style.width = '100%';
    dpSubbar.style.width = '100%';
    dpDetail.textContent = s.detail || '下载完成';
    return;
  }
  if (s.phase === 'error') {
    dpCard.classList.add('error');
    dpDetail.textContent = s.detail || '下载失败';
    return;
  }
  if (typeof s.total === 'number' && s.total >= 0) {
    dpTotal.textContent = String(s.total);
  }
  if (typeof s.current === 'number' && s.current >= 0) {
    dpCurrent.textContent = String(s.current);
    const ratio = s.total > 0 ? Math.min(1, s.current / s.total) : 0;
    dpBar.style.width = (ratio * 100).toFixed(1) + '%';
  }
  if (s.phase === 'download') {
    dpSubbarWrap.hidden = false;
    if (typeof s.loaded === 'number') {
      if (s.totalBytes && s.totalBytes > 0) {
        const sr = Math.min(1, s.loaded / s.totalBytes);
        dpSubbar.style.width = (sr * 100).toFixed(1) + '%';
        dpDetail.textContent = `${s.fileName || ''} ${fmtBytes(s.loaded)} / ${fmtBytes(s.totalBytes)}`;
      } else {
        // 无 Content-Length,unknown 模式,只显示已下载
        dpDetail.textContent = `${s.fileName || ''} ${fmtBytes(s.loaded)} / ?`;
      }
    } else if (s.fileName) {
      dpDetail.textContent = s.fileName;
    }
  } else if (s.phase === 'parse') {
    dpSubbarWrap.hidden = true;
    if (s.detail) dpDetail.textContent = s.detail;
  }
}

function fmtBytes(n) {
  if (typeof n !== 'number' || !isFinite(n) || n < 0) return '0 B';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

function hideProgress() {
  dpCard.hidden = true;
}

function renderMediaItem(url, isVideo) {
  const div = document.createElement('div');
  div.className = 'media-item';
  if (isVideo) {
    const v = document.createElement('video');
    v.src = url;
    v.controls = true;
    v.muted = true;
    v.playsInline = true;
    div.appendChild(v);
  } else {
    const img = document.createElement('img');
    img.src = url;
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    div.appendChild(img);
  }
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = url;
  div.appendChild(meta);
  return div;
}

function looksLikeVideo(url) {
  const lower = url.toLowerCase();
  return lower.includes('.mp4') || lower.includes('.mov') || lower.includes('video') || lower.includes('masterurl');
}

async function callParse() {
  const text = textInput.value.trim();
  if (!text) {
    setStatus('请先粘贴小红书分享文案或链接', 'error');
    return;
  }
  setStatus('解析中…');
  btnParse.disabled = true;
  btnDownload.disabled = true;
  try {
    const res = await fetch('/api/parse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const json = await res.json();
    if (!res.ok) {
      setStatus(json.error ?? '解析失败', 'error');
      resultsSection.hidden = true;
      return;
    }
    renderParseResults(json.results ?? []);
    setStatus(`解析完成:${(json.results ?? []).length} 条`, 'ok');
  } catch (e) {
    setStatus('解析异常: ' + (e?.message ?? e), 'error');
  } finally {
    btnParse.disabled = false;
    btnDownload.disabled = false;
  }
}

function renderParseResults(results) {
  resultsEl.innerHTML = '';
  if (!results.length) {
    resultsSection.hidden = true;
    return;
  }
  for (const note of results) {
    const block = document.createElement('div');
    block.className = 'note-block';
    const urlDiv = document.createElement('div');
    urlDiv.className = 'url';
    urlDiv.textContent = `${note.postId ?? '(no postId)'} — ${note.originalUrl}`;
    block.appendChild(urlDiv);

    if (note.error) {
      const e = document.createElement('div');
      e.className = 'status error';
      e.textContent = note.error;
      block.appendChild(e);
    }

    const grid = document.createElement('div');
    grid.className = 'media-grid';
    for (const u of note.mediaUrls) {
      grid.appendChild(renderMediaItem(u, looksLikeVideo(u)));
    }
    block.appendChild(grid);
    resultsEl.appendChild(block);
  }
  resultsSection.hidden = false;
}

/**
 * 通过 fetch + ReadableStream 拉 /api/fetch,累加字节触发字节进度回调,
 * 最后 Blob + <a download> 触发浏览器下载。
 * @param {string} url 媒体 URL
 * @param {string} name 下载文件名
 * @param {(loaded:number,totalBytes:number|undefined)=>void} onProgress
 * @returns {Promise<{ok:boolean,totalBytes?:number,error?:string}>}
 */
async function fetchAndDownloadBlob(url, name, onProgress) {
  const fetchUrl = `/api/fetch?url=${encodeURIComponent(url)}&name=${encodeURIComponent(name)}`;
  const res = await fetch(fetchUrl);
  if (!res.ok || !res.body) {
    const errText = await res.text().catch(() => '');
    return { ok: false, error: `HTTP ${res.status}: ${errText || res.statusText}` };
  }
  const totalHeader = res.headers.get('content-length');
  const totalBytes = totalHeader ? Number(totalHeader) : undefined;

  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  onProgress(0, totalBytes);

  // 中断标记:若用户刷新/关闭 tab,reader 也会抛 AbortError
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress(loaded, totalBytes);
  }

  const blob = new Blob(chunks);
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = name;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 给浏览器一点时间真正发起下载,再 revoke
  setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);

  return { ok: true, totalBytes };
}

/**
 * 「下载到本机」(异步 SSE 进度版):
 * 1) POST /api/download/start 拿 jobId
 * 2) 订阅 GET /api/download/events?jobId=... SSE:
 *    - note_start  → 切到 parse 阶段,显示 N/M
 *    - note_done   → N++
 *    - media_start → 拉该文件 fetch + Blob 触发下载
 *    - media_done  → M++
 *    - done / error → 收尾
 */
async function callDownload() {
  const text = textInput.value.trim();
  if (!text) {
    setStatus('请先粘贴小红书分享文案或链接', 'error');
    return;
  }

  setStatus('已提交下载任务…');
  btnParse.disabled = true;
  btnDownload.disabled = true;

  // 状态
  let noteIdx = 0;
  let noteTotal = 0;
  let fileIdx = 0;
  let fileTotal = 0;
  // SSE 期间每个文件"自己"并发 fetch(避免被 SSE 单线程阻塞),
  // 用一个 in-flight 集合跟踪
  /** @type {Map<string, Promise<any>>} */
  const inflight = new Map();

  resetProgress(0);
  updateProgress({ phase: 'parse', detail: '解析中…' });

  let es;
  try {
    // 1) 启动 job
    const startRes = await fetch('/api/download/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const startJson = await startRes.json();
    if (!startRes.ok) {
      throw new Error(startJson.error ?? '启动下载失败');
    }
    const jobId = startJson.jobId;

    // 2) 订阅 SSE
    await new Promise((resolve, reject) => {
      es = new EventSource(`/api/download/events?jobId=${encodeURIComponent(jobId)}`);

      es.addEventListener('phase', (e) => {
        const d = JSON.parse(e.data);
        // 'parse' / 'fetch' / 'livephoto' 都视作准备阶段(子进度条隐藏,只显示文字)
        // 'download' 切到下载阶段(显示子进度条)
        const visualPhase = (d.phase === 'download') ? 'download' : 'parse';
        if (typeof d.message === 'string') {
          updateProgress({ phase: visualPhase, detail: d.message });
        }
      });

      es.addEventListener('note_start', (e) => {
        const d = JSON.parse(e.data);
        noteTotal = d.total || noteTotal;
        updateProgress({
          phase: 'parse',
          total: noteTotal,
          current: d.index - 1,
          detail: `正在解析 ${d.postId || ''} (${d.index}/${noteTotal})`,
        });
      });

      es.addEventListener('note_done', (e) => {
        const d = JSON.parse(e.data);
        noteIdx = d.index;
        updateProgress({
          phase: 'parse',
          total: noteTotal,
          current: noteIdx,
          detail: `已解析 ${d.index}/${noteTotal}`,
        });
      });

      es.addEventListener('media_start', (e) => {
        const d = JSON.parse(e.data);
        // 总数取最大(可能稍后才到 media_done,先记)
        if (typeof d.total === 'number' && d.total > fileTotal) {
          fileTotal = d.total;
        }
        updateProgress({
          phase: 'download',
          total: fileTotal,
          current: fileIdx,
          fileName: d.fileName,
          loaded: 0,
          totalBytes: undefined,
        });

        // 立刻起一个并发 fetch 把文件拉下来
        const key = d.fileName + '|' + (d.url || '');
        if (!inflight.has(key)) {
          const p = fetchAndDownloadBlob(d.url, d.fileName, (loaded, totalBytes) => {
            // 只更新当前文件 sub-bar 进度(用 detail 显示字节)
            updateProgress({
              phase: 'download',
              total: fileTotal,
              current: fileIdx,
              fileName: d.fileName,
              loaded,
              totalBytes,
            });
          })
            .then((r) => r)
            .catch((e) => ({ ok: false, error: String(e) }))
            .finally(() => inflight.delete(key));
          inflight.set(key, p);
        }
      });

      es.addEventListener('media_done', (e) => {
        const d = JSON.parse(e.data);
        if (typeof d.total === 'number' && d.total > fileTotal) {
          fileTotal = d.total;
        }
        fileIdx = d.index;
        updateProgress({
          phase: 'download',
          total: fileTotal,
          current: fileIdx,
          fileName: d.fileName,
          loaded: d.ok ? 1 : 0,
          totalBytes: d.ok ? 1 : 0, // 100% sub-bar
          detail: d.ok ? `${d.fileName} 已下载` : `${d.fileName} 失败: ${d.error || '未知'}`,
        });
      });

      es.addEventListener('livephoto_done', (e) => {
        const d = JSON.parse(e.data);
        updateProgress({
          phase: 'download',
          total: fileTotal,
          current: fileIdx,
          fileName: d.fileName,
          loaded: d.ok ? 1 : 0,
          totalBytes: d.ok ? 1 : 0,
          detail: d.ok ? `Live Photo ${d.fileName} 完成` : `Live Photo ${d.fileName} 失败`,
        });
      });

      es.addEventListener('done', (e) => {
        const d = JSON.parse(e.data);
        const count = (d.savedFiles || []).length;
        updateProgress({
          phase: 'done',
          current: fileTotal || count,
          total: fileTotal || count,
          detail: `已完成 ${count} 个文件,共 ${fileTotal || count} 个`,
        });
        try { es.close(); } catch { /* ignore */ }
        resolve(null);
      });

      es.addEventListener('error', () => {
        // EventSource 错误:断网 / 服务端关流 都会触发
        if (!es || es.readyState === EventSource.CLOSED) {
          try { es.close(); } catch { /* ignore */ }
          reject(new Error('SSE 连接已关闭'));
        }
      });
    });

    // 等待所有 inflight fetch 完成(本轮 download 真正落本地)
    await Promise.allSettled([...inflight.values()]);

    setStatus(`已下载 ${fileTotal} 个文件到本机`, 'ok');
    setTimeout(hideProgress, 3000);
  } catch (e) {
    setStatus('下载异常: ' + (e?.message ?? e), 'error');
    updateProgress({ phase: 'error', detail: e?.message || String(e) });
    setTimeout(hideProgress, 5000);
  } finally {
    if (es) { try { es.close(); } catch { /* ignore */ } }
    btnParse.disabled = false;
    btnDownload.disabled = false;
  }
}

function inferExt(url) {
  const lower = url.toLowerCase();
  if (lower.includes('.mp4') || lower.includes('masterurl') || lower.includes('stream')) return 'mp4';
  if (lower.includes('.png')) return 'png';
  if (lower.includes('.gif')) return 'gif';
  if (lower.includes('.webp')) return 'webp';
  return 'jpg';
}

btnParse.addEventListener('click', callParse);
btnDownload.addEventListener('click', callDownload);
