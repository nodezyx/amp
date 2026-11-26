'use strict';
// SUBZERO MD MINI - scale helpers for running many paired bots (50-100) in ONE process.
//
//   wrapGroupMetadata(socket)   per-bot cache for socket.groupMetadata (it was a network call on EVERY group
//                               message); invalidated by group / participant updates; concurrent calls share one request
//   keyedDebounce(key, fn, ms)  coalesce bursts (creds saves) into one trailing call per key
//   limiter(name, max)          cap concurrent heavy jobs (ffmpeg, big downloads) so 100 bots cannot starve the CPU
//   pool(items, n, fn, stagger) start many sessions n at a time instead of one-by-one or all at once
//   crashGuard()                log stray errors; restart the process only if they keep coming (one bad
//                               event used to restart ALL bots)
//   lag / stats                 event-loop lag + memory figures for the .perf command

const os = require('os');

// ------------------------------------------------------------------ group metadata cache

const GROUP_TTL = parseInt(process.env.GROUP_CACHE_TTL_SEC || '120', 10) * 1000;
const GROUP_MAX = parseInt(process.env.GROUP_CACHE_MAX || '300', 10);
const groupStats = { hits: 0, misses: 0 };

function wrapGroupMetadata(socket) {
    if (!socket || typeof socket.groupMetadata !== 'function' || socket.__groupCache) return socket;
    const original = socket.groupMetadata.bind(socket);
    const cache = new Map();      // jid -> { at, data }
    const inflight = new Map();   // jid -> Promise
    socket.__groupCache = cache;

    socket.groupMetadata = async (jid) => {
        const hit = cache.get(jid);
        if (hit && Date.now() - hit.at < GROUP_TTL) { groupStats.hits++; return hit.data; }
        if (inflight.has(jid)) return inflight.get(jid);
        groupStats.misses++;
        const p = original(jid).then((data) => {
            cache.delete(jid); cache.set(jid, { at: Date.now(), data });
            while (cache.size > GROUP_MAX) cache.delete(cache.keys().next().value);
            return data;
        }).finally(() => inflight.delete(jid));
        inflight.set(jid, p);
        return p;
    };

    const drop = (jid) => { if (jid) cache.delete(jid); };
    try {
        socket.ev.on('groups.update', (list) => (list || []).forEach((g) => drop(g.id)));
        socket.ev.on('group-participants.update', (u) => drop(u && u.id));
        socket.ev.on('groups.upsert', (list) => (list || []).forEach((g) => drop(g.id)));
    } catch { /* socket without events (tests) */ }
    return socket;
}

// ------------------------------------------------------------------ debounce per key

const timers = new Map(); const lastRun = new Map();
// Runs fn at once if it has not run for `ms`, otherwise once more when `ms` has passed (leading + trailing),
// so the FIRST change is never delayed (a fresh pairing must reach the database immediately).
function keyedDebounce(key, fn, ms) {
    if (timers.has(key)) return false;
    const run = () => { lastRun.set(key, Date.now()); Promise.resolve().then(fn).catch(() => {}); };
    const wait = ms - (Date.now() - (lastRun.get(key) || 0));
    if (wait <= 0) { run(); return true; }
    const t = setTimeout(() => { timers.delete(key); run(); }, wait);
    if (t.unref) t.unref();
    timers.set(key, t);
    return true;
}
function flushAll() { for (const t of timers.values()) clearTimeout(t); timers.clear(); }

// ------------------------------------------------------------------ concurrency limiter

const limiters = new Map();
function limiter(name, max) {
    let l = limiters.get(name);
    if (l) return l;
    l = { name, max, running: 0, queue: [], done: 0, maxQueue: 0 };
    l.run = (fn) => new Promise((resolve, reject) => {
        const go = () => {
            l.running++;
            Promise.resolve().then(fn).then(resolve, reject).finally(() => {
                l.running--; l.done++;
                const next = l.queue.shift();
                if (next) next();
            });
        };
        if (l.running < l.max) go(); else { l.queue.push(go); l.maxQueue = Math.max(l.maxQueue, l.queue.length); }
    });
    limiters.set(name, l);
    return l;
}
const cpus = Math.max(1, (os.cpus() || []).length);
const heavy = () => limiter('ffmpeg', parseInt(process.env.FFMPEG_CONCURRENCY || '', 10) || Math.min(3, cpus));

