'use strict';
// SUBZERO MD MINI - audio stickers (a sticker that plays a sound when tapped) + self-destructing text.
//
//   .saudio  (aliases .audiosticker .stickeraudio .asticker)
//     reply VIDEO              -> one step: the video's own picture + sound become an audio sticker
//     reply IMAGE / STICKER    -> step 1: saved as the picture (5 minutes)       [video: .saudio visual]
//     reply AUDIO / VOICE NOTE -> step 2: picture (saved one, else the default image) + this sound
//     reply VIDEO after step 1 -> the sound is taken from that video
//     .saudio 3-9              -> use seconds 3 to 9 of the sound (max 30 s)
//     .saudio cancel           -> forget the saved picture
//     .saudio video            -> (step 2 with an audio) send a normal looping video instead
//     .saudio <audio url>      -> step 2 with a link to an audio file instead of a reply
//   The picture can also be the command's own media: send an image/video with the caption .saudio while
//   replying to an audio.
//
//   .selfdestruct [seconds] <text> (aliases .burn .vanish): a text that vanishes N seconds after it is read.
//
// Message format (WhatsApp, Nov 2026): Message.audioStickerMessage = field 134, a FutureProofMessage that wraps a
// stickerMessage which carries an audioMessage (field 26). Baileys' proto does not know field 134, so it is
// encoded by hand and appended by a permanent, idempotent patch of proto.Message.encode.
// Sizes tested by the reference author on a phone: an animated sticker of ~870-910 KB moves, 1.2 MB+ stays still.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const config = require('../config');
const perf = require('./perf');

const SESSION_MS = 5 * 60 * 1000;
const MAX_VISUAL = 15 * 1024 * 1024;
const MAX_AUDIO = 16 * 1024 * 1024;
const AUDIO_SEC = 30;
const WEBP_MAX = 900 * 1024;
const WEBP_FIT_MAX = 960 * 1024;
const MAX_SEC = 300;
const ENC_TIMEOUT = 120000;
const TMP = path.join(os.tmpdir(), 'subzero-saudio');
const NOLOG = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return NOLOG; }, level: 'silent' };

const sessions = new Map(); // chat|sender -> { kind, buf, ext, exp }
const friendly = (msg) => Object.assign(new Error(msg), { friendly: true });
const baileys = () => require('baileys');

// ------------------------------------------------------------------ ffmpeg

let FF = null;
function ffmpegBin() {
    if (FF !== null) return FF;
    const cand = [];
    if (process.env.FFMPEG_PATH) cand.push(process.env.FFMPEG_PATH);
    try { cand.push(require('@ffmpeg-installer/ffmpeg').path); } catch { /* optional */ }
    cand.push('ffmpeg');
    for (const c of cand) {
        try {
            if (c.includes('/')) { try { fs.chmodSync(c, 0o755); } catch { /* ignore */ } }
            const r = spawnSync(c, ['-version'], { encoding: 'utf8', timeout: 10000 });
            if (r.status === 0 && /ffmpeg version/i.test(r.stdout || '')) return (FF = c);
        } catch { /* next */ }
    }
    return (FF = '');
}

function runFfmpegNow(args) {
    return new Promise((resolve, reject) => {
        const p = spawn(ffmpegBin(), args, { stdio: ['ignore', 'ignore', 'pipe'] });
        let err = '';
        p.stderr.on('data', (d) => { err = (err + d).slice(-3000); });
        const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('ffmpeg took longer than 2 minutes')); }, ENC_TIMEOUT);
        p.on('error', (e) => { clearTimeout(t); reject(e); });
        p.on('close', (code) => {
            clearTimeout(t);
            if (code === 0) return resolve();
            reject(new Error('ffmpeg failed: ' + err.split('\n').filter(Boolean).slice(-2).join(' | ').slice(0, 300)));
        });
    });
}
// a few ffmpeg jobs at a time, however many bots are busy
const runFfmpeg = (args) => perf.heavy().run(() => runFfmpegNow(args));

async function withTmp(files, makeArgs, outExt) {
    fs.mkdirSync(TMP, { recursive: true });
    const id = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    const paths = files.map((f, i) => path.join(TMP, `sa-${id}-i${i}.${f.ext}`));
    const out = path.join(TMP, `sa-${id}-o.${outExt}`);
    try {
        files.forEach((f, i) => fs.writeFileSync(paths[i], f.buf));
        await runFfmpeg(makeArgs(paths, out));
        return fs.readFileSync(out);
    } finally {
        for (const f of [...paths, out]) { try { fs.unlinkSync(f); } catch { /* ignore */ } }
    }
}

