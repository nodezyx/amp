// SUBZERO MD MINI - API client
// One place for every external API the downloader / AI / lyrics commands use.
// Replaces the old (dead) davidcyril / dixonomega / dev-priyanshi / delirius endpoints.
//
//   KYIO     https://api.kyio.web.id     all-in-one downloader, YouTube, X/Twitter, Facebook
//   OMEGA    https://api.omegatech.app   AI chatbot + lyrics
//
// Every downloader function returns the same normalised shape so commands can treat
// every platform identically:
//   { platform, title, author, duration, thumbnail, items: [ { type, label, url, quality } ] }
//   type is one of: 'video' | 'audio' | 'image'

const axios = require('axios');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const http = require('http');
const { pipeline } = require('stream/promises');
const { Transform } = require('stream');
const config = require('../config');

const KYIO = config.KYIO_API_BASE;
const OMEGA = config.OMEGA_API_BASE;
const NEXRAY = config.NEXRAY_API_BASE;
const AZBRY = config.AZBRY_API_BASE;
const FAA = config.FAA_API_BASE;
const useExtras = () => String(config.EXTRA_PROVIDERS).toLowerCase() !== 'false';

// Keep-alive connections: repeated API calls and CDN downloads skip the TLS handshake.
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 32 });
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 32 });

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// ---------------------------------------------------------------- http helpers

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// GET JSON with a couple of retries (these free APIs are flaky).
async function getJson(url, params = {}, { timeout = 45000, retries = 2 } = {}) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const res = await axios.get(url, { params, timeout, httpsAgent, httpAgent, headers: { 'User-Agent': UA, Accept: 'application/json' } });
            return res.data;
        } catch (err) {
            lastErr = err;
            const status = err.response?.status;
            // Client errors will not fix themselves - don't retry them.
            if (status && status >= 400 && status < 500 && status !== 429) break;
            if (attempt < retries) await sleep(1200 * (attempt + 1));
        }
    }
    const status = lastErr?.response?.status;
    throw new Error(status ? `API responded with HTTP ${status}` : `API request failed: ${lastErr?.message || 'unknown error'}`);
}

// Download a remote file into memory. Throws if it is larger than maxMB.
async function fetchBuffer(url, { maxMB = 95, timeout = 120000 } = {}) {
    const res = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout,
        maxContentLength: maxMB * 1024 * 1024,
        maxBodyLength: maxMB * 1024 * 1024,
        headers: { 'User-Agent': UA, 'Accept-Encoding': 'identity' },
    });
    return Buffer.from(res.data);
}

