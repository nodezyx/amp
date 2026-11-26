'use strict';
// Makes sure an audio file is something WhatsApp can actually PLAY.
// Providers often answer with a generic content-type, so the old code called every file "mp3" even when it was
// a webm / ogg-vorbis / fragmented mp4. Those arrive as a grey, unplayable bubble. We look at the real bytes
// (magic numbers), and when needed convert with ffmpeg (if it is installed on the host).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

let ffmpegOk = null;
function hasFfmpeg() {
    if (ffmpegOk !== null) return ffmpegOk;
    try { ffmpegOk = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore', timeout: 8000 }).status === 0; } catch { ffmpegOk = false; }
    return ffmpegOk;
}

// -> { kind: 'mp3'|'m4a'|'opus'|'ogg'|'webm'|'wav'|'flac'|'unknown', mime, ext, playable }
function sniff(buf) {
    const b = Buffer.from(buf);
    const at = (i) => b[i];
    if (b.length >= 3 && b.toString('latin1', 0, 3) === 'ID3') return { kind: 'mp3', mime: 'audio/mpeg', ext: 'mp3', playable: true };
    if (b.length >= 2 && at(0) === 0xff && (at(1) & 0xe0) === 0xe0) {
        // ADTS AAC also starts 0xFFF1/0xFFF9 (layer bits 00); real mp3 frames have a non-zero layer
        if ((at(1) & 0x06) === 0) return { kind: 'aac', mime: 'audio/aac', ext: 'aac', playable: false };
        return { kind: 'mp3', mime: 'audio/mpeg', ext: 'mp3', playable: true };
    }
    if (b.length >= 12 && b.toString('latin1', 4, 8) === 'ftyp') return { kind: 'm4a', mime: 'audio/mp4', ext: 'm4a', playable: true };
    if (b.length >= 4 && b.toString('latin1', 0, 4) === 'OggS') {
        const opus = b.toString('latin1', 0, Math.min(b.length, 128)).includes('OpusHead');
        return opus ? { kind: 'opus', mime: 'audio/ogg; codecs=opus', ext: 'ogg', playable: true } : { kind: 'ogg', mime: 'audio/ogg', ext: 'ogg', playable: false };
    }
    if (b.length >= 4 && at(0) === 0x1a && at(1) === 0x45 && at(2) === 0xdf && at(3) === 0xa3) return { kind: 'webm', mime: 'audio/webm', ext: 'webm', playable: false };
    if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WAVE') return { kind: 'wav', mime: 'audio/wav', ext: 'wav', playable: false };
    if (b.length >= 4 && b.toString('latin1', 0, 4) === 'fLaC') return { kind: 'flac', mime: 'audio/flac', ext: 'flac', playable: false };
    return { kind: 'unknown', mime: 'application/octet-stream', ext: 'bin', playable: false };
}

async function head(file, n = 4096) {
    const fd = await fs.promises.open(file, 'r');
    try { const buf = Buffer.alloc(n); const { bytesRead } = await fd.read(buf, 0, n, 0); return buf.subarray(0, bytesRead); } finally { await fd.close(); }
}

function ffmpeg(args, timeoutMs) {
    // at most a few ffmpeg processes at once, however many bots are converting
    return require('./perf').heavy().run(() => ffmpegNow(args, timeoutMs));
}
function ffmpegNow(args, timeoutMs) {
    return new Promise((resolve, reject) => {
        const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
        let err = '';
        p.stderr.on('data', (d) => { err += d; if (err.length > 2000) err = err.slice(-2000); });
        const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('ffmpeg timed out')); }, timeoutMs);
        p.on('error', (e) => { clearTimeout(t); reject(e); });
        p.on('close', (code) => { clearTimeout(t); code === 0 ? resolve() : reject(new Error(`ffmpeg failed: ${err.trim().split('\n').pop() || code}`)); });
    });
}

const tmpName = (ext) => path.join(os.tmpdir(), `szm-fix-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${ext}`);

// file: { path, size, mime, cleanup }  ->  { file, ext, mime, converted, asDocument }
// asDocument is true when the file cannot be played inline and could not be converted (no ffmpeg): it is then
// sent as a file so the person can still open it in a player.
async function prepare(file) {
    const info = sniff(await head(file.path));
    if (info.kind === 'mp3' || info.kind === 'opus') return { file, ext: info.ext, mime: info.mime, converted: false, asDocument: false };

    if (hasFfmpeg()) {
        // fragmented / odd mp4: a quick remux fixes it without re-encoding; everything else becomes mp3
        const attempts = info.kind === 'm4a'
            ? [{ ext: 'm4a', mime: 'audio/mp4', args: ['-c:a', 'copy', '-movflags', '+faststart'] }, { ext: 'mp3', mime: 'audio/mpeg', args: ['-c:a', 'libmp3lame', '-b:a', '128k'] }]
            : [{ ext: 'mp3', mime: 'audio/mpeg', args: ['-c:a', 'libmp3lame', '-b:a', '128k'] }, { ext: 'm4a', mime: 'audio/mp4', args: ['-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart'] }];
        for (const a of attempts) {
            const out = tmpName(a.ext);
            try {
                await ffmpeg(['-i', file.path, '-vn', ...a.args, out], 120000);
                const size = (await fs.promises.stat(out)).size;
                if (size < 2048) throw new Error('empty output');
                await file.cleanup();
                return { file: { path: out, size, mime: a.mime, cleanup: () => fs.promises.unlink(out).catch(() => {}) }, ext: a.ext, mime: a.mime, converted: true, asDocument: false };
            } catch (err) {
                console.warn(`[audio] ${info.kind} -> ${a.ext} failed: ${err.message}`);
                fs.promises.unlink(out).catch(() => {});
            }
        }
    }
    // no ffmpeg (or conversion failed): m4a is normally fine as it is, anything else goes out as a file
    if (info.kind === 'm4a') return { file, ext: 'm4a', mime: 'audio/mp4', converted: false, asDocument: false };
    return { file, ext: info.ext === 'bin' ? 'mp3' : info.ext, mime: info.mime === 'application/octet-stream' ? 'audio/mpeg' : info.mime, converted: false, asDocument: true };
}

module.exports = { sniff, prepare, hasFfmpeg };