// ------------------------------------------------------------------ start many sessions

async function pool(items, n, fn, staggerMs = 0) {
    const list = [...items]; let i = 0; const results = [];
    const worker = async () => {
        while (i < list.length) {
            const idx = i++;
            try { results[idx] = await fn(list[idx], idx); } catch (e) { results[idx] = e; }
            if (staggerMs) await new Promise((r) => setTimeout(r, staggerMs));
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(n, list.length)) }, worker));
    return results;
}

// ------------------------------------------------------------------ stray errors

function crashGuard({ restart, max = 8, windowMs = 60000, log = console.error } = {}) {
    const hits = [];
    const onErr = (kind) => (err) => {
        const now = Date.now(); hits.push(now);
        while (hits.length && now - hits[0] > windowMs) hits.shift();
        log(`[guard] ${kind} (${hits.length}/${max} in ${windowMs / 1000}s):`, err && (err.stack || err.message || err));
        if (hits.length >= max && typeof restart === 'function') { hits.length = 0; restart(err); }
    };
    return { uncaught: onErr('uncaughtException'), rejection: onErr('unhandledRejection'), _hits: hits };
}

// ------------------------------------------------------------------ event loop lag

let lagMs = 0, lagMax = 0, lagTimer = null;
function startLagMonitor(warnMs = 750) {
    if (lagTimer) return;
    let last = Date.now(), lastWarn = 0;
    lagTimer = setInterval(() => {
        const now = Date.now(); lagMs = Math.max(0, now - last - 1000); last = now;
        lagMax = Math.max(lagMax * 0.98, lagMs);
        if (lagMs > warnMs && now - lastWarn > 30000) { lastWarn = now; console.warn(`[perf] event loop was blocked for ${lagMs}ms`); }
    }, 1000);
    lagTimer.unref();
}

function stats() {
    const m = process.memoryUsage();
    const mb = (b) => Math.round(b / 1048576);
    return {
        rssMb: mb(m.rss), heapMb: mb(m.heapUsed), heapLimitMb: mb(require('v8').getHeapStatistics().heap_size_limit), externalMb: mb(m.external),
        lagMs, lagPeakMs: Math.round(lagMax), uptimeS: Math.round(process.uptime()),
        groupCache: { ...groupStats }, limiters: [...limiters.values()].map((l) => ({ name: l.name, max: l.max, running: l.running, queued: l.queue.length, done: l.done, peakQueue: l.maxQueue })),
        cpus, totalMemMb: mb(os.totalmem())
    };
}

// ------------------------------------------------------------------ .perf (super owner)

module.exports = function build(h) {
    const { box, say, withFooter, ctxSuper, registry } = h;
    const sc = registry.smallcaps;
    const row = (k, v) => `▨ ${sc(k)} ⟜ ${v}`;
    async function cmdPerf(ctx) {
        if (!ctxSuper(ctx)) return say(ctx, withFooter(box('ACCESS DENIED', ['Super owner only.'])));
        const s = stats();
        const online = ctx.helpers.activeSockets ? ctx.helpers.activeSockets.size : 0;
        const lines = [
            row('Bots online', online), row('Memory', `${s.rssMb} MB used, heap ${s.heapMb}/${s.heapLimitMb} MB`),
            row('Per bot', online ? `${Math.round(s.rssMb / online)} MB average` : '-'), row('Loop lag', `${s.lagMs} ms (peak ${s.lagPeakMs})`),
            row('Group cache', `${s.groupCache.hits} hits / ${s.groupCache.misses} misses`), row('CPU cores', s.cpus), row('Host RAM', `${s.totalMemMb} MB`)
        ];
        for (const l of s.limiters) lines.push(row(l.name, `${l.running}/${l.max} running, ${l.queued} queued, ${l.done} done`));
        return say(ctx, withFooter(box('PERFORMANCE', lines)));
    }
    return { routes: [[['perf', 'health', 'load'], cmdPerf]] };
};
Object.assign(module.exports, { wrapGroupMetadata, keyedDebounce, flushAll, limiter, heavy, pool, crashGuard, startLagMonitor, stats });