// Stream a remote file to a temp file on disk. Nothing is held in RAM, so a 300 MB video costs the
// same memory as a 3 MB one. Baileys can then send it straight from the path ({ url: path }).
async function downloadToFile(url, { maxMB = config.MAX_MEDIA_MB, minBytes = 2048, headers } = {}) {
    const res = await axios.get(url, {
        responseType: 'stream', timeout: 30000, maxRedirects: 6, httpsAgent, httpAgent,
        headers: { 'User-Agent': UA, 'Accept-Encoding': 'identity', Accept: '*/*', ...(headers || {}) },
    });
    const limit = maxMB * 1048576;
    const len = Number(res.headers['content-length'] || 0);
    const ctype = String(res.headers['content-type'] || '').toLowerCase();
    if (len && len > limit) { res.data.destroy(); throw new Error(`File is too large (${Math.round(len / 1048576)} MB, limit ${maxMB} MB)`); }
    if (/text\/html|application\/json/.test(ctype)) { res.data.destroy(); throw new Error('The link did not return a media file'); }

    const file = path.join(os.tmpdir(), `szm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    let seen = 0;
    const guard = new Transform({
        transform(chunk, _enc, cb) {
            seen += chunk.length;
            if (seen > limit) return cb(new Error(`File is too large (limit ${maxMB} MB)`));
            cb(null, chunk);
        },
    });
    const cleanup = () => fs.promises.unlink(file).catch(() => {});
    try {
        await pipeline(res.data, guard, fs.createWriteStream(file));
        // cut-off transfer: the server promised more bytes than it delivered
        if (len && seen < len) throw new Error(`Download was cut off (${seen} of ${len} bytes)`);
        if (seen < minBytes) throw new Error(`The provider returned a tiny file (${Math.round(seen / 1024)} KB) instead of the media`);
        // some servers answer 200 with an HTML / JSON error page and a generic content type
        const fd = await fs.promises.open(file, 'r');
        try {
            const head = Buffer.alloc(Math.min(256, seen));
            await fd.read(head, 0, head.length, 0);
            if (/^\s*(<!doctype|<html|<\?xml|\{|\[)/i.test(head.toString('utf8'))) throw new Error('The link returned a web page / error instead of a media file');
        } finally { await fd.close(); }
    } catch (err) {
        await cleanup();
        throw err;
    }
    return { path: file, size: seen, mime: ctype, cleanup };
}

// ---------------------------------------------------------------- provider racing
// Every downloader has several providers. We keep a running latency score per provider, start the
// fastest one first, and if it has not answered within API_HEDGE_MS (or it fails) start the next one
// at once. The first good answer wins - slow or dead APIs cannot hold the user up.

const stats = new Map(); // provider name -> { ms, fails }
const score = (name) => { const x = stats.get(name); return x ? x.ms + x.fails * 5000 : 1500; };
function record(name, ms, ok) {
    const x = stats.get(name) || { ms: ms, fails: 0 };
    if (ok) { x.ms = x.ms * 0.6 + ms * 0.4; x.fails = Math.max(0, x.fails - 1); } else { x.fails = Math.min(5, x.fails + 1); }
    stats.set(name, x);
}

// candidates: [{ name, run: async () => result }]  (array order = priority for error reporting)
function hedged(candidates, hedgeMs = config.API_HEDGE_MS) {
    const list = candidates.map((c, idx) => ({ ...c, idx })).sort((a, b) => score(a.name) - score(b.name));
    return new Promise((resolve, reject) => {
        let started = 0, failed = 0, done = false;
        const errs = [];
        const timers = [];
        const finish = (fn, v) => { if (done) return; done = true; timers.forEach(clearTimeout); fn(v); };
        const launch = () => {
            if (done || started >= list.length) return;
            const c = list[started++];
            const t0 = Date.now();
            Promise.resolve().then(() => c.run()).then(
                (v) => { record(c.name, Date.now() - t0, true); finish(resolve, v); },
                (e) => {
                    record(c.name, Date.now() - t0, false);
                    errs[c.idx] = e;
                    console.warn(`[api] ${c.name} failed: ${e.message}`);
                    failed++;
                    if (failed >= list.length) finish(reject, errs.find(Boolean) || e);
                    else launch();
                },
            );
            if (started < list.length) timers.push(setTimeout(launch, hedgeMs));
        };
        launch();
    });
}

// Pull the first URL out of free text (".ig https://..." -> "https://...").
function extractUrl(text = '') {
    const m = String(text).match(/https?:\/\/[^\s<>"']+/i);
    return m ? m[0].replace(/[),.;]+$/, '') : null;
}

// Which platform does a link belong to?
function detectPlatform(url = '') {
    const u = url.toLowerCase();
    if (/(tiktok\.com|vm\.tiktok|vt\.tiktok)/.test(u)) return 'tiktok';
    if (/(instagram\.com|instagr\.am)/.test(u)) return 'instagram';
    if (/(facebook\.com|fb\.watch|fb\.com|fb\.me)/.test(u)) return 'facebook';
    if (/(youtube\.com|youtu\.be)/.test(u)) return 'youtube';
    if (/(twitter\.com|x\.com|t\.co)/.test(u)) return 'twitter';
    return 'other';
}

// The providers are inconsistent about their envelope: success has been seen as `status: 200`,
// `status: true`, `success: true`, or no status at all. Only an explicit failure signal is an error.
function isFailureStatus(st) {
    if (st === undefined || st === null) return false;
    if (st === true) return false;
    if (st === false) return true;
    if (typeof st === 'number') return st >= 400;
    const v = String(st).toLowerCase();
    if (/^\d+$/.test(v)) return Number(v) >= 400;
    return ['false', 'error', 'failed', 'fail'].includes(v);
}

function unwrap(data, label) {
    if (!data || typeof data !== 'object') throw new Error(`${label}: empty response`);
    if (isFailureStatus(data.status) || data.success === false || data.error) {
        throw new Error(String(data.message || data.error || data.msg || `${label}: request failed`));
    }
    const r = data.result ?? data.data ?? data;
    if (r && typeof r === 'object' && (r.success === false || r.status === false)) {
        throw new Error(String(r.message || r.error || `${label}: request failed`));
    }
    return r;
}


// ---------------------------------------------------------------- tolerant media discovery
// Safety net for when a provider changes its JSON layout: walk the whole result and collect anything that
// looks like a media link, so a renamed field does not take a downloader down.
const SKIP_KEYS = /^(thumb(nail)?s?|cover|avatar|icon|preview|poster|sourceurl|author|owner|music_?cover)$/i;
const guessType = (url, hint = '') => {
    const h = `${hint} ${url}`.toLowerCase();
    if (/audio|mp3|m4a|\.aac|[?&]sf=mp3|music/.test(h)) return 'audio';
    if (/\.(jpe?g|png|webp)(\?|$)|image|photo|picture/.test(h) && !/video|mp4/.test(h)) return 'image';
    return 'video';
};
function genericItems(node, keyPath = '', out = [], seen = new Set()) {
    if (!node || out.length > 40) return out;
    if (typeof node === 'string') {
        if (/^https?:\/\//i.test(node) && !seen.has(node) && !SKIP_KEYS.test(keyPath.split('.').pop() || '')) {
            seen.add(node);
            out.push({ type: guessType(node, keyPath), label: keyPath.split('.').pop() || 'Download', url: node });
        }
        return out;
    }
    if (Array.isArray(node)) { node.forEach((n, i) => genericItems(n, `${keyPath}[${i}]`, out, seen)); return out; }
    if (typeof node === 'object') {
        if (typeof node.url === 'string' && /^https?:\/\//i.test(node.url) && !seen.has(node.url) && !SKIP_KEYS.test(keyPath.split('.').pop() || '')) {
            seen.add(node.url);
            const hint = [node.type, node.label, node.quality, node.extension, node.format, keyPath].filter(Boolean).join(' ');
            out.push({ type: guessType(node.url, hint), label: node.label || node.quality || node.type || 'Download', quality: node.quality, url: node.url });
            return out;
        }
        Object.entries(node).forEach(([k, v]) => genericItems(v, keyPath ? `${keyPath}.${k}` : k, out, seen));
    }
    return out;
}
// When the specific parser found nothing, try the generic walk; still nothing -> explain what came back.
function ensureItems(items, r, message) {
    if (items.length) return items;
    const found = genericItems(r);
    if (found.length) { console.warn('[api] specific parser found nothing; using generic media discovery'); return found; }
    console.warn('[api] unrecognised response shape:', JSON.stringify(r).slice(0, 600));
    throw new Error(`${message} (provider returned: ${Object.keys(r || {}).slice(0, 8).join(', ') || 'nothing'})`);
}

// ---------------------------------------------------------------- downloaders

// All-in-one: TikTok, Instagram, and anything else the provider supports.
// Two endpoints exist (aio-v2 and aiodl). We try the preferred one first and silently fall back to the
// other when it errors or returns nothing usable - that is what keeps .ig / .alldownload alive when one dies.
const AIO_ENDPOINTS = { v2: '/api/v2/downloader/aio-v2', v1: '/api/v2/aiodl' };

async function allDownload(url, { prefer = 'v2' } = {}) {
    const order = prefer === 'v1' ? ['v1', 'v2'] : ['v2', 'v1'];
    const plat = detectPlatform(url);
    const cands = order.map((which) => ({ name: `kyio${AIO_ENDPOINTS[which]}`, run: () => allDownloadFrom(AIO_ENDPOINTS[which], url) }));
    if (useExtras()) cands.push(...extraAio(url, plat));
    if (plat === 'tiktok') cands.push({ name: 'tikwm', run: () => tikwm(url) });
    return hedged(cands);
}

// Extra providers for "any link" downloads (Instagram, Facebook, TikTok, X ...).
function extraAio(url, plat) {
    const c = [{ name: 'nexray/aio', run: () => nexrayAio(url) }];
    if (plat === 'tiktok') c.push({ name: 'azbry/tiktok', run: () => azbryTiktok(url) });
    if (plat === 'instagram') c.push({ name: 'azbry/instagram', run: () => azbryInstagram(url) });
    c.push({ name: 'azbry/allinonev2', run: () => azbryAllInOne(url) });
    return c;
}

const fromMedias = (list) => (Array.isArray(list) ? list : [])
    .filter((m) => m && m.url)
    .map((m) => {
        const type = m.type === 'audio' ? 'audio' : m.type === 'image' ? 'image' : 'video';
        return { type, label: type === 'audio' ? 'Audio' : String(m.quality || 'Video'), quality: m.quality, url: m.url };
    });

// nexray: { status, result: { title, thumbnail, author, medias: [ { url, quality, type } ] } }
async function nexrayAio(url) {
    const data = await getJson(`${NEXRAY}/downloader/aio`, { url }, { timeout: 70000, retries: 0 });
    const r = unwrap(data, 'nexray');
    const items = fromMedias(r.medias);
    if (!items.length) throw new Error('nexray/aio: no media');
    // video first, audio last (nexray lists some videos flagged "is_audio" - they are still videos)
    return { platform: r.source || detectPlatform(url), title: r.title || null, author: typeof r.author === 'string' ? r.author : null, duration: null, thumbnail: r.thumbnail || null, items };
}

// azbry instagram: { status, type, videos: [url], images: [url] }
async function azbryInstagram(url) {
    const data = await getJson(`${AZBRY}/api/download/instagram`, { url }, { timeout: 40000, retries: 0 });
    if (!data || data.status === false) throw new Error(data?.message || 'azbry/instagram failed');
    const items = [];
    (data.videos || []).forEach((u, i) => u && items.push({ type: 'video', label: (data.videos.length > 1 ? `Video ${i + 1}` : 'Video'), url: u }));
    (data.images || []).forEach((u, i) => u && items.push({ type: 'image', label: `Image ${i + 1}`, url: u }));
    if (!items.length) throw new Error('azbry/instagram: no media');
    return { platform: 'Instagram', title: null, author: null, duration: null, thumbnail: data.thumb || null, items };
}

// azbry allinonev2: { status, result: { title, thumbnail, downloads: [ { label, url } ] } }
async function azbryAllInOne(url) {
    const data = await getJson(`${AZBRY}/api/download/allinonev2`, { url, format: 'mp4' }, { timeout: 40000, retries: 0 });
    const r = unwrap(data, 'azbry');
    const items = [];
    (r.downloads || []).forEach((d) => {
        if (!d?.url) return;
        const label = String(d.label || 'Download');
        const isAudio = /audio|mp3/i.test(label) || /[?&]sf=mp3/.test(d.url);
        const tag = /hd/i.test(label) ? 'HD' : /no_watermark|no watermark/i.test(label) ? 'No watermark' : /watermark/i.test(label) ? 'With watermark' : label;
        items.push({ type: isAudio ? 'audio' : 'video', label: isAudio ? 'Audio' : tag, quality: tag, url: d.url });
    });
    if (!items.length) throw new Error('azbry/allinonev2: no media');
    return { platform: detectPlatform(url), title: r.title || null, author: typeof r.owner === 'string' ? r.owner : null, duration: null, thumbnail: r.thumbnail || null, items };
}

// azbry tiktok: { result: { title, author, thumbnail, duration, music: { url }, links: [hd, play, wm] } }
async function azbryTiktok(url) {
    const data = await getJson(`${AZBRY}/api/download/tiktok`, { url }, { timeout: 40000, retries: 0 });
    const r = unwrap(data, 'azbry');
    const names = ['HD video', 'No watermark', 'With watermark'];
    const items = (r.links || []).filter(Boolean).map((u, i) => ({ type: 'video', label: names[i] || `Video ${i + 1}`, quality: names[i], url: u }));
    (r.images || []).forEach((u, i) => u && items.push({ type: 'image', label: `Image ${i + 1}`, url: u }));
    if (r.music?.url) items.push({ type: 'audio', label: 'Audio', url: r.music.url });
    if (!items.length) throw new Error('azbry/tiktok: no media');
    return { platform: 'TikTok', title: r.title || null, author: typeof r.author === 'string' ? r.author : null, duration: r.duration || null, thumbnail: r.thumbnail || null, items };
}

// tikwm.com - a long-running free TikTok API (no key). Shape: { code: 0, data: { play, hdplay, music, images, ... } }
async function tikwm(url) {
    const data = await getJson('https://www.tikwm.com/api/', { url, hd: 1 }, { timeout: 25000, retries: 0 });
    if (!data || data.code !== 0 || !data.data) throw new Error(data?.msg || 'tikwm: no result');
    const r = data.data;
    const items = [];
    if (r.hdplay) items.push({ type: 'video', label: 'HD video', quality: 'HD', url: r.hdplay });
    if (r.play) items.push({ type: 'video', label: 'No watermark', quality: 'SD', url: r.play });
    if (Array.isArray(r.images)) r.images.forEach((u, i) => items.push({ type: 'image', label: `Image ${i + 1}`, url: u }));
    const music = typeof r.music === 'string' ? r.music : r.music_info?.play;
    if (music) items.push({ type: 'audio', label: 'Audio', url: music });
    if (!items.length) throw new Error('tikwm: no media');
    return { platform: 'TikTok', title: r.title || null, author: r.author?.nickname || null, duration: r.duration || null, thumbnail: r.cover || null, items };
}

async function allDownloadFrom(endpoint, url) {
    const data = await getJson(`${KYIO}${endpoint}`, { url }, { retries: 0, timeout: 30000 });
    const r = unwrap(data, 'aio');
    if (r.success === false) throw new Error(r.message || 'Could not fetch that link');

    const items = [];

    // TikTok shape: { video: { no_watermark, hd, watermark }, music: { url }, images }
    if (r.video && typeof r.video === 'object') {
        if (r.video.hd) items.push({ type: 'video', label: 'HD video', quality: 'HD', url: r.video.hd });
        if (r.video.no_watermark) items.push({ type: 'video', label: 'No watermark', quality: 'SD', url: r.video.no_watermark });
        if (r.video.watermark) items.push({ type: 'video', label: 'With watermark', quality: 'WM', url: r.video.watermark });
    }
    if (Array.isArray(r.images)) {
        r.images.forEach((img, i) => {
            const u = typeof img === 'string' ? img : img?.url;
            if (u) items.push({ type: 'image', label: `Image ${i + 1}`, url: u });
        });
    }
    if (r.music?.url) items.push({ type: 'audio', label: 'Audio', url: r.music.url });

    // Instagram (and generic) shape: { downloads: [ { label, url } ] }
    if (Array.isArray(r.downloads)) {
        r.downloads.forEach((d) => {
            if (!d?.url) return;
            const label = d.label || 'Download';
            const isAudio = d.type === 'audio' || /audio|mp3/i.test(label) || /[?&]sf=mp3/.test(d.url);
            const isImage = d.type === 'image' || /image|photo|jpg|jpeg|png/i.test(label);
            items.push({ type: isAudio ? 'audio' : isImage ? 'image' : 'video', label, quality: label, url: d.url });
        });
    }
    if (!items.length && r.downloadUrl) items.push({ type: 'video', label: 'Download', url: r.downloadUrl });
    ensureItems(items, r, 'No downloadable media found for that link').forEach((i) => { if (!items.includes(i)) items.push(i); });

    return {
        platform: r.platform || detectPlatform(url),
        title: r.title || r.description || null,
        author: r.author?.nickname || r.author?.unique_id || (typeof r.owner === 'string' ? r.owner : r.owner?.name) || null,
        duration: r.duration || null,
        thumbnail: r.cover || r.thumbnail || null,
        stats: r.stats || null,
        items,
    };
}

// YouTube (video + audio) from a link.
//   1) GET /api/v2/ytdl?q=<link>                       (primary)
//   2) GET /api/v2/downloader/yt-fast?url=<link>&type=all   (fallback)
//   need: 'audio' | 'video' | 'both' - the caller says what it will actually send, so a provider that only
//   returns one kind is only used when that is enough.
async function youtube(url, { need = 'both' } = {}) {
    const full = [
        { name: 'kyio/ytdl', run: () => youtubeYtdl(url) },
        { name: 'kyio/yt-fast', run: () => youtubeFast(url) },
    ];
    if (!useExtras()) return hedged(full);

    const idMatch = url.match(/(?:v=|youtu\.be\/|shorts\/)([\w-]{11})/);
    const thumb = idMatch ? `https://i.ytimg.com/vi/${idMatch[1]}/hqdefault.jpg` : null;
    const audioOnly = [
        { name: 'nexray/ytmp3', run: () => nexrayYtmp3(url, thumb) },
        { name: 'azbry/ytmp3', run: () => azbryYt(url, 'ytmp3', thumb) },
    ];
    const videoOnly = [
        { name: 'azbry/ytmp4', run: () => azbryYt(url, 'ytmp4', thumb) },
        { name: 'faa/ytplayvid', run: () => faaVideo(url, thumb) },
    ];
    if (need === 'audio') return hedged([...full, ...audioOnly]);          // all of them race: any one is enough
    // Video / both: the full providers (they can offer several qualities) go first; the single-quality
    // ones start after FALLBACK_MS (or sooner, if the primary tier fails) and the first success wins.
    const fallbackTier = need === 'video' ? videoOnly : [{ name: 'azbry/yt(both)', run: () => azbryBoth(url, thumb) }];
    const FALLBACK_MS = 3500;
    const primary = hedged(full);
    let primaryErr = null;
    primary.catch((e) => { primaryErr = e; });
    const fallback = new Promise((resolve, reject) => {
        let started = false;
        const start = () => { if (started) return; started = true; hedged(fallbackTier).then(resolve, reject); };
        const t = setTimeout(start, FALLBACK_MS);
        primary.then(() => clearTimeout(t), () => { clearTimeout(t); start(); });
    });
    fallback.catch(() => {});
    return new Promise((resolve, reject) => {
        let pending = 2;
        const done = (err) => { if (--pending === 0) reject(primaryErr || err); };
        primary.then(resolve, done);
        fallback.then(resolve, done);
    });
}

// nexray: { result: { title, duration (s), filesize, url } }  (audio)
async function nexrayYtmp3(url, thumb) {
    const data = await getJson(`${NEXRAY}/downloader/ytmp3`, { url }, { timeout: 60000, retries: 0 });
    const r = unwrap(data, 'nexray');
    if (!r.url) throw new Error('nexray/ytmp3: no url');
    return { platform: 'YouTube', title: r.title || null, author: null, duration: r.duration ? Math.round(r.duration) : null, thumbnail: thumb, items: [{ type: 'audio', label: 'Audio', quality: 'mp3', url: r.url }] };
}

// nexray ytplay (search phrase -> audio): { result: { title, channel, id, duration "2:23", seconds, thumbnail, url, download_url } }
// wantId makes sure we got the video that was picked, not a different search hit.
async function nexrayPlay(q, wantId, thumb) {
    const data = await getJson(`${NEXRAY}/downloader/ytplay`, { q }, { timeout: 45000, retries: 0 });
    const r = unwrap(data, 'nexray/ytplay');
    if (!r.download_url) throw new Error('nexray/ytplay: no download_url');
    if (wantId && r.id && r.id !== wantId) throw new Error('nexray/ytplay: returned a different video');
    return {
        platform: 'YouTube', title: r.title || null, author: r.channel || null, duration: r.seconds || null,
        thumbnail: r.thumbnail || thumb, videoId: r.id || null, url: r.url || null,
        items: [{ type: 'audio', label: 'Audio', quality: 'mp3', url: r.download_url }],
    };
}

// nexray facebook: { result: { title, duration "20 s", data: [{ type, url, thumbnail }], audio: { url }, author: { fullname } } }
async function nexrayFacebook(url) {
    const data = await getJson(`${NEXRAY}/downloader/facebook`, { url }, { timeout: 30000, retries: 0 });
    const r = unwrap(data, 'nexray/facebook');
    const items = [];
    for (const x of Array.isArray(r.data) ? r.data : []) {
        if (!x?.url) continue;
        const type = /image|photo/i.test(x.type || '') ? 'image' : 'video';
        items.push({ type, label: type === 'video' ? 'HD' : 'Image', quality: x.quality || 'HD', url: x.url, direct: true });
    }
    if (!items.length) throw new Error('nexray/facebook: no media');
    if (r.audio?.url) items.push({ type: 'audio', label: 'Audio', quality: 'mp3', url: r.audio.url });
    const secs = parseInt(String(r.duration || '').replace(/\D/g, ''), 10);
    const first = (Array.isArray(r.data) ? r.data : []).find((x) => x?.thumbnail);
    return {
        platform: 'Facebook',
        title: r.title && r.title !== 'Facebook Video' ? r.title : null,
        author: r.author?.fullname || r.author?.username || null,
        duration: secs || null,
        thumbnail: first?.thumbnail || null,
        items,
    };
}

// azbry: { result: { title, thumbnail, duration, quality?, download, format } }
async function azbryYt(url, kind, thumb) {
    const data = await getJson(`${AZBRY}/api/download/${kind}`, { url }, { timeout: 60000, retries: 0 });
    const r = unwrap(data, 'azbry');
    if (!r.download) throw new Error(`azbry/${kind}: no download`);
    const audio = kind === 'ytmp3';
    return {
        platform: 'YouTube', title: r.title || null, author: r.channel && r.channel !== 'Unknown' ? r.channel : (r.author && r.author !== 'Unknown' ? r.author : null),
        duration: r.duration || null, thumbnail: r.thumbnail || thumb,
        items: [{ type: audio ? 'audio' : 'video', label: audio ? 'Audio' : String(r.quality || 'Video'), quality: r.quality || r.format, url: r.download }],
    };
}

async function azbryBoth(url, thumb) {
    const [a, v] = await Promise.allSettled([azbryYt(url, 'ytmp3', thumb), azbryYt(url, 'ytmp4', thumb)]);
    const items = [...(a.status === 'fulfilled' ? a.value.items : []), ...(v.status === 'fulfilled' ? v.value.items : [])];
    if (!items.length) throw new Error((a.reason || v.reason)?.message || 'azbry: no media');
    return { ...(v.status === 'fulfilled' ? v.value : a.value), items };
}

// faa: { result: { download_url, format, searched_title, searched_url } }  (video, takes a search phrase or link)
async function faaVideo(url, thumb) {
    const data = await getJson(`${FAA}/faa/ytplayvid`, { q: url }, { timeout: 60000, retries: 0 });
    const r = unwrap(data, 'faa');
    if (!r.download_url) throw new Error('faa: no download_url');
    return { platform: 'YouTube', title: r.searched_title || null, author: null, duration: null, thumbnail: thumb, items: [{ type: 'video', label: 'Video', quality: r.format || 'mp4', url: r.download_url }] };
}

// azbry ytplay (primary for .play): { result: { title, channel, thumbnail, duration, videoId, url, download, format } }
// q can be a search phrase or a title; wantId makes sure we got the video the user picked.
async function azbryPlay(q, wantId) {
    const data = await getJson(`${AZBRY}/api/download/ytplay`, { q }, { timeout: 60000, retries: 0 });
    const r = unwrap(data, 'azbry/ytplay');
    if (!r.download) throw new Error('azbry/ytplay: no download');
    if (wantId && r.videoId && r.videoId !== wantId) throw new Error('azbry/ytplay: returned a different video');
    return {
        platform: 'YouTube', title: r.title || null, author: r.channel || null, duration: r.duration || null,
        thumbnail: r.thumbnail || null, videoId: r.videoId || null, url: r.url || null,
        items: [{ type: 'audio', label: 'Audio', quality: r.format || 'mp3', url: r.download }],
    };
}

// faa ytmp4 (primary for .video): { result: { download_url, format } }
async function faaYtmp4(url, thumb) {
    const data = await getJson(`${FAA}/faa/ytmp4`, { url }, { timeout: 90000, retries: 0 });
    const r = unwrap(data, 'faa/ytmp4');
    if (!r.download_url) throw new Error('faa/ytmp4: no download_url');
    return { platform: 'YouTube', title: null, author: null, duration: null, thumbnail: thumb, items: [{ type: 'video', label: 'Video', quality: r.format || 'mp4', url: r.download_url }] };
}

// Run several lookups at once and resolve with the first one that succeeds.
function firstOf(fns) {
    return new Promise((resolve, reject) => {
        let left = fns.length, lastErr = null;
        for (const fn of fns) {
            Promise.resolve().then(fn).then(resolve, (e) => { lastErr = e; if (--left === 0) reject(lastErr); });
        }
    });
}

// Ordered providers for one YouTube download. The first is the one we want; the rest are fallbacks that the
// caller tries one by one when a file turns out to be empty / broken (see deliverChain in newcmds).
//   mode: 'audio' | 'video'      opts: { query, videoId }
function youtubeCandidates(url, mode, { query, videoId } = {}) {
    const id = videoId || (String(url).match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([\w-]{11})/) || [])[1] || null;
    const thumb = id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null;
    const pick = (info, type) => ({ ...info, items: info.items.filter((i) => i.type === type) });
    const only = (name, type, fn) => ({ name, run: async () => { const info = pick(await fn(), type); if (!info.items.length) throw new Error(`${name}: no ${type}`); return info; } });
    if (mode === 'audio') {
        return [
            // nexray answers in well under a second: ytplay (by title) and ytmp3 (by link) race, first answer wins
            { name: 'nexray/fast', run: () => firstOf([
                ...(query ? [() => nexrayPlay(query, id, thumb)] : []),
                () => nexrayYtmp3(url, thumb),
            ]) },
            { name: 'azbry/ytplay', run: () => azbryPlay(query || url, id) },
            only('azbry/ytmp3', 'audio', () => azbryYt(url, 'ytmp3', thumb)),
            only('kyio/ytdl', 'audio', () => youtubeYtdl(url)),
            only('kyio/yt-fast', 'audio', () => youtubeFast(url)),
        ];
    }
    return [
        { name: 'faa/ytmp4', run: () => faaYtmp4(url, thumb) },
        only('azbry/ytmp4', 'video', () => azbryYt(url, 'ytmp4', thumb)),
        only('kyio/ytdl', 'video', () => youtubeYtdl(url)),
        only('kyio/yt-fast', 'video', () => youtubeFast(url)),
        only('faa/ytplayvid', 'video', () => faaVideo(url, thumb)),
    ];
}

