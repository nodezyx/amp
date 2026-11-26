'use strict';
// Keeps the bot small and stable on panels with limited storage / memory.
//
//  * core dumps: when Node dies hard (usually out of memory) Linux writes a "core.<pid>" file as big as the
//    process memory - that is the 1+ GB "core.38" file. We start the bot with `ulimit -c 0` (no dumps),
//    delete any that already exist, and keep sweeping for them.
//  * heap cap: the bot runs with --max-old-space-size so a leak ends in a clean restart, not a giant crash.
//  * auto restart: if the bot exits abnormally the wrapper starts it again (with a crash-loop brake).
//  * janitor: removes temp files left behind by downloads / conversions.
//
// Usage (first lines of bot.js / index.js):
//     if (require('./lib/guard').relaunch()) return;
//     require('./lib/guard').startJanitor();

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// Heap cap: SZ_HEAP_MB if set. Otherwise 450 MB, raised to at most 900 MB only when a container memory limit
// (cgroup) is visible and big enough. The host's total RAM is NEVER used: on shared panels it reports the whole
// machine, which let the bot grow past what the panel allows -> killed -> 1 GB+ "core.NN" file.
function cgroupLimitMb() {
    for (const f of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
        try { const v = Number(fs.readFileSync(f, 'utf8').trim()); if (v > 0 && v < 1e12) return Math.floor(v / 1048576); } catch { /* none */ }
    }
    return 0;
}
const HEAP_MB = parseInt(process.env.SZ_HEAP_MB || '', 10) || Math.min(900, Math.max(450, Math.floor(cgroupLimitMb() * 0.4)));
const TMP_MAX_AGE_MS = 15 * 60 * 1000;
const TMP_PREFIX = /^(szm-|cdn-|cdn_upload_|remini_|removebg_|qr_|ytdl-|tmp-szm)/;
const CORE_FILE = /^(core(\.\d+)?|.+\.core|.+\.heapsnapshot|.+\.dmp|hs_err_pid\d+\.log|report\.\d.*\.json|javascript_core.*)$/i;

function relaunch() {
    if (process.env.SZ_GUARDED === '1' || process.platform === 'win32') return false;
    const script = process.argv[1];
    if (!script) return false;
    const env = { ...process.env, SZ_GUARDED: '1' };
    // "ulimit -c 0" must run in the shell that execs node, so the limit is inherited by it
    const shellArgs = ['-c', 'ulimit -c 0 2>/dev/null; exec "$@"', 'sh', process.execPath, `--max-old-space-size=${HEAP_MB}`, '--max-semi-space-size=16', ...process.execArgv.filter((a) => !/max-old-space-size/.test(a)), script, ...process.argv.slice(2)];
    let child = null;
    let stopping = false;
    const crashes = [];

    const start = () => {
        try {
            child = spawn('sh', shellArgs, { stdio: 'inherit', env });
        } catch (err) {
            console.error('[guard] could not start the guarded process:', err.message);
            process.exit(1);
        }
        child.on('error', (err) => { console.error('[guard] spawn error:', err.message); process.exit(1); });
        child.on('exit', (code, signal) => {
            if (stopping || code === 0) return process.exit(code || 0);
            const now = Date.now();
            crashes.push(now);
            while (crashes.length && now - crashes[0] > 60000) crashes.shift();
            sweepCoreFiles();
            if (crashes.length > 5) {
                console.error('[guard] crashing repeatedly, giving up');
                return process.exit(code || 1);
            }
            console.error(`[guard] bot stopped (${signal || 'code ' + code}); restarting in 3s`);
            setTimeout(start, 3000);
        });
    };
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
        process.on(sig, () => { stopping = true; if (child) child.kill(sig); setTimeout(() => process.exit(0), 5000).unref(); });
    }
    sweepCoreFiles();
    start();
    return true;
}

function sweepCoreFiles(dir = process.cwd()) {
    let removed = 0;
    try {
        for (const name of fs.readdirSync(dir)) {
            if (!CORE_FILE.test(name)) continue;
            const full = path.join(dir, name);
            try { if (fs.statSync(full).isFile()) { fs.unlinkSync(full); removed++; console.log(`[guard] removed ${name}`); } } catch { /* in use / gone */ }
        }
    } catch { /* unreadable dir */ }
    return removed;
}

function sweepTemp() {
    let removed = 0;
    const dir = os.tmpdir();
    try {
        for (const name of fs.readdirSync(dir)) {
            if (!TMP_PREFIX.test(name)) continue;
            const full = path.join(dir, name);
            try {
                const st = fs.statSync(full);
                if (st.isFile() && Date.now() - st.mtimeMs > TMP_MAX_AGE_MS) { fs.unlinkSync(full); removed++; }
            } catch { /* ignore */ }
        }
    } catch { /* ignore */ }
    return removed;
}

// size of a folder in bytes (skips node_modules and symlinks)
function dirSize(dir, skip = new Set(['node_modules', '.git'])) {
    let total = 0;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
    for (const e of entries) {
        if (skip.has(e.name)) continue;
        const full = path.join(dir, e.name);
        try {
            if (e.isDirectory()) total += dirSize(full, skip);
            else if (e.isFile()) total += fs.statSync(full).size;
        } catch { /* ignore */ }
    }
    return total;
}

let started = false;
function startJanitor() {
    if (started) return;
    started = true;
    const run = () => {
        const cores = sweepCoreFiles();
        const tmp = sweepTemp();
        if (cores || tmp) console.log(`[guard] cleaned ${cores} dump file(s), ${tmp} temp file(s)`);
    };
    run();
    setInterval(run, 5 * 60 * 1000).unref();
    // one line an hour so the panel log shows how much space the bot itself uses
    const report = () => {
        const mb = (n) => Math.round(n / 1048576);
        console.log(`[guard] app folder ${mb(dirSize(process.cwd()))} MB (without node_modules) | memory rss ${mb(process.memoryUsage().rss)} MB, heap ${mb(process.memoryUsage().heapUsed)} MB`);
    };
    setTimeout(report, 30 * 1000).unref();
    setInterval(report, 60 * 60 * 1000).unref();
}

module.exports = { relaunch, startJanitor, sweepCoreFiles, sweepTemp, dirSize };