// duration + which tracks exist, read from `ffmpeg -i`
function probeMedia(buf, ext) {
    fs.mkdirSync(TMP, { recursive: true });
    const f = path.join(TMP, `sa-probe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`);
    try {
        fs.writeFileSync(f, buf);
        const r = spawnSync(ffmpegBin(), ['-hide_banner', '-i', f], { encoding: 'utf8', timeout: 20000 });
        const txt = String(r.stderr || '');
        const d = txt.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
        return {
            dur: d ? (+d[1]) * 3600 + (+d[2]) * 60 + parseFloat(d[3]) : null,
            hasAudio: /Stream #\d+:\d+[^\n]*: Audio:/.test(txt),
            hasVideo: /Stream #\d+:\d+[^\n]*: Video:/.test(txt)
        };
    } finally { try { fs.unlinkSync(f); } catch { /* ignore */ } }
}

// "3-9" -> start at 3 s, 6 s long (max 30). Without it: from the start, max 30 s.
function parseRange(args) {
    for (const a of args) {
        const m = /^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/.exec(String(a));
        if (m) {
            const ss = parseFloat(m[1]); const en = parseFloat(m[2]);
            if (!(en > ss)) return { error: 'Invalid range. Example: .saudio 3-9 (from second 3 to 9).' };
            return { ss, len: Math.min(AUDIO_SEC, en - ss) };
        }
    }
    return { ss: 0, len: AUDIO_SEC };
}

// ------------------------------------------------------------------ conversions

function toOpus(audioBuf, ext, opt = {}) {
    const t = Math.min(AUDIO_SEC, opt.t || AUDIO_SEC);
    return withTmp([{ buf: audioBuf, ext }], ([fa], fo) => [
        '-y', ...(opt.ss ? ['-ss', String(opt.ss)] : []), '-i', fa, '-vn', '-t', t.toFixed(2),
        '-c:a', 'libopus', '-b:a', '32k', '-ar', '48000', '-ac', '1', fo
    ], 'ogg');
}

const webpEnc = (fv, fo, { ss = 0, t, fps, q, px = 512 }) => [
    '-y', ...(ss ? ['-ss', String(ss)] : []), '-i', fv, '-t', t.toFixed(2), '-an',
    '-vf', `fps=${fps},scale=${px}:${px}:force_original_aspect_ratio=increase,crop=${px}:${px}`,
    '-c:v', 'libwebp', '-lossless', '0', '-q:v', String(q), '-compression_level', '4', '-loop', '0', fo
];

// video used as the PICTURE only (two-step mode): a short loop
async function videoToWebp(vis) {
    for (const t of [{ fps: 12, q: 40, t: 6 }, { fps: 10, q: 30, t: 5 }, { fps: 8, q: 20, t: 4 }]) {
        const buf = await withTmp([{ buf: vis.buf, ext: vis.ext }], ([fv], fo) => webpEnc(fv, fo, t), 'webp');
        if (buf.length <= WEBP_MAX) return { buf, animated: true };
    }
    throw friendly('That video is too heavy for a sticker. Try a shorter one.');
}

// video whose SOUND is used too (one-step mode): keep the picture as long as possible so motion matches the sound
async function videoToWebpFit(vis, ss, sec) {
    const enc = (t, fps, q, px = 512) => withTmp([{ buf: vis.buf, ext: vis.ext }], ([fv], fo) => webpEnc(fv, fo, { ss, t, fps, q, px }), 'webp');
    for (const [fps, q, px] of [[10, 35, 512], [8, 25, 512], [10, 25, 320], [8, 25, 320], [8, 20, 320], [7, 20, 320], [5, 15, 512]]) {
        const buf = await enc(sec, fps, q, px);
        if (buf.length <= WEBP_FIT_MAX) return { buf, animated: true, sec, looped: false };
    }
    for (const [t, fps, q] of [[6, 10, 35], [5, 8, 25], [4, 8, 20], [3, 6, 15]]) { // picture loops, sound stays whole
        const buf = await enc(Math.min(t, sec), fps, q);
        if (buf.length <= WEBP_MAX) return { buf, animated: true, sec, looped: true };
    }
    throw friendly('That video is too heavy for a sticker. Try another one or a shorter part.');
}