async function youtubeYtdl(url) {
    const data = await getJson(`${KYIO}/api/v2/ytdl`, { q: url }, { timeout: 60000, retries: 0 });
    const r = unwrap(data, 'ytdl');
    const items = (Array.isArray(r.media) ? r.media : [])
        .filter((m) => m?.url)
        .map((m) => ({
            type: m.type === 'audio' ? 'audio' : 'video',
            label: m.type === 'audio' ? 'Audio' : (m.quality ? String(m.quality) : 'Video'),
            quality: m.quality || m.extension,
            url: m.url,
        }));
    ensureItems(items, r, 'No downloadable media found for that video').forEach((i) => { if (!items.includes(i)) items.push(i); });
    const idMatch = url.match(/(?:v=|youtu\.be\/|shorts\/)([\w-]{11})/);
    return {
        platform: 'YouTube',
        title: r.title || null,
        author: r.author || null,
        duration: r.duration || null,
        thumbnail: r.thumbnail || (idMatch ? `https://i.ytimg.com/vi/${idMatch[1]}/hqdefault.jpg` : null),
        items,
    };
}

async function youtubeFast(url) {
    const data = await getJson(`${KYIO}/api/v2/downloader/yt-fast`, { url, type: 'all' }, { timeout: 60000, retries: 0 });
    const r = unwrap(data, 'yt-fast');
    const items = [];
    const media = Array.isArray(r.media) ? r.media : [];
    media.forEach((m) => {
        if (!m?.url) return;
        items.push({ type: m.type === 'audio' ? 'audio' : 'video', label: `${m.type === 'audio' ? 'Audio' : 'Video'} ${m.quality || ''}`.trim(), quality: m.quality, url: m.url });
    });
    if (!items.some((i) => i.type === 'video') && r.video) items.push({ type: 'video', label: 'Video', url: r.video });
    if (!items.some((i) => i.type === 'audio') && r.audio) items.push({ type: 'audio', label: 'Audio', url: r.audio });
    ensureItems(items, r, 'No downloadable media found for that video').forEach((i) => { if (!items.includes(i)) items.push(i); });

    const idMatch = url.match(/(?:v=|youtu\.be\/|shorts\/)([\w-]{11})/);
    return {
        platform: 'YouTube',
        title: r.title || null,
        author: r.author || null,
        duration: r.duration || null,
        thumbnail: idMatch ? `https://i.ytimg.com/vi/${idMatch[1]}/hqdefault.jpg` : null,
        items,
    };
}

