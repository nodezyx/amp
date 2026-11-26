#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const CONFIG = {
  siteOrigin: 'https://ytmp3pc.com',
  searchPath: '/J0GPK30qWps',
  infoPath: '/hP2pPvYldCo',
  musicApiOrigin: 'https://ytzyar.cc',
  bucketOrigin: 'https://bucketx3.ytzyar.cc',
  widgetOrigin: 'https://nodex3.ytzyar.cc',
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  pollIntervalMs: 1500,
  pollTimeoutMs: 120000,
};

function extractYouTubeId(input) {
  if (!input || typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return trimmed;
  const match = trimmed.match(
    /^.*(?:youtu\.be\/|v\/|\/u\/\w\/|embed\/|shorts\/|watch\?(?:.*&)?v=)([a-zA-Z0-9_-]{11})/
  );
  return match ? match[1] : null;
}

function computeToken(videoId) {
  const s = videoId.toLowerCase();
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h += s.charCodeAt(i);
    h += h << 10;
    h ^= h >>> 6;
  }
  h += h << 3;
  h ^= h >>> 11;
  h += h << 15;
  return h >>> 0;
}

function siteHeaders() {
  return {
    Accept: 'application/json',
    Referer: `${CONFIG.siteOrigin}/`,
    'User-Agent': CONFIG.userAgent,
  };
}