const isWebp = (b) => b.length > 30 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP';
const webpAnimated = (b) => isWebp(b) && b.toString('latin1', 12, 16) === 'VP8X' && (b[20] & 2) !== 0;

async function toWebp(vis) {
    if (vis.kind === 'video') return videoToWebp(vis);
    if (vis.kind === 'sticker' && isWebp(vis.buf)) { // already a sticker: keep it (and its animation)
        if (vis.buf.length > 1024 * 1024) throw friendly('That sticker is too big (max 1 MB).');
        return { buf: vis.buf, animated: webpAnimated(vis.buf) };
    }
    try {
        const buf = await withTmp([{ buf: vis.buf, ext: vis.ext }], ([fi], fo) => [
            '-y', '-i', fi, '-frames:v', '1',
            '-vf', 'scale=512:512:force_original_aspect_ratio=increase,crop=512:512',
            '-c:v', 'libwebp', '-lossless', '0', '-q:v', '80', fo
        ], 'webp');
        return { buf, animated: false };
    } catch (e) {
        try { // fall back to sharp when this ffmpeg has no webp encoder
            const sharp = require('sharp');
            return { buf: await sharp(vis.buf).resize(512, 512, { fit: 'cover' }).webp({ quality: 80 }).toBuffer(), animated: false };
        } catch { throw e; }
    }
}

// normal looping video (fallback `.saudio video`)
function combineVideo(vis, audioBuf, audioExt) {
    const isVid = vis.kind === 'video';
    return withTmp([{ buf: vis.buf, ext: vis.ext }, { buf: audioBuf, ext: audioExt }], ([fv, fa], fo) => [
        ...(isVid ? ['-y', '-stream_loop', '-1', '-i', fv] : ['-y', '-loop', '1', '-framerate', '10', '-i', fv]), '-i', fa,
        '-map', '0:v:0', '-map', '1:a:0', ...(isVid ? [] : ['-tune', 'stillimage']),
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-vf', "scale='trunc(min(720,iw)/2)*2':-2,format=yuv420p",
        '-c:a', 'aac', '-b:a', '96k', '-t', String(MAX_SEC), '-shortest', '-movflags', '+faststart', fo
    ], 'mp4');
}

// ------------------------------------------------------------------ protobuf (field 134)

const varint = (n) => { const o = []; while (n > 127) { o.push((n % 128) | 128); n = Math.floor(n / 128); } o.push(n); return Buffer.from(o); };
const ld = (field, body) => Buffer.concat([varint(field * 8 + 2), varint(body.length), body]);

// FutureProofMessage{ message = Message{ stickerMessage = StickerMessage{ ...sticker, audioMessage = AudioMessage } } }
function buildFutureProof(stickerBytes, audioBytes) {
    const sticker = Buffer.concat([Buffer.from(stickerBytes), ld(26, Buffer.from(audioBytes))]); // StickerMessage.audioMessage = 26
    return ld(1, ld(26, sticker));                                                                   // Message.stickerMessage = 26
}

function patchProto(proto) {
    if (proto.Message.encode.__saudio) return;
    const orig = proto.Message.encode;
    const wrapped = function encode(message, writer) {
        const w = orig.call(this, message, writer);
        if (message && message.__audioSticker) w.uint32(1074).bytes(message.__audioSticker); // (134 << 3) | 2
        return w;
    };
    wrapped.__saudio = true;
    proto.Message.encode = wrapped;
}