// X / Twitter.
async function twitterV2(url) {
    const data = await getJson(`${KYIO}/api/v2/twitter-v2`, { q: url }, { timeout: 30000, retries: 0 });
    const outer = unwrap(data, 'twitter');
    const r = outer.result || outer;
    const items = [];
    (r.media || []).forEach((m) => {
        if (m?.url) items.push({ type: 'video', label: m.quality || 'Video', quality: m.quality, url: m.url });
    });
    (r.images || []).forEach((img, i) => {
        const u = typeof img === 'string' ? img : img?.url;
        if (u) items.push({ type: 'image', label: `Image ${i + 1}`, url: u });
    });
    ensureItems(items, r, 'No media found in that post').forEach((i) => { if (!items.includes(i)) items.push(i); });
    return {
        platform: 'X (Twitter)',
        title: r.title || null,
        author: null,
        duration: r.duration ? Math.round(r.duration) : null,
        thumbnail: r.thumbnail || null,
        items,
    };
}

// Facebook. Prefers direct (render:true) links; the snapcdn ones are redirect wrappers.
async function facebookV3(url) {
    const data = await getJson(`${KYIO}/api/v2/downloader/fb-v3`, { q: url }, { timeout: 30000, retries: 0 });
    const r = unwrap(data, 'facebook');
    const list = Array.isArray(r.results) ? r.results : [];
    const items = list
        .filter((x) => x?.url && (x.type || 'video') === 'video')
        .map((x) => ({ type: 'video', label: x.quality, quality: x.quality, url: x.url, direct: !!x.render }));
    ensureItems(items, r, 'No downloadable video found for that link').forEach((i) => { if (!items.includes(i)) items.push(i); });
    // direct links first, then by quality (highest first)
    const num = (q) => parseInt(String(q).replace(/\D/g, ''), 10) || 0;
    items.sort((a, b) => (b.direct - a.direct) || (num(b.quality) - num(a.quality)));
    return {
        platform: 'Facebook',
        title: r.title && r.title !== 'Facebook Video' ? r.title : null,
        author: null,
        duration: r.duration || null,
        thumbnail: r.thumbnail || null,
        items,
    };
}