function converterHeaders(videoId, accept = 'application/json') {
  return {
    Accept: accept,
    'Content-Type': 'application/json',
    Origin: CONFIG.widgetOrigin,
    Referer: `${CONFIG.widgetOrigin}/${videoId}`,
    'User-Agent': CONFIG.userAgent,
  };
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, { signal: AbortSignal.timeout(options.timeoutMs || 30000), ...options });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`HTTP ${res.status} non-JSON from ${url}: ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    const msg = data?.message || `HTTP ${res.status}`;
    throw new Error(`Request failed (${res.status}): ${msg}`);
  }
  return data;
}

async function search(query) {
  const url = `${CONFIG.siteOrigin}${CONFIG.searchPath}?query=${encodeURIComponent(query)}`;
  const data = await fetchJson(url, { headers: siteHeaders() });
  return {
    query: data.query || query,
    items: Array.isArray(data.items) ? data.items : [],
  };
}

async function getInfo(input) {
  const videoId = extractYouTubeId(input);
  if (!videoId) throw new Error(`Invalid YouTube URL or ID: ${input}`);
  const url = `${CONFIG.siteOrigin}${CONFIG.infoPath}?v=${encodeURIComponent(videoId)}`;
  const data = await fetchJson(url, { headers: siteHeaders() });
  return {
    videoId,
    ...data,
    formats: {
      mp3: data.formats?.mp3 ? `${CONFIG.siteOrigin}${data.formats.mp3}` : null,
      mp4: data.formats?.mp4 ? `${CONFIG.siteOrigin}${data.formats.mp4}` : null,
    },
  };
}

async function getFormats(input, type = 'mp3') {
  const videoId = extractYouTubeId(input);
  if (!videoId) throw new Error(`Invalid YouTube URL or ID: ${input}`);
  const token = computeToken(videoId);
  const kind = type.toLowerCase();
  if (kind !== 'mp3' && kind !== 'mp4') {
    throw new Error(`Unsupported format type: ${type} (use "mp3" or "mp4")`);
  }

  const url =
    kind === 'mp3'
      ? `${CONFIG.musicApiOrigin}/music/available-music?v=${encodeURIComponent(videoId)}&token=${token}`
      : `${CONFIG.bucketOrigin}/video/available-video?v=${encodeURIComponent(videoId)}&token=${token}`;

  const data = await fetchJson(url, { headers: converterHeaders(videoId) });
  if (!data.success) {
    throw new Error(data.message || 'Failed to fetch available formats');
  }
  return data.data;
}

async function convert(input, options = {}) {
  const videoId = extractYouTubeId(input);
  if (!videoId) throw new Error(`Invalid YouTube URL or ID: ${input}`);

  const type = (options.type || 'mp3').toLowerCase();
  if (type !== 'mp3' && type !== 'mp4') {
    throw new Error(`Unsupported format type: ${type} (use "mp3" or "mp4")`);
  }

  const pollIntervalMs = options.pollIntervalMs ?? CONFIG.pollIntervalMs;
  const pollTimeoutMs = options.pollTimeoutMs ?? CONFIG.pollTimeoutMs;
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  const sig = computeToken(videoId);

  let quality = options.quality;
  let meta = null;
  if (quality === undefined || quality === null) {
    meta = await getFormats(videoId, type);
    const first = meta.detail?.[0];
    if (!first) throw new Error(`No ${type} qualities available for ${videoId}`);
    quality = first.quality;
  }

  const endpointPrefix = type === 'mp3' ? 'music' : 'video';
  const payload = {
    video_id: videoId,
    quality: type === 'mp3' ? String(quality) : Number(quality),
    sig,
  };

  const preUrl = `${CONFIG.bucketOrigin}/${endpointPrefix}/pre-progress`;
  const prep = await fetchJson(preUrl, {
    method: 'POST',
    headers: converterHeaders(videoId, 'text/event-stream'),
    body: JSON.stringify(payload),
  });

  if (!prep.success || !prep.data?.job_id) {
    throw new Error(prep.message || 'Failed to enqueue conversion job');
  }

  const jobId = prep.data.job_id;
  const progressUrl = `${CONFIG.bucketOrigin}/${endpointPrefix}/progress?job_id=${encodeURIComponent(jobId)}`;
  const deadline = Date.now() + pollTimeoutMs;

  while (Date.now() < deadline) {
    const state = await fetchJson(progressUrl, {
      headers: converterHeaders(videoId),
    });

    if (onProgress) onProgress(state);

    const status = (state.status || state.data?.status || '').toLowerCase();
    if (state.download_url) {
      return {
        videoId,
        type,
        quality: payload.quality,
        jobId,
        title: meta?.title || null,
        author: meta?.author || null,
        downloadUrl: state.download_url,
        status,
      };
    }

    if (status === 'failed' || status === 'error') {
      throw new Error(state.message || `Conversion failed for ${videoId}`);
    }

    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  throw new Error(`Timed out waiting for job ${jobId}`);
}

async function downloadFile(downloadUrl, outPath) {
  const res = await fetch(downloadUrl, {
    headers: {
      Origin: CONFIG.widgetOrigin,
      Referer: `${CONFIG.widgetOrigin}/`,
      'User-Agent': CONFIG.userAgent,
    },
  });
  if (!res.ok || !res.body) {
    throw new Error(`Download failed: HTTP ${res.status}`);
  }

  let targetPath = outPath;
  if (!targetPath) {
    const disp = res.headers.get('content-disposition') || '';
    const m =
      disp.match(/filename\*=UTF-8''([^;]+)/i) ||
      disp.match(/filename="?([^";]+)"?/i);
    const filename = m ? decodeURIComponent(m[1]).replace(/[<>:"/\\|?*]/g, '_') : `download_${Date.now()}`;
    targetPath = path.resolve(process.cwd(), filename);
  }

  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(targetPath));
  return {
    path: targetPath,
    bytes: fs.statSync(targetPath).size,
    contentType: res.headers.get('content-type') || null,
  };
}

module.exports = {
  CONFIG,
  extractYouTubeId,
  computeToken,
  search,
  getInfo,
  getFormats,
  convert,
  downloadFile,
};

if (require.main === module) {
  (async () => {
    const [cmd, arg1, arg2, arg3] = process.argv.slice(2);
    if (!cmd) {
      console.error(
        'Usage:\n' +
          '  node ytmp3pc.js search <query>\n' +
          '  node ytmp3pc.js info <url|videoId>\n' +
          '  node ytmp3pc.js formats <url|videoId> [mp3|mp4]\n' +
          '  node ytmp3pc.js convert <url|videoId> [mp3|mp4] [quality]\n' +
          '  node ytmp3pc.js download <url|videoId> [mp3|mp4] [outFile]'
      );
      process.exit(1);
    }

    if (cmd === 'search') {
      const res = await search(process.argv.slice(3).join(' '));
      console.log(JSON.stringify(res, null, 2));
    } else if (cmd === 'info') {
      const res = await getInfo(arg1);
      console.log(JSON.stringify(res, null, 2));
    } else if (cmd === 'formats') {
      const res = await getFormats(arg1, arg2 || 'mp3');
      console.log(JSON.stringify(res, null, 2));
    } else if (cmd === 'convert') {
      const res = await convert(arg1, {
        type: arg2 || 'mp3',
        quality: arg3,
        onProgress: (s) => {
          const p = s.data?.percent ?? 0;
          const st = s.status || s.data?.status || '';
          process.stderr.write(`\r[${st}] ${p}%   `);
        },
      });
      process.stderr.write('\n');
      console.log(JSON.stringify(res, null, 2));
    } else if (cmd === 'download') {
      const conv = await convert(arg1, {
        type: arg2 || 'mp3',
        onProgress: (s) => {
          const p = s.data?.percent ?? 0;
          const st = s.status || s.data?.status || '';
          process.stderr.write(`\r[${st}] ${p}%   `);
        },
      });
      process.stderr.write('\n');
      const saved = await downloadFile(conv.downloadUrl, arg3);
      console.log(JSON.stringify({ ...conv, saved }, null, 2));
    } else {
      throw new Error(`Unknown command: ${cmd}`);
    }
  })().catch((err) => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });
}