// web = { buf, animated } (WebP), ogg = Buffer (OGG Opus)
async function relayAudioSticker(sock, chat, web, ogg) {
    const b = baileys();
    patchProto(b.proto);
    const opts = { upload: sock.waUploadToServer, logger: NOLOG };
    // seconds given up front: Baileys then skips its own duration probe (which needs the optional music-metadata package)
    let seconds; try { const pr = probeMedia(ogg, 'ogg'); if (pr.dur) seconds = Math.max(1, Math.round(pr.dur)); } catch { /* optional */ }
    const stage = async (name, fn) => { try { return await fn(); } catch (e) { e.message = `[${name}] ${e.message}`; throw e; } };
    const st = await stage('sticker upload', () => b.prepareWAMessageMedia({ sticker: web.buf, mimetype: 'image/webp', width: 512, height: 512, isAnimated: web.animated }, opts));
    const au = await stage('audio upload', () => b.prepareWAMessageMedia({ audio: ogg, mimetype: 'audio/ogg; codecs=opus', ptt: false, ...(seconds ? { seconds } : {}) }, opts));

    const audioBytes = b.proto.Message.AudioMessage.encode(au.audioMessage).finish();
    const stickerBytes = b.proto.Message.StickerMessage.encode(st.stickerMessage).finish();
    const gen = b.generateMessageIDV2 || b.generateMessageID;
    const id = gen(sock.user && sock.user.id);
    await stage('send', () => sock.relayMessage(chat, { __audioSticker: buildFutureProof(stickerBytes, audioBytes) }, { messageId: id }));
    return { animated: web.animated, stickerBytes: web.buf.length, audioBytes: ogg.length };
}

async function sendWithVisual(sock, chat, vis, audioBuf, audioExt, opt) {
    const ogg = await toOpus(audioBuf, audioExt, opt);
    return relayAudioSticker(sock, chat, await toWebp(vis), ogg);
}

async function sendOwnSound(sock, chat, vis, range) {
    const pr = probeMedia(vis.buf, vis.ext);
    if (!pr.hasAudio) throw friendly('That video has no sound. Use ".saudio visual" to use it as the picture and take the sound from a voice note.');
    const avail = pr.dur != null ? pr.dur - range.ss : AUDIO_SEC;
    if (!(avail > 0.5)) throw friendly(`The start is past the end of the video (about ${Math.floor(pr.dur || 0)} s long).`);
    const web = await videoToWebpFit(vis, range.ss, Math.min(AUDIO_SEC, range.len, avail));
    const ogg = await toOpus(vis.buf, vis.ext, { ss: range.ss, t: web.sec });
    return { ...(await relayAudioSticker(sock, chat, web, ogg)), sec: web.sec, looped: web.looped };
}

// ------------------------------------------------------------------ WhatsApp media helpers

function unwrapMsg(message) {
    let m = message;
    for (let i = 0; i < 6 && m; i++) {
        const k = ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension', 'documentWithCaptionMessage'].find((w) => m[w]?.message);
        if (!k) break;
        m = m[k].message;
    }
    return m;
}
function mediaInfo(message) {
    const m = unwrapMsg(message);
    if (!m) return null;
    for (const [type, field] of [['image', 'imageMessage'], ['video', 'videoMessage'], ['audio', 'audioMessage'], ['sticker', 'stickerMessage']]) {
        if (m[field]) return { type, media: m[field], cur: m };
    }
    return null;
}
const sizeOf = (media) => {
    const fl = media && media.fileLength;
    if (fl == null) return 0;
    return typeof fl === 'object' ? (typeof fl.toNumber === 'function' ? fl.toNumber() : Number(fl.low) || 0) : Number(fl) || 0;
};

async function download(socket, key, info) {
    const { downloadMediaMessage, downloadContentFromMessage } = baileys();
    try {
        return await downloadMediaMessage({ key, message: info.cur }, 'buffer', {}, { logger: NOLOG, reuploadRequest: (m) => socket.updateMediaMessage(m) });
    } catch (e) {
        const stream = await downloadContentFromMessage(info.media, info.type);
        const chunks = [];
        for await (const c of stream) chunks.push(c);
        const buf = Buffer.concat(chunks);
        if (!buf.length) throw e;
        return buf;
    }
}