// X / Twitter: twitter-v2 first, the all-in-one endpoints as fallback.
const twitter = (url) => hedged([
    { name: 'kyio/twitter-v2', run: () => twitterV2(url) },
    { name: 'kyio/aio-v2', run: () => allDownloadFrom(AIO_ENDPOINTS.v2, url) },
    { name: 'kyio/aiodl', run: () => allDownloadFrom(AIO_ENDPOINTS.v1, url) },
    ...(useExtras() ? extraAio(url, 'twitter') : []),
]);

// Facebook: fb-v3 first, the all-in-one endpoints as fallback.
const facebook = (url) => hedged([
    { name: 'nexray/facebook', run: () => nexrayFacebook(url) },
    { name: 'kyio/fb-v3', run: () => facebookV3(url) },
    { name: 'kyio/aio-v2', run: () => allDownloadFrom(AIO_ENDPOINTS.v2, url) },
    { name: 'kyio/aiodl', run: () => allDownloadFrom(AIO_ENDPOINTS.v1, url) },
    ...(useExtras() ? extraAio(url, 'facebook') : []),
]);

// Route any supported link to the right provider.
async function downloadAny(url) {
    switch (detectPlatform(url)) {
        case 'youtube': return youtube(url);
        case 'twitter': return twitter(url);
        case 'facebook': return facebook(url);
        default: return allDownload(url); // tiktok, instagram, everything else
    }
}