const extFor = (mime) => ({ 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/wav': 'wav', 'audio/webm': 'webm' })[String(mime || '').split(';')[0].trim().toLowerCase()] || 'ogg';

// default picture for "reply an audio with .saudio" when no picture was saved
let defaultVisual = null;
async function getDefaultVisual() {
    if (defaultVisual) return defaultVisual;
    const src = config.AUDIO_STICKER_IMAGE || config.MENU_IMAGE || config.RCD_IMAGE_PATH;
    if (!src) throw friendly('No picture saved. Reply to an image or sticker with .saudio first.');
    let buf;
    if (/^https?:\/\//i.test(src)) {
        const r = await fetch(src, { signal: AbortSignal.timeout(15000) });
        if (!r.ok) throw friendly('Could not load the default picture. Reply to an image or sticker with .saudio first.');
        buf = Buffer.from(await r.arrayBuffer());
    } else buf = fs.readFileSync(src);
    return (defaultVisual = { kind: 'image', buf, ext: 'jpg' });
}

// ------------------------------------------------------------------ commands

module.exports = function build(h) {
    const { box, say: sayText, withFooter, registry } = h;
    const sc = registry.smallcaps;
    const row = (k, v) => `▨ ${sc(k)} ⟜ ${v}`;
    const { quotedOf } = require('./vv');

    const HELP = (p) => box('AUDIO STICKER', [
        'A sticker that plays a sound when tapped.', '',
        `${p}saudio  reply a VIDEO`, '   one step: its picture + sound', '',
        'Two steps:', `1. ${p}saudio  reply an image / sticker`, `   (video as picture: ${p}saudio visual)`,
        `2. ${p}saudio  reply an audio / voice note`, '   (or a video: its sound is used)', '',
        'No picture saved? an audio alone uses the default image.', '',
        `${p}saudio 3-9    use seconds 3 to 9 (max 30)`, `${p}saudio cancel  forget the saved picture`,
        `${p}saudio video  step 2 as a normal video`
    ]);

    async function cmdSaudio(ctx) {
        const { socket, msg } = ctx;
        const chat = ctx.sender;
        const say = (t) => sayText(ctx, withFooter(t));
        const react = (e) => socket.sendMessage(chat, { react: { text: e, key: msg.key } }).catch(() => {});
        const who = msg.key.fromMe ? 'me' : (msg.key.participant || chat);
        const skey = `${chat}|${who}`;
        const sub = String(ctx.args[0] || '').toLowerCase();
        const visualOnly = sub === 'visual' || sub === 'v';
        const live = () => { const s = sessions.get(skey); if (s && s.exp > Date.now()) return s; sessions.delete(skey); return null; };
        const fail = async (tag, e) => {
            if (e && e.friendly) { await react('⚠️'); return say(box('AUDIO STICKER', [e.message])); }
            console.error(`[saudio] ${tag}:`, (e && (e.stack || e.message)) || e);
            await react('❌');
            return say(box('AUDIO STICKER FAILED', [String((e && e.message) || e).slice(0, 220)]));
        };

        if (['cancel', 'batal', 'reset', 'clear'].includes(sub)) { sessions.delete(skey); return say(box('AUDIO STICKER', ['Saved picture cleared.'])); }
        const range = parseRange(ctx.args);
        if (range.error) return say(box('AUDIO STICKER', [range.error]));

        // sources: the replied-to message, and the command message's own media
        const qctx = quotedOf(msg.message);
        const quotedInfo = qctx && qctx.quotedMessage ? mediaInfo(qctx.quotedMessage) : null;
        const ownInfo = mediaInfo(msg.message);
        const qkey = qctx ? { remoteJid: chat, id: qctx.stanzaId, ...(qctx.participant ? { participant: qctx.participant } : {}) } : null;
        const urlArg = ctx.args.find((a) => /^https?:\/\//i.test(a));

        if (!ffmpegBin()) return say(box('AUDIO STICKER', ['ffmpeg is not installed on this server.', 'Install it, set FFMPEG_PATH, or add the', '@ffmpeg-installer/ffmpeg package.']));

        // audio replied to + the command message carries its own picture (image / video caption)
        const audioInfo = (quotedInfo && quotedInfo.type === 'audio') ? quotedInfo : null;
        const visualInfo = audioInfo ? (ownInfo && ['image', 'video', 'sticker'].includes(ownInfo.type) ? ownInfo : null) : (quotedInfo || ownInfo);
        const visKey = audioInfo ? msg.key : (quotedInfo ? qkey : msg.key);

        const getVisual = async (info, key) => {
            if (sizeOf(info.media) > MAX_VISUAL) throw friendly('That picture is too big (max 15 MB).');
            const buf = await download(socket, key, info);
            return info.type === 'video' ? { kind: 'video', buf, ext: 'mp4' } : { kind: info.type, buf, ext: info.type === 'sticker' ? 'webp' : 'jpg' };
        };

        // ---- audio is the sound
        if (audioInfo || (urlArg && !visualInfo)) {
            if (audioInfo && sizeOf(audioInfo.media) > MAX_AUDIO) return say(box('AUDIO STICKER', ['That audio is too big (max 16 MB).']));
            await react('⏳');
            try {
                const vis = visualInfo ? await getVisual(visualInfo, visKey) : (live() || await getDefaultVisual());
                let audio, ext;
                if (audioInfo) { audio = await download(socket, qkey, audioInfo); ext = extFor(audioInfo.media.mimetype); }
                else {
                    const r = await fetch(urlArg, { signal: AbortSignal.timeout(30000) });
                    if (!r.ok) throw friendly('Could not download that audio link.');
                    audio = Buffer.from(await r.arrayBuffer()); ext = 'mp3';
                    if (audio.length > MAX_AUDIO) throw friendly('That audio is too big (max 16 MB).');
                }
                if (sub === 'video') {
                    const out = await combineVideo(vis, audio, ext);
                    await socket.sendMessage(chat, { video: out, mimetype: 'video/mp4', gifPlayback: true }, { quoted: msg });
                } else await sendWithVisual(socket, chat, vis, audio, ext, { ss: range.ss, t: range.len });
                sessions.delete(skey);
                return react('✅');
            } catch (e) { return fail('audio', e); }
        }

        if (!visualInfo) return say(HELP(ctx.prefix));

        // ---- video (not "visual"): sound source when a picture is saved, otherwise a one-step audio sticker
        if (visualInfo.type === 'video' && !visualOnly) {
            if (sizeOf(visualInfo.media) > MAX_VISUAL) return say(box('AUDIO STICKER', ['That video is too big (max 15 MB).']));
            const saved = live();
            await react('⏳');
            try {
                const buf = await download(socket, visKey, visualInfo);
                if (saved) {
                    const pr = probeMedia(buf, 'mp4');
                    if (!pr.hasAudio) throw friendly('That video has no sound. Your saved picture is still kept; try an audio or another video.');
                    if (pr.dur != null && range.ss >= pr.dur - 0.5) throw friendly(`The start is past the end of the video (about ${Math.floor(pr.dur)} s long).`);
                    await sendWithVisual(socket, chat, saved, buf, 'mp4', { ss: range.ss, t: range.len });
                    sessions.delete(skey);
                } else await sendOwnSound(socket, chat, { kind: 'video', buf, ext: 'mp4' }, range);
                return react('✅');
            } catch (e) { return fail('video', e); }
        }

        // ---- step 1: remember the picture
        await react('⏳');
        try {
            const vis = await getVisual(visualInfo, visKey);
            vis.exp = Date.now() + SESSION_MS;
            sessions.set(skey, vis);
            while (sessions.size > 300) sessions.delete(sessions.keys().next().value);
            await react('✅');
            return say(box('AUDIO STICKER', ['Picture saved (5 minutes).', '', `Now reply to an audio / voice note`, `(or a video) with ${ctx.prefix}saudio`]));
        } catch (e) { return fail('save', e); }
    }

    // text that disappears N seconds after it is read
    async function cmdSelfDestruct(ctx) {
        let secs = 5; const args = [...ctx.args];
        if (/^\d+$/.test(args[0] || '')) secs = Math.min(86400, Math.max(1, parseInt(args.shift(), 10)));
        const text = args.join(' ').trim() || ctx.msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.conversation;
        if (!text) return sayText(ctx, withFooter(box('SELF-DESTRUCT TEXT', [`${ctx.prefix}selfdestruct [seconds] <text>`, `Example: ${ctx.prefix}selfdestruct 10 see you at 5`, '', 'The text vanishes that many seconds', 'after it is read (default 5).'])));
        try {
        await ctx.socket.relayMessage(ctx.sender, {
            extendedTextMessage: {
                text, previewType: 0,
                contextInfo: { expiration: 0, ephemeralSettingTimestamp: Date.now(), disappearingMode: { initiator: 0, trigger: 1 }, afterReadDuration: secs },
                inviteLinkGroupTypeV2: 0
            }
        }, {});
        } catch (e) {
            return sayText(ctx, withFooter(box('SELF-DESTRUCT FAILED', [String((e && e.message) || e).slice(0, 200)])));
        }
    }

    return { routes: [[['saudio', 'audiosticker', 'stickeraudio', 'asticker'], cmdSaudio], [['selfdestruct', 'burn', 'vanish'], cmdSelfDestruct]] };
};
Object.assign(module.exports, { buildFutureProof, patchProto, parseRange, probeMedia, toWebp, toOpus, videoToWebpFit, ffmpegBin, mediaInfo, varint, ld, _sessions: sessions });