// ---------------------------------------------------------------- lyrics

// faa (primary): { result: { title, artist, album, cover:{...}, lyrics: "[00:15.15] line\n..." , share_url } }
async function lyricsFaa(query) {
    const data = await getJson(`${FAA}/faa/lyrics`, { q: query }, { timeout: 30000, retries: 1 });
    const r = unwrap(data, 'faa/lyrics');
    // synced lyrics carry [mm:ss.xx] stamps - strip them for reading / copying
    const text = String(r.lyrics || '').replace(/^\s*\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\]\s?/gm, '').replace(/\n{3,}/g, '\n\n').trim();
    if (!text) throw new Error('No lyrics found for that song');
    const cover = r.cover?.hd || r.cover?.large || r.cover?.medium || r.cover?.small || null;
    return { title: r.title || query, artist: r.artist || null, album: r.album || null, url: r.share_url || null, cover, lyrics: text };
}
async function lyricsOmega(query) {
    const data = await getJson(`${OMEGA}/api/tools/lyrics`, { query });
    if (!data?.success || !data.found) throw new Error('No lyrics found for that song');
    return { title: data.title, artist: data.artist, url: data.url, lyrics: data.lyrics };
}
async function lyrics(query) {
    return hedged([
        { name: 'faa/lyrics', run: () => lyricsFaa(query) },
        { name: 'omega/lyrics', run: () => lyricsOmega(query) },
    ], 6000);
}

// ---------------------------------------------------------------- AI chat

// Each named model gets its own persistent conversation (sessionId) per user.
// `model` is sent to the API as an extra parameter; if the provider ignores it the
// command still works as a plain chat with its own memory.
const AI_MODELS = {
    ai:      { label: 'AI Chat', model: null },
    gpt:     { label: 'GPT',     model: 'gpt' },
    gemini:  { label: 'Gemini',  model: 'gemini' },
    claude:  { label: 'Claude',  model: 'claude' },
    llama:   { label: 'Llama',   model: 'llama' },
    deepseek:{ label: 'DeepSeek',model: 'deepseek' },
    search:  { label: 'AI Search', model: null, needSearch: true },
};

async function chat({ message, userId = 'anon', modelKey = 'ai', needSearch }) {
    const def = AI_MODELS[modelKey] || AI_MODELS.ai;
    const params = {
        action: 'chat',
        message,
        sessionId: `${modelKey}-${String(userId).replace(/[^0-9a-z]/gi, '')}`,
        needSearch: String(needSearch ?? def.needSearch ?? false),
    };
    if (def.model) params.model = def.model;
    const data = await getJson(`${OMEGA}/api/ai/Chatbot`, params, { timeout: 60000 });
    if (!data?.success || !data.reply) throw new Error(data?.message || 'The AI did not return a reply');
    return String(data.reply);
}

module.exports = {
    getJson, fetchBuffer, downloadToFile, hedged, resetStats: () => stats.clear(), providerStats: () => Object.fromEntries(stats), extractUrl, detectPlatform,
    allDownload, youtube, twitter, facebook, downloadAny,
    lyrics, youtubeYtdl, youtubeCandidates, azbryPlay, faaYtmp4, chat, AI_MODELS,
};
