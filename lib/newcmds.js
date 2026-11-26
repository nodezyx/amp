// SUBZERO MD MINI - command module (v2)
//
// Everything in here is dispatched from pair.js *before* the legacy `switch`, so a command
// defined here always wins over an older duplicate of the same name.
//
//   menu / allmenu / <category>menu / alive
//   alldownload, tiktok, instagram, facebook, twitter, song, video      (lib/api.js)
//   lyrics, ai, gpt, gemini, claude, llama, deepseek, aisearch, newchat
//   settings, setprefix, mode, buttons, anticall, antiedit, antidelete, autoview..., antilink
//   setsudo, delsudo, listsudo, ban, unban, listban, block, unblock
//
// Every reply uses the same look (panel + footer) so the bot feels uniform.

const fs = require('fs');
const util = require('util');
const os = require('os');
const path = require('path');
const yts = require('yt-search');

const api = require('./api');
const registry = require('./commands');
const config = require('../config');
const audiofix = require('./audiofix');
const { Button } = require('./messageBuilder');
const { getAnti, setAnti, getAllAnti, setAllAnti } = require('../data/antidel');
const { getAntiLink, setAntiLink } = require('../data/antilink');

// ---------------------------------------------------------------- branding

const BRAND = '© 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ';
const SITE = 'subzero.mrfrankofc.com';
const SITE_URL = 'https://subzero.mrfrankofc.com';
const FOOTER = `> ${BRAND}\n> ◈ ${SITE}`;         // for captions / text messages
// WhatsApp's "secure service from Meta" label (config.SECURE_LABEL)
const LABEL = () => (config.SECURE_LABEL === false ? {} : { secureMetaServiceLabel: true });
const FOOTER_INLINE = `${BRAND} • ${SITE}`;         // for button footers (single line)
const MENU_IMAGE = config.MENU_IMAGE;
const menuImageRaw = (ctx) => (ctx && ctx.userConfig && ctx.userConfig.MENU_IMAGE) || config.MENU_IMAGE;
// URL or, for an image uploaded with .setmenuimage, the file's Buffer
const menuImage = (ctx) => {
    const v = menuImageRaw(ctx);
    try { if (v && !/^https?:/i.test(v) && fs.existsSync(v)) return fs.readFileSync(v); } catch { /* fall through */ }
    return v;
};
// for { image: ... } payloads
const imgPayload = (v) => (Buffer.isBuffer(v) ? v : { url: v });

// ---------------------------------------------------------------- tiny helpers

const digits = (jid) => String(jid || '').split('@')[0].split(':')[0].replace(/\D/g, '');
const chunkText = (text, size = 3800) => {
    const out = [];
    let rest = String(text);
    while (rest.length > size) {
        let cut = rest.lastIndexOf('\n', size);
        if (cut < size * 0.5) cut = size;
        out.push(rest.slice(0, cut));
        rest = rest.slice(cut);
    }
    if (rest.trim()) out.push(rest);
    return out;
};
const READMORE = '\u200E'.repeat(4001);
const clip = (s, n) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s || '');
const safeName = (s, fallback = 'media') => (String(s || fallback).replace(/[<>:"\/\\|?*\n\r]+/g, '').trim().slice(0, 60) || fallback);

// A boxed block: panel('⚙️ SETTINGS', ['Status : ON', 'Use : .x on'])
const panel = (title, lines = []) =>
    `╭─「 ${title} 」\n${lines.map((l) => `│ ${l}`).join('\n')}\n╰──────────────⟢`;

// Menu box: ◈ bold title, ▨ rows. No emojis.
const box = (title, lines = []) =>
    `╭${registry.LINE}⟢\n┃ ◈ ${registry.smallcaps(title)}\n┣${registry.LINE}\n${lines.map((l) => `┃ ${l}`).join('\n')}\n╰${registry.LINE}⟢`;

const withFooter = (body) => `${body}\n\n${FOOTER}`;

const fail = (reason) => withFooter(panel('❌ ERROR', [clip(String(reason || 'Something went wrong'), 300)]));

const react = (ctx, emoji, key) =>
    ctx.socket.sendMessage(ctx.sender, { react: { text: emoji, key: key || ctx.msg.key } }).catch(() => {});

const say = (ctx, text, quoted) => ctx.socket.sendMessage(ctx.sender, { text }, { quoted: quoted || ctx.msg });

const quotedText = (msg) => {
    const qm = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    return qm?.conversation || qm?.extendedTextMessage?.text || qm?.imageMessage?.caption || qm?.videoMessage?.caption || '';
};

// ---------------------------------------------------------------- access control (sudo / ban)
// Lists are tiny files, so we read them fresh every time: a .setsudo / .ban takes effect
// immediately instead of after a cache expiry.

const LIB = __dirname;
const readList = (file) => {
    try { return JSON.parse(fs.readFileSync(path.join(LIB, file), 'utf-8')) || []; } catch { return []; }
};
const writeList = (file, list) => fs.writeFileSync(path.join(LIB, file), JSON.stringify([...new Set(list)], null, 2));

// A person can show up as a phone number or as a @lid - collect every identity we know.
function buildIds({ senderNumber, nowsender, m } = {}) {
    const ids = new Set([digits(senderNumber), digits(nowsender), digits(m?.sender), digits(m?.senderPn), digits(m?.senderLid), digits(m?.senderRaw)]);
    ids.delete('');
    return ids;
}
const listed = (list, ids) => list.some((entry) => ids.has(digits(entry)));
const isSudo = (ids) => listed(readList('sudo.json'), ids);
const isBanned = (ids) => listed(readList('ban.json'), ids);

// Super owners (config.SUPER_OWNERS) can do anything on any paired bot.
const superSet = () => new Set((config.SUPER_OWNERS || []).map(digits).filter(Boolean));
const isSuper = (ids) => { const sup = superSet(); for (const id of ids) if (sup.has(id)) return true; return false; };
const ctxSuper = (ctx) => ctx.isSuper === true || isSuper(buildIds(ctx));

const isManager = (ctx) => ctx.isOwner || ctxSuper(ctx) || isSudo(buildIds(ctx));
const denyUnlessManager = async (ctx) => {
    if (isManager(ctx)) return false;
    await say(ctx, withFooter(panel('📛 ACCESS DENIED', ['Only the bot owner or sudo users', 'can use this command.'])));
    return true;
};
const denyUnlessOwner = async (ctx) => {
    if (ctx.isOwner || ctxSuper(ctx)) return false;
    await say(ctx, withFooter(panel('📛 ACCESS DENIED', ['Only the bot owner can use', 'this command.'])));
    return true;
};

// ---------------------------------------------------------------- interactive helpers

// Send a native-flow message built from the Button class.
// buttons: [{ type: 'reply'|'url', label, value }]
async function sendButtons(ctx, { image, title, body, buttons, quoted }) {
    const { socket, helpers } = ctx;
    if (helpers.isButtonsEnabled()) {
        const b = new Button(socket).setBody(body).setFooter(FOOTER_INLINE);
        if (title) b.setTitle(title);
        if (image) b.setImage(image);
        buttons.forEach((x) => (x.type === 'url' ? b.addUrl(x.label, x.value) : b.addReply(x.label, x.value)));
        return b.send(ctx.sender, { quoted: quoted || ctx.msg });
    }
    // Buttons disabled: same content as plain text, telling the user what to type.
    const hints = buttons
        .map((x) => (x.type === 'url' ? `│ ${x.label}: ${x.value}` : `│ ${x.label} → ${x.value}`))
        .join('\n');
    const text = withFooter(`${body}\n\n╭─「 ⌨️ SHORTCUTS 」\n${hints}\n╰──────────────⟢`);
    return socket.sendMessage(ctx.sender, image ? { image: { url: image }, caption: text } : { text }, { quoted: quoted || ctx.msg });
}

// ---------------------------------------------------------------- bot info (menu header)

const fmtUptime = (ms) => {
    const d = Math.floor(ms / 86400000), h = Math.floor((ms % 86400000) / 3600000), mi = Math.floor((ms % 3600000) / 60000), s = Math.floor((ms % 60000) / 1000);
    return `${d ? `${d}d ` : ''}${h}h ${mi}m ${s}s`;
};

function infoLines(ctx) {
    const started = ctx.helpers.socketCreationTime.get(ctx.number) || Date.now();
    const mem = process.memoryUsage();
    const mode = String(ctx.userConfig.MODE || config.MODE).toUpperCase();
    const L = (k, v) => `▨ ${registry.smallcaps(k)} ⟜ ${v}`;
    return [
        L('User', clip(ctx.msg.pushName || 'User', 16)),
        L('Owner', registry.bold('MR FRANK OFC')),
        L('Prefix', ctx.prefix),
        L('Mode', mode),
        L('Uptime', fmtUptime(Date.now() - started)),
        L('RAM', `${Math.round(mem.heapUsed / 1048576)}MB / ${Math.round(os.totalmem() / 1048576)}MB`),
        L('Commands', registry.totalCommands()),
    ];
}

// ---------------------------------------------------------------- MENUS

// Handy "right now" values for the designed headers.
const hararePlace = { timeZone: 'Africa/Harare' };
const fmtDate = () => new Date().toLocaleDateString('en-GB', hararePlace);
const fmtTime = () => new Date().toLocaleTimeString('en-GB', { ...hararePlace, hour12: false });
const pingMs = (msg) => {
    const ts = Number(msg?.messageTimestamp?.low ?? msg?.messageTimestamp ?? 0);
    return ts ? Math.max(0, Date.now() - ts * 1000) : 0;
};

// .menu - the classic interactive menu: category picker (single_select list) + join/owner buttons,
// with the limited-time-offer banner ("Expires on ...") and bottom sheet styling.
async function cmdMenu(ctx) {
    const p = ctx.prefix;
    await react(ctx, '📃');
    const cats = registry.getCategories();
    const entries = [...cats.map((c) => ({ title: c.title, cmd: c.menuNames[0], count: c.commands.length })), { title: 'ALL MENU', cmd: 'allmenu', count: registry.totalCommands() }];

    const buttonsOn = ctx.helpers.isButtonsEnabled();
    const box0 = box('SUBZERO MD MINI', infoLines(ctx));
    // Buttons off: numbered list, reply with a number. Buttons on: a clean list, no numbers.
    const info = `${box0}\n\n◈ ${registry.smallcaps(buttonsOn ? 'Pick a category below' : 'Reply with a number')}`;
    const numbered = entries.map((e, i) => `${i + 1}. ${registry.bold(e.title)}`).join('\n');
    const options = entries.map((e) => ({ label: e.title, value: e.cmd }));
    // A number reply (quoting this menu) opens that category, with or without buttons.
    const listen = (sent) => {
        if (!sent?.key) return;
        ctx.helpers.awaitInteractiveReply(ctx.socket, ctx.sender, sent, 'menu', options, async (value, messageData) => {
            await handle({ ...ctx, command: value, args: [], q: '', body: `${p}${value}`, msg: messageData, ai: messageData });
        }, { once: false });
    };

    if (!buttonsOn) {
        const sent = await ctx.socket.sendMessage(ctx.sender, {
            image: imgPayload(menuImage(ctx)),
            caption: withFooter(`${info}\n\n${numbered}`),
            ...LABEL(),
        }, { quoted: ctx.ai });
        return listen(sent);
    }

    const btn = new Button(ctx.socket)
        .setImage(menuImage(ctx))
        .setTitle(registry.bold('SUBZERO MD MENU'))
        .setBody(info)
        .setFooter(FOOTER_INLINE)
        .addSelection('Select Menu Category')
        .makeSection('Choose A Category', 'SUBZERO MD');
    entries.forEach((e) => btn.makeRow('', `◈ ${registry.bold(e.title)}`, `${e.count} commands`, `${p}${e.cmd}`));
    btn.addUrl('Join Channel', config.CHANNEL_LINK)
        .addReply('Owner', `${p}owner`)
        .setParams({
            limited_time_offer: {
                text: 'SUBZERO MD MINI',
                url: config.CHANNEL_LINK,
                copy_code: 'SUBZERO',
                expiration_time: Date.now() + 86400000, // rolling 24h => "Expires on ..." banner
            },
            bottom_sheet: {
                in_thread_buttons_limit: 2,
                divider_indices: [0, 1, 2, 3],
                list_title: 'Subzero MD Menu',
                button_title: '𝗠𝗘𝗡𝗨 ⋮',
            },
        });
    await btn.send(ctx.sender, { quoted: ctx.ai });
}

// .allmenu - ONE image message: designed status header + every category, all in the caption.
async function cmdAllMenu(ctx) {
    const p = ctx.prefix;
    await react(ctx, '📋');
    const cats = registry.getCategories();
    const mode = String(ctx.userConfig.MODE || config.MODE).toUpperCase();
    const users = ctx.helpers.activeSockets ? ctx.helpers.activeSockets.size : 1;
    const started = ctx.helpers.socketCreationTime.get(ctx.number) || Date.now();
    const mem = process.memoryUsage();

    const R = (k, v) => `▨ ${registry.smallcaps(k)} ⟜ ${v}`;
    const header = box('SUBZERO MD MINI', [
        R('Dev', registry.bold('MR FRANK OFC')),
        R('Runtime', fmtUptime(Date.now() - started)),
        R('Server', `${os.type()} ${os.arch()}`),
        R('Ping', `${pingMs(ctx.msg)} ms`),
        R('Date', fmtDate()),
        R('Time', `${fmtTime()} CAT`),
        R('Users', users),
        R('Requester', clip(ctx.msg.pushName || 'User', 16)),
        R('Prefix', p),
        R('Mode', mode),
        R('RAM', `${Math.round(mem.heapUsed / 1048576)} / ${Math.round(os.totalmem() / 1048576)} MB`),
        R('Commands', registry.totalCommands()),
    ]);

    const blocks = cats.map((c) => registry.renderCategoryCompact(c, p));
    const tip = `◈ ${registry.smallcaps('Details')} ⟜ ${p}<category>menu  e.g. ${p}${cats[1].menuNames[0]}`;

    // Everything goes into the image caption. If it ever outgrows WhatsApp's limit the overflow
    // continues in plain text rather than being cut off.
    const LIMIT = 3600 + READMORE.length;
    // Everything after the READMORE marker is hidden behind WhatsApp's "Read more" - only the header shows at first.
    let caption = `${header}\n${READMORE}`;
    const overflow = [];
    blocks.forEach((b) => {
        if (!overflow.length && (caption + '\n\n' + b).length < LIMIT) caption += `\n\n${b}`;
        else overflow.push(b);
    });
    if (!overflow.length) caption += `\n\n${tip}`;

    await ctx.socket.sendMessage(ctx.sender, { image: imgPayload(menuImage(ctx)), caption: withFooter(caption), ...LABEL() }, { quoted: ctx.ai });
    if (overflow.length) {
        let cur = '';
        const msgs = [];
        overflow.forEach((b) => { if ((cur + '\n\n' + b).length > 3500 && cur) { msgs.push(cur); cur = b; } else cur = cur ? `${cur}\n\n${b}` : b; });
        if (cur) msgs.push(`${cur}\n\n${tip}`);
        for (const t of msgs) await say(ctx, withFooter(t), ctx.msg);
    }
}

// .dlmenu, .aimenu, .groupmenu ... - one category in detail.
async function cmdCategoryMenu(ctx) {
    const cat = registry.findCategoryByMenu(ctx.command);
    if (!cat) return;
    await react(ctx, cat.icon);
    const body = `${registry.renderCategoryDetailed(cat, ctx.prefix)}\n\n◈ ${registry.smallcaps('Everything')} ⟜ ${ctx.prefix}allmenu`;
    await ctx.socket.sendMessage(ctx.sender, { image: imgPayload(menuImage(ctx)), caption: withFooter(body), ...LABEL() }, { quoted: ctx.ai });
}

async function cmdAlive(ctx) {
    await react(ctx, '❤️');
    const started = ctx.helpers.socketCreationTime.get(ctx.number) || Date.now();
    const body = panel('💚 𝐒𝐔𝐁𝐙𝐄𝐑𝐎 𝐀𝐋𝐈𝐕𝐄', [
        '🎀 Bot     : Subzero MD Mini',
        `⏰ Uptime  : ${fmtUptime(Date.now() - started)}`,
        `🔢 Number  : ${ctx.number}`,
        '🏷️ Creator : Mr Frank',
    ]);
    await sendButtons(ctx, {
        image: menuImage(ctx),
        title: 'Bot is online',
        body,
        buttons: [
            { type: 'reply', label: '📋 MENU', value: `${ctx.prefix}menu` },
            { type: 'reply', label: '👑 OWNER', value: `${ctx.prefix}owner` },
            { type: 'url', label: '🌐 WEBSITE', value: SITE_URL },
        ],
    });
}

// ---------------------------------------------------------------- DOWNLOADERS

const PLATFORM_META = {
    tiktok: { icon: '🎵', name: 'TikTok', usage: 'tiktok https://www.tiktok.com/@user/video/123' },
    instagram: { icon: '📸', name: 'Instagram', usage: 'ig https://www.instagram.com/reel/ABC123/' },
    facebook: { icon: '📘', name: 'Facebook', usage: 'fb https://www.facebook.com/share/r/ABC123/' },
    twitter: { icon: '🐦', name: 'X (Twitter)', usage: 'x https://x.com/user/status/123' },
    youtube: { icon: '▶️', name: 'YouTube', usage: 'song <name or link>' },
    any: { icon: '📥', name: 'All-in-one Downloader', usage: 'alldownload <tiktok / instagram / facebook / x / youtube link>' },
};

const mediaCaption = (meta, info) => withFooter(panel(`${meta.icon} ${meta.name.toUpperCase()}`, [
    `📌 ${clip(info.title || 'Untitled', 120)}`,
    ...(info.author ? [`👤 ${clip(info.author, 60)}`] : []),
    ...(info.duration ? [`⏱ ${info.duration}${/^\d+$/.test(String(info.duration)) ? 's' : ''}`] : []),
]));

// Download one item and send it. The file is streamed to a temp file on disk (never held in RAM) and
// Baileys uploads straight from that path, so big videos are as light on memory as small ones.
//   opts.asDocument: send as a file instead of inline media
const durationSeconds = (d) => {
    if (typeof d === 'number') return d;
    const parts = String(d || '').split(':').map((x) => parseInt(x, 10));
    if (!parts.length || parts.some(Number.isNaN)) return 0;
    return parts.reduce((acc, n) => acc * 60 + n, 0);
};

// A real song / video is never a few KB: refuse tiny or cut-off files (the "52 KB file" problem) so the
// caller can move on to the next provider instead of sending junk.
function minBytesFor(item, seconds) {
    const dur = durationSeconds(seconds);
    return item.type === 'audio' ? Math.max(30 * 1024, dur * 16000 * 0.2)
        : item.type === 'video' ? Math.max(120 * 1024, dur * 30000 * 0.1) : 2048;
}

async function deliverItem(ctx, info, item, caption, quoted, opts = {}) {
    let file = null;
    try {
        file = await api.downloadToFile(item.url, { minBytes: minBytesFor(item, opts.seconds ?? info?.duration), headers: item.headers });
    } catch (err) {
        if (opts.strict || item.type === 'audio' || /too large/i.test(err.message)) throw err;
        // CDN refused our download - let WhatsApp try to pull the URL itself.
        console.warn('streaming download failed, falling back to URL send:', err.message);
    }
    return sendMedia(ctx, info, item, file, caption, quoted, opts);
}

// Sends an already downloaded temp file (or, as a last resort, the bare URL) and removes the temp file.
async function sendMedia(ctx, info, item, file, caption, quoted, opts = {}) {
    // (file may be swapped for a converted copy below; the finally block cleans whichever one is current)
    const { socket, sender } = ctx;
    const q = { quoted: quoted || ctx.msg };
    const src = { url: file ? file.path : item.url };
    const mb = file ? file.size / 1048576 : 0;
    const base = safeName(info.title, item.type === 'audio' ? 'audio' : 'video');
    let payload, ext = 'mp3', mime = 'audio/mpeg';
    if (item.type === 'audio') {
        // look at the real bytes: the content-type header of these CDNs is usually generic
        let fixed = { ext: 'mp3', mime: 'audio/mpeg', asDocument: false };
        if (file) {
            try { fixed = await audiofix.prepare(file); file = fixed.file; src.url = file.path; }
            catch (err) { console.warn('audio check failed, sending as is:', err.message); }
        }
        ext = fixed.ext; mime = fixed.mime;
        payload = (opts.asDocument || fixed.asDocument)
            ? { document: src, mimetype: mime, fileName: `${base}.${ext}`, caption }
            : { audio: src, mimetype: mime, fileName: `${base}.${ext}` };
    } else if (item.type === 'image') {
        payload = { image: src, caption };
    } else if (opts.asDocument || mb > config.VIDEO_DOC_MB) {
        payload = { document: src, mimetype: 'video/mp4', fileName: `${base}.mp4`, caption };
    } else {
        payload = { video: src, mimetype: 'video/mp4', caption };
    }
    try {
        try {
            await socket.sendMessage(sender, payload, q);
        } catch (err) {
            // Inline audio can be refused (odd container / duration probe). A document always goes through.
            if (item.type !== 'audio' || opts.asDocument) throw err;
            console.warn('audio send failed, retrying as a file:', err.message);
            await socket.sendMessage(sender, { document: src, mimetype: mime, fileName: `${base}.${ext}` }, q);
        }
    } finally {
        if (file) file.cleanup();
    }
}

// Cover image for a prompt. Fetched ourselves (hot-link protected CDNs reject WhatsApp's fetcher); never throws.
async function cover(url) {
    if (!url) return undefined;
    try { return await api.fetchBuffer(url, { maxMB: 6, timeout: 15000 }); } catch { return undefined; }
}
const ytThumb = (url) => { const m = String(url).match(/(?:v=|youtu\.be\/|shorts\/)([\w-]{11})/); return m ? `https://i.ytimg.com/vi/${m[1]}/hqdefault.jpg` : null; };

// qualities, best first, one entry per distinct quality
const qNum = (v) => parseInt(String(v.quality || v.label || '').replace(/\D/g, ''), 10) || 0;
function videoOptions(info) {
    const seen = new Set();
    return info.items
        .filter((i) => i.type === 'video')
        .map((v, i) => ({ v, i }))
        .sort((a, b) => (qNum(b.v) - qNum(a.v)) || (a.i - b.i))
        .map((x) => x.v)
        .filter((v) => { const k = String(v.quality || v.label || 'video'); if (seen.has(k)) return false; seen.add(k); return true; });
}
const bestUnder = (opts, max = 720) => opts.find((v) => qNum(v) && qNum(v) <= max) || opts[0];

// Button / list menu in button mode, numbered reply otherwise (the helpers pick the right one).
// options: [{ label, value, description? }]
async function pickMenu(ctx, { image, caption, options }, onPick) {
    const opts = options.map((o) => ({ label: o.label, value: o.value, title: o.label, description: o.description || '' }));
    const picker = opts.length <= 3 ? ctx.helpers.sendInteractiveOptions : ctx.helpers.sendInteractiveList;
    const args = { image, caption, footer: FOOTER_INLINE, buttonText: 'CHOOSE', options: opts, rows: opts };
    let picked;
    try {
        picked = await picker(ctx.socket, ctx.sender, ctx.msg, args);
    } catch (e) {
        console.warn('picker with image failed, retrying without it:', e.message);
        picked = await picker(ctx.socket, ctx.sender, ctx.msg, { ...args, image: undefined });
    }
    ctx.helpers.awaitInteractiveReply(ctx.socket, ctx.sender, picked.sentMsg, picked.sessionId, opts, onPick, { once: false });
}

async function askChoice(ctx, { image, title, options }, onPick) {
    return pickMenu(ctx, { image: await cover(image), caption: withFooter(title), options }, onPick);
}

// One provider, start to finish: lookup + streamed download into a validated temp file.
async function fetchMedia(cand, mode, { meta = {}, firstPromise, forced } = {}) {
    const info = await (firstPromise || cand.run());
    info.title = info.title || meta.title; info.author = info.author || meta.author; info.duration = info.duration || meta.duration;
    const item = forced || (mode === 'video' ? bestUnder(videoOptions(info)) : info.items.find((x) => x.type === 'audio'));
    if (!item) throw new Error(`${cand.name}: no usable media`);
    const file = await api.downloadToFile(item.url, { minBytes: minBytesFor(item, meta.seconds ?? info.duration), headers: item.headers });
    return { info, item, file, name: cand.name };
}

// Providers race instead of queueing: the first one starts at once, the next starts when it fails OR when
// nothing has finished after staggerMs, and the first valid file wins (late files are deleted).
function raceMedia(cands, mode, { meta, firstPromise, forced, staggerMs = 7000 } = {}) {
    return new Promise((resolve, reject) => {
        let started = 0, inflight = 0, failed = 0, done = false, lastErr = null, timer = null;
        const finish = (fn, v) => { if (done) return false; done = true; clearTimeout(timer); fn(v); return true; };
        const launch = () => {
            if (done || started >= cands.length) return;
            const i = started++; inflight++;
            clearTimeout(timer);
            fetchMedia(cands[i], mode, { meta, firstPromise: i === 0 ? firstPromise : undefined, forced }).then((r) => {
                inflight--;
                if (!finish(resolve, r)) r.file.cleanup(); // a slower provider that lost the race
                else console.log(`[${mode}] delivered via ${r.name}`);
            }, (err) => {
                inflight--; failed++; lastErr = err;
                console.warn(`[${mode}] ${cands[i].name} failed: ${err.message}`);
                if (/too large/i.test(err.message)) return finish(reject, err);
                if (failed >= cands.length) return finish(reject, new Error(`Every provider failed - last error: ${err.message}`));
                if (inflight === 0) launch();
            });
            if (started < cands.length) timer = setTimeout(launch, staggerMs);
        };
        launch();
    });
}

// Download first (racing the providers), then send the finished file.
// prefetched: a raceMedia() promise that was started earlier (e.g. while the menu was on screen).
async function deliverChain(ctx, cands, mode, { quoted, captionFor, meta = {}, asDocument, firstPromise, item: forced, prefetched } = {}) {
    const r = await (prefetched || raceMedia(cands, mode, { meta, firstPromise, forced }));
    try {
        await sendMedia(ctx, r.info, r.item, r.file, captionFor ? captionFor(r.info) : undefined, quoted, { asDocument });
    } catch (err) {
        r.file.cleanup();
        throw err;
    }
    return r.info;
}

// Turn the provider's items into the (few) options a person actually wants to choose between.
function buildChoices(info) {
    const videos = videoOptions(info);
    const audio = info.items.find((i) => i.type === 'audio');
    const images = info.items.filter((i) => i.type === 'image');
    const choices = [];
    videos.slice(0, 4).forEach((v, i) => choices.push({ label: `VIDEO ${String(v.label || '').replace(/^video\s*/i, '').toUpperCase()}`.trim(), value: `v${i}`, run: [v] }));
    if (audio) choices.push({ label: 'AUDIO', value: 'audio', run: [audio] });
    if (images.length) choices.push({ label: `IMAGES (${Math.min(images.length, 10)})`, value: 'images', run: images.slice(0, 10) });
    return choices;
}

// Send a YouTube result in one of the .play formats: 'audio' | 'doc' (audio as a file) | 'video'
async function deliverYoutube(ctx, info, mode, quoted) {
    const caption = mediaCaption(PLATFORM_META.youtube, info);
    if (mode === 'video') {
        const v = bestUnder(videoOptions(info));
        if (!v) throw new Error('No video available for that link');
        return deliverItem(ctx, info, v, caption, quoted);
    }
    const a = info.items.find((i) => i.type === 'audio');
    if (!a) throw new Error('No audio available for that link');
    return deliverItem(ctx, info, a, mode === 'doc' ? caption : undefined, quoted, { asDocument: mode === 'doc' });
}

// .song / .video for a YouTube link.
//   audio: azbry ytplay first (the others as fallbacks)
//   video: faa ytmp4 first; when kyio also lists several qualities the user gets a button / list menu
async function runYoutube(ctx, url, kind) {
    const id = ytId(url);
    const metaP = ytLookup('', url).catch(() => null);
    const metaFor = async () => { const v = await metaP; return { title: v?.title, author: v?.author?.name, duration: v?.timestamp, seconds: v?.seconds }; };
    const captionFor = (info) => mediaCaption(PLATFORM_META.youtube, info);
    const finish = (key) => react(ctx, '✅', key);

    if (kind === 'audio') {
        const v = await metaP;
        const cands = api.youtubeCandidates(url, 'audio', { query: v?.title, videoId: id });
        const first = cands[0].run(); first.catch(() => {});
        await deliverChain(ctx, cands, 'audio', { captionFor, meta: await metaFor(), firstPromise: first });
        return finish();
    }

    const cands = api.youtubeCandidates(url, 'video', { videoId: id });
    const first = cands[0].run(); first.catch(() => {});
    // qualities (best effort, max 4 s so the default download is never held up)
    let qualities = [];
    try {
        const ytdl = await Promise.race([api.youtubeYtdl(url), new Promise((r) => setTimeout(() => r(null), 4000))]);
        if (ytdl) qualities = videoOptions(ytdl).filter((q) => qNum(q)).slice(0, 6);
    } catch { /* no qualities: send the default */ }

    const meta = await metaFor();
    if (qualities.length < 2) {
        await deliverChain(ctx, cands, 'video', { captionFor, meta, firstPromise: first });
        return finish();
    }
    await finish();
    const options = [{ label: 'VIDEO DEFAULT', value: 'default', description: 'Fastest' }, ...qualities.map((q) => ({ label: `VIDEO ${String(q.quality || q.label).toUpperCase()}`, value: q.url, description: '' }))];
    const v = await metaP;
    return pickMenu(ctx, {
        image: await cover(v?.thumbnail || ytThumb(url)),
        caption: withFooter(box('VIDEO QUALITY', [`▨ ${registry.smallcaps('Title')} ⟜ ${clip(v?.title || 'Video', 48)}`, `▨ ${registry.smallcaps('Found')} ⟜ ${qualities.length} qualities`])),
        options,
    }, async (value, messageData) => {
        try {
            await react(ctx, '⏳', messageData.key);
            if (value === 'default') await deliverChain(ctx, cands, 'video', { quoted: messageData, captionFor, meta, firstPromise: first.catch(() => first) });
            else {
                const chosen = qualities.find((q) => q.url === value);
                try { await deliverChain(ctx, [{ name: 'kyio/quality', run: async () => ({ title: null, items: [chosen] }) }], 'video', { quoted: messageData, captionFor, meta, item: chosen }); }
                catch (err) { console.warn('chosen quality failed, using the default chain:', err.message); await deliverChain(ctx, cands, 'video', { quoted: messageData, captionFor, meta }); }
            }
            await finish(messageData.key);
        } catch (err) {
            await react(ctx, '❌', messageData.key);
            await say(ctx, fail(err.message), messageData);
        }
    });
}

// The one downloader every command funnels through.
//   kind: 'audio' | 'video' | undefined (undefined = let the user choose when there is a choice)
async function runDownload(ctx, url, { platform, kind } = {}) {
    const meta = PLATFORM_META[platform] || PLATFORM_META.any;
    await react(ctx, '⏳');
    try {
        const isYt = platform === 'youtube' || api.detectPlatform(url) === 'youtube';
        if (isYt && (kind === 'audio' || kind === 'video')) return await runYoutube(ctx, url, kind);
        let info;
        if (isYt) info = await api.youtube(url, { need: kind || 'both' });
        else if (platform === 'twitter') info = await api.twitter(url);
        else if (platform === 'facebook') info = await api.facebook(url);
        else if (platform === 'any') info = await api.downloadAny(url);
        else info = await api.allDownload(url, { prefer: platform === 'tiktok' ? 'v1' : 'v2' });

        const caption = mediaCaption(meta, info);

        if (kind === 'audio') {
            const pick = info.items.find((i) => i.type === 'audio');
            if (!pick) throw new Error('No audio available for that link');
            await deliverItem(ctx, info, pick, caption);
            return react(ctx, '✅');
        }

        if (kind === 'video') {
            const opts = videoOptions(info);
            if (!opts.length) throw new Error('No video available for that link');
            // The API offered several qualities: let the user pick one (reply with a number).
            if (opts.length > 1) {
                const options = opts.slice(0, 8).map((v) => ({ label: String(v.quality || v.label || 'Video').toUpperCase(), value: v.url, item: v }));
                await react(ctx, '✅');
                return askChoice(ctx, {
                    image: info.thumbnail,
                    title: box('VIDEO QUALITY', [`▨ ${registry.smallcaps('Title')} ⟜ ${clip(info.title || 'Video', 50)}`, `▨ ${registry.smallcaps('Found')} ⟜ ${options.length} qualities`]),
                    options,
                }, async (value, messageData) => {
                    try {
                        const chosen = options.find((o) => o.value === value).item;
                        await deliverItem(ctx, info, chosen, caption, messageData);
                        await react(ctx, '✅', messageData.key);
                    } catch (err) {
                        await react(ctx, '❌', messageData.key);
                        await say(ctx, fail(err.message), messageData);
                    }
                });
            }
            await deliverItem(ctx, info, opts[0], caption);
            return react(ctx, '✅');
        }

        // Facebook: one video (plus its audio track) - send the video at once instead of asking
        if (platform === 'facebook' && !kind) {
            const vids = videoOptions(info);
            if (vids.length === 1 && !info.items.some((i) => i.type === 'image')) {
                await deliverItem(ctx, info, vids[0], caption);
                return react(ctx, '✅');
            }
        }

        const choices = buildChoices(info);
        if (!choices.length) throw new Error('Nothing downloadable found');

        const send = async (choice, quoted, key) => {
            for (let i = 0; i < choice.run.length; i++) {
                await deliverItem(ctx, info, choice.run[i], i === 0 ? caption : undefined, quoted);
            }
            await react(ctx, '✅', key);
        };

        if (choices.length === 1) return send(choices[0], ctx.msg);

        const prompt = `${caption}\n\n*Choose what to download:*`;
        const opts = choices.map((c) => ({ label: c.label, value: c.value, title: c.label, description: '' }));
        const picker = choices.length <= 3 ? ctx.helpers.sendInteractiveOptions : ctx.helpers.sendInteractiveList;
        const pickerArgs = { image: await cover(info.thumbnail), caption: prompt, footer: FOOTER_INLINE, buttonText: 'Choose', options: opts, rows: opts };
        let picked;
        try {
            picked = await picker(ctx.socket, ctx.sender, ctx.msg, pickerArgs);
        } catch (e) {
            console.warn('picker with thumbnail failed, retrying without image:', e.message);
            picked = await picker(ctx.socket, ctx.sender, ctx.msg, { ...pickerArgs, image: undefined });
        }
        const { sentMsg, sessionId } = picked;
        ctx.helpers.awaitInteractiveReply(ctx.socket, ctx.sender, sentMsg, sessionId, opts, async (value, messageData) => {
            const choice = choices.find((c) => c.value === value);
            if (!choice) return;
            try {
                await send(choice, messageData, messageData.key);
            } catch (err) {
                console.error(`${meta.name} download error:`, err.message);
                await react(ctx, '❌', messageData.key);
                await say(ctx, fail(err.message), messageData);
            }
        }, { once: false });
    } catch (err) {
        console.error(`${meta.name} command error:`, err.message);
        await react(ctx, '❌');
        await say(ctx, fail(err.message));
    }
}

const linkFrom = (ctx) => api.extractUrl(ctx.args.join(' ')) || api.extractUrl(quotedText(ctx.msg));

// .tiktok / .ig / .fb / .x / .alldownload
function platformCommand(platform, hostCheck) {
    return async (ctx) => {
        const meta = PLATFORM_META[platform];
        const url = linkFrom(ctx);
        if (!url) {
            return say(ctx, withFooter(panel(`${meta.icon} ${meta.name.toUpperCase()}`, ['Send a link or reply to one.', '', `Example: ${ctx.prefix}${meta.usage}`])));
        }
        if (hostCheck && !hostCheck(url)) {
            return say(ctx, fail(`That doesn't look like a ${meta.name} link.`));
        }
        return runDownload(ctx, url, { platform });
    };
}

// Search YouTube and show the top results as a numbered list. Reply with a number to pick one.
async function searchAndPick(ctx, query, onPick, title = 'YOUTUBE SEARCH') {
    await react(ctx, '🔍');
    const res = await yts(query);
    const videos = (res.videos || []).slice(0, 8);
    if (!videos.length) throw new Error('No results found for that search');
    const options = videos.map((v) => ({ label: `${clip(v.title, 55)}  ⟜ ${v.timestamp}`, value: v.url, video: v }));
    await askChoice(ctx, {
        image: videos[0].thumbnail,
        title: box(title, [`▨ ${registry.smallcaps('Query')} ⟜ ${clip(query, 50)}`, `▨ ${registry.smallcaps('Results')} ⟜ ${videos.length}`]),
        options,
    }, async (value, messageData) => {
        const v = options.find((o) => o.value === value)?.video;
        try { await onPick(value, messageData, v); } catch (err) { await react(ctx, '❌', messageData.key); await say(ctx, fail(err.message), messageData); }
    });
    await react(ctx, '✅');
}

// .song / .video - accepts a link or a search phrase (search = numbered list).
function youtubeCommand(kind) {
    return async (ctx) => {
        const query = ctx.args.join(' ').trim() || quotedText(ctx.msg).trim();
        if (!query) {
            return say(ctx, withFooter(panel(kind === 'audio' ? '🎧 YOUTUBE AUDIO' : '🎬 YOUTUBE VIDEO', [
                `Usage: ${ctx.prefix}${kind === 'audio' ? 'song' : 'video'} <name or link>`,
                `Example: ${ctx.prefix}${kind === 'audio' ? 'song faded alan walker' : 'video faded alan walker'}`,
            ])));
        }
        const url = api.extractUrl(query);
        if (url) return runDownload(ctx, url, { platform: 'youtube', kind });
        try {
            await searchAndPick(ctx, query, (videoUrl, messageData) => runDownload({ ...ctx, msg: messageData }, videoUrl, { platform: 'youtube', kind }));
        } catch (err) {
            await react(ctx, '❌');
            await say(ctx, fail(err.message));
        }
    };
}

// .play <name|link> - no search list: three buttons (AUDIO MP3 DOC / AUDIO / VIDEO).
const PLAY_OPTIONS = [
    { label: 'AUDIO MP3 DOC', value: 'doc', title: 'AUDIO MP3 DOC', description: '' },
    { label: 'AUDIO', value: 'audio', title: 'AUDIO', description: '' },
    { label: 'VIDEO', value: 'video', title: 'VIDEO', description: '' },
];

// --- YouTube metadata + search (cached) -------------------------------------------------
const ytCache = new Map(); // key -> { v, ts }
const YT_TTL = 10 * 60 * 1000;
const ytId = (url) => (String(url).match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([\w-]{11})/) || [])[1] || null;
const compact = (n) => (Number.isFinite(n) ? new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n) : '-');

async function ytLookup(query, url) {
    const id = url ? ytId(url) : null;
    const key = id ? `id:${id}` : `q:${query.toLowerCase()}`;
    const hit = ytCache.get(key);
    if (hit && Date.now() - hit.ts < YT_TTL) return hit.v;
    let v = null;
    if (id) { try { v = await yts({ videoId: id }); } catch { v = null; } }
    else { const res = await yts(query); v = (res.videos || [])[0] || null; }
    if (v) {
        ytCache.set(key, { v, ts: Date.now() });
        if (ytCache.size > 200) ytCache.delete(ytCache.keys().next().value);
    }
    return v;
}

// ---------------------------------------------------------------- .song2 / .video2 (ytmp3pc scraper, lib/ytmp3pc.js)
const ytmp3pc = require('./ytmp3pc');
const YT2_HEADERS = { Origin: ytmp3pc.CONFIG.widgetOrigin, Referer: `${ytmp3pc.CONFIG.widgetOrigin}/`, 'User-Agent': ytmp3pc.CONFIG.userAgent };

// One scraper job: list the qualities, pick one, convert, hand back the download link.
function ytmp3pcCandidate(id, kind, wantQ) {
    const type = kind === 'audio' ? 'mp3' : 'mp4';
    return {
        name: `ytmp3pc/${type}`,
        run: async () => {
            const meta = await ytmp3pc.getFormats(id, type);
            const list = Array.isArray(meta?.detail) ? meta.detail.filter((d) => d && d.quality !== undefined) : [];
            if (!list.length) throw new Error(`ytmp3pc: no ${type} qualities for this video`);
            let pick = list[0];
            if (type === 'mp4') {
                const cap = wantQ || config.YT2_VIDEO_MAX || 720;
                const num = (d) => parseInt(String(d.quality).replace(/\D/g, ''), 10) || 0;
                const sorted = [...list].sort((a, b) => num(b) - num(a));
                pick = sorted.find((d) => num(d) && num(d) <= cap) || sorted[sorted.length - 1];
            }
            const conv = await ytmp3pc.convert(id, { type, quality: pick.quality });
            return {
                platform: 'YouTube', title: meta.title || null, author: meta.author || null, duration: meta.duration || null,
                thumbnail: meta.thumbnail || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
                items: [{ type: kind, label: kind === 'audio' ? 'Audio' : `${pick.quality}p`, quality: String(pick.quality), url: conv.downloadUrl, headers: YT2_HEADERS }],
            };
        },
    };
}

// name -> video id: the scraper's own search first, yt-search as the backup
async function ytmp3pcFindId(query) {
    try {
        const res = await ytmp3pc.search(query);
        for (const it of res.items || []) {
            const id = ytmp3pc.extractYouTubeId(String(it?.id || it?.videoId || it?.video_id || it?.vid || '')) || ytmp3pc.extractYouTubeId(String(it?.url || it?.link || ''));
            if (id) return id;
        }
    } catch (err) { console.warn('[ytmp3pc] search failed:', err.message); }
    const v = await ytLookup(query);
    return v?.videoId || null;
}

function ytmp3pcCommand(kind) {
    const cmd = kind === 'audio' ? 'song2' : 'video2';
    return async (ctx) => {
        const args = [...ctx.args];
        let wantQ = null;
        if (kind === 'video' && args.length > 1 && /^\d{3,4}p?$/i.test(args[args.length - 1])) wantQ = parseInt(args.pop(), 10);
        const query = args.join(' ').trim() || quotedText(ctx.msg).trim();
        if (!query) {
            return say(ctx, withFooter(panel(kind === 'audio' ? '🎧 YOUTUBE AUDIO 2' : '🎬 YOUTUBE VIDEO 2', [
                `Usage: ${ctx.prefix}${cmd} <name or link>${kind === 'video' ? ' [quality]' : ''}`,
                `Example: ${ctx.prefix}${cmd} ${kind === 'audio' ? 'faded alan walker' : 'faded alan walker 480'}`,
            ])));
        }
        await react(ctx, '⏳');
        try {
            const url = api.extractUrl(query);
            let id = url ? ytmp3pc.extractYouTubeId(url) : null;
            if (url && !id) throw new Error('That is not a YouTube link');
            if (!id) id = await ytmp3pcFindId(query);
            if (!id) throw new Error('No video found for that search');
            const v = await ytLookup('', `https://youtu.be/${id}`).catch(() => null);
            const meta = { title: v?.title, author: v?.author?.name, duration: v?.timestamp, seconds: v?.seconds };
            await deliverChain(ctx, [ytmp3pcCandidate(id, kind, wantQ)], kind, { captionFor: (info) => mediaCaption(PLATFORM_META.youtube, info), meta });
            return react(ctx, '✅');
        } catch (err) {
            console.error(`[${cmd}]`, err.message);
            await react(ctx, '❌');
            return say(ctx, fail(`${cmd} failed: ${err.message}`));
        }
    };
}

// All the metadata we have, under the SUBZERO YT DOWNLOADER heading.
function ytCaption(v, url, query) {
    const r = (k, val) => `┃ ▨ ${registry.smallcaps(k)} ⟜ ${val}`;
    const lines = [
        r('Title', clip(v?.title || query, 48)),
        v?.author?.name ? r('Channel', clip(v.author.name, 36)) : null,
        v?.timestamp ? r('Duration', v.timestamp) : null,
        Number.isFinite(v?.views) ? r('Views', compact(v.views)) : null,
        (v?.ago || v?.uploadDate) ? r('Published', v.ago || v.uploadDate) : null,
        ytId(url) ? r('Video ID', ytId(url)) : null,
        r('Link', url),
        v?.description ? r('About', clip(String(v.description).replace(/\s+/g, ' ').trim(), 90)) : null,
    ].filter(Boolean);
    return withFooter(`╭${registry.LINE}⟢\n┃ ◈ ${registry.bold('SUBZERO YT DOWNLOADER')}\n┣${registry.LINE}\n${lines.join('\n')}\n┣${registry.LINE}\n┃ ◈ ${registry.smallcaps('Choose a format below')}\n╰${registry.LINE}⟢`);
}

// Audio / video lookups start the moment the menu is requested, so a tap sends almost instantly.
async function playMenu(ctx, url, query, meta, preCover) {
    const v = meta || null;
    // The primary lookups start now, so a tap only has to stream the file.
    const q = v?.title || query;
    const audioCands = api.youtubeCandidates(url, 'audio', { query: q, videoId: ytId(url) });
    const videoCands = api.youtubeCandidates(url, 'video', { videoId: ytId(url) });
    const audioFirst = audioCands[0].run(); audioFirst.catch(() => {});
    const videoFirst = videoCands[0].run(); videoFirst.catch(() => {});
    const dlMeta = { title: v?.title, author: v?.author?.name, duration: v?.timestamp, seconds: v?.seconds };
    const captionFor = (info) => mediaCaption(PLATFORM_META.youtube, info);
    // The song itself starts downloading NOW (lookup + file), while the menu is still on screen, so AUDIO is
    // usually instant. An untouched file is deleted after 4 minutes; a tapped one is consumed (sent + removed).
    const audioHold = { p: raceMedia(audioCands, 'audio', { meta: dlMeta, firstPromise: audioFirst }), used: false };
    audioHold.p.catch(() => {});
    audioHold.p.then((r) => setTimeout(() => { if (!audioHold.used) { audioHold.used = true; r.file.cleanup(); } }, 4 * 60 * 1000)).catch(() => {});
    const takeAudio = () => {
        if (!audioHold.used) { audioHold.used = true; return audioHold.p; }
        return raceMedia(audioCands, 'audio', { meta: dlMeta }); // second tap, or the prefetched file expired
    };
    const sendMode = async (mode, messageData) => {
        if (mode === 'video') return deliverChain(ctx, videoCands, 'video', { quoted: messageData, captionFor, meta: dlMeta, firstPromise: videoFirst });
        let prefetched = takeAudio();
        try { await prefetched; } catch { prefetched = raceMedia(audioCands, 'audio', { meta: dlMeta }); } // prefetch failed: one fresh attempt
        return deliverChain(ctx, audioCands, 'audio', { quoted: messageData, captionFor: mode === 'doc' ? captionFor : undefined, meta: dlMeta, prefetched, asDocument: mode === 'doc' });
    };

    const image = preCover || await cover(v?.thumbnail || v?.image || ytThumb(url));
    const { sentMsg, sessionId } = await ctx.helpers.sendInteractiveOptions(ctx.socket, ctx.sender, ctx.msg, { image, caption: ytCaption(v, url, query), footer: FOOTER_INLINE, options: PLAY_OPTIONS });
    ctx.helpers.awaitInteractiveReply(ctx.socket, ctx.sender, sentMsg, sessionId, PLAY_OPTIONS, async (mode, messageData) => {
        try {
            await react(ctx, '⏳', messageData.key);
            await sendMode(mode, messageData);
            await react(ctx, '✅', messageData.key);
        } catch (err) {
            console.error('play error:', err.message);
            await react(ctx, '❌', messageData.key);
            await say(ctx, fail(err.message), messageData);
        }
    }, { once: false });
}

async function cmdPlay(ctx) {
    const query = ctx.args.join(' ').trim() || quotedText(ctx.msg).trim();
    if (!query) return say(ctx, withFooter(box('PLAY', [`▨ ${registry.smallcaps('Usage')} ⟜ ${ctx.prefix}play <song name or link>`, `▨ ${registry.smallcaps('Example')} ⟜ ${ctx.prefix}play faded alan walker`])));
    react(ctx, '🔍');
    try {
        const url0 = api.extractUrl(query);
        // For a link we already know the id: prefetch the cover while the details load.
        const earlyCover = url0 && ytThumb(url0) ? cover(ytThumb(url0)) : null;
        const v = await ytLookup(query, url0);
        if (!url0 && !v) throw new Error('No results found for that search');
        const url = url0 || v.url;
        await playMenu(ctx, url, query, v, earlyCover ? await earlyCover : undefined);
    } catch (err) {
        await react(ctx, '❌');
        await say(ctx, fail(err.message));
    }
}

// .yts <query> - numbered results; reply with a number to get the AUDIO / VIDEO menu for it.
async function cmdYts(ctx) {
    const query = ctx.args.join(' ').trim() || quotedText(ctx.msg).trim();
    if (!query) return say(ctx, withFooter(box('YOUTUBE SEARCH', [`▨ ${registry.smallcaps('Usage')} ⟜ ${ctx.prefix}yts <query>`])));
    try {
        await searchAndPick(ctx, query, (videoUrl, messageData, v) => playMenu({ ...ctx, msg: messageData }, videoUrl, v?.title || query, v));
    } catch (err) {
        await react(ctx, '❌');
        await say(ctx, fail(err.message));
    }
}

// ---------------------------------------------------------------- LYRICS

async function cmdLyrics(ctx) {
    const query = ctx.args.join(' ').trim();
    if (!query) return say(ctx, withFooter(panel('🎤 LYRICS', [`Usage: ${ctx.prefix}lyrics <song name>`, `Example: ${ctx.prefix}lyrics faded`])));
    await react(ctx, '🔍');
    try {
        const r = await api.lyrics(query);
        const text = String(r.lyrics || '').trim();
        if (!text) throw new Error('No lyrics found for that song');
        const head = panel('🎤 LYRICS', [`🎵 ${r.title}`, `👤 ${r.artist}`]);

        // 1) the lyrics themselves (chunked to stay under WhatsApp's message limit)
        const parts = chunkText(text, 3500);
        for (let i = 0; i < parts.length; i++) {
            await say(ctx, i === 0 ? `${head}\n\n${parts[i]}` : parts[i]);
        }
        // 2) a native-flow message whose "Copy" button puts the whole lyrics on the clipboard
        if (ctx.helpers.isButtonsEnabled()) {
            const b = new Button(ctx.socket)
                .setTitle(`🎤 ${clip(r.title, 40)}`)
                .setBody(`${panel('📋 COPY LYRICS', [`🎵 ${clip(r.title, 40)}`, `👤 ${clip(r.artist, 40)}`])}\n\nTap the button to copy the full lyrics.`)
                .setFooter(FOOTER_INLINE)
                .addCopy('📋 Copy Lyrics', text.slice(0, 4000));
            if (r.url) b.addUrl('🔗 Open Source', r.url);
            await b.send(ctx.sender, { quoted: ctx.msg });
        } else if (r.url) {
            await say(ctx, withFooter(`🔗 ${r.url}`));
        } else {
            await say(ctx, FOOTER);
        }
        await react(ctx, '✅');
    } catch (err) {
        await react(ctx, '❌');
        await say(ctx, fail(err.message));
    }
}

// ---------------------------------------------------------------- AI

const aiEpoch = new Map(); // user -> counter, bumped by .newchat to start a fresh conversation

function aiCommand(modelKey) {
    return async (ctx) => {
        const def = api.AI_MODELS[modelKey];
        const prompt = ctx.args.join(' ').trim() || quotedText(ctx.msg).trim();
        if (!prompt) {
            return say(ctx, withFooter(panel(`🤖 ${def.label.toUpperCase()}`, [`Usage: ${ctx.prefix}${ctx.command} <question>`, `Example: ${ctx.prefix}${ctx.command} explain black holes simply`, '', `Reset memory: ${ctx.prefix}newchat`])));
        }
        await react(ctx, '🤖');
        try {
            const user = digits(ctx.senderNumber) || digits(ctx.nowsender);
            const reply = await api.chat({ message: prompt, userId: `${user}${aiEpoch.get(user) || 0}`, modelKey });
            const parts = chunkText(reply.trim(), 3500);
            for (let i = 0; i < parts.length; i++) {
                const last = i === parts.length - 1;
                const text = i === 0 ? `*🤖 ${def.label}*\n\n${parts[i]}` : parts[i];
                await say(ctx, last ? withFooter(text) : text);
            }
            await react(ctx, '✅');
        } catch (err) {
            await react(ctx, '❌');
            await say(ctx, fail(err.message));
        }
    };
}

async function cmdNewChat(ctx) {
    const user = digits(ctx.senderNumber) || digits(ctx.nowsender);
    aiEpoch.set(user, (aiEpoch.get(user) || 0) + 1);
    await react(ctx, '✅');
    await say(ctx, withFooter(panel('🧹 AI MEMORY', ['Your AI conversations were reset.', 'Start fresh with any AI command.'])));
}

// ---------------------------------------------------------------- SETTINGS (owner / sudo)
// One definition per setting. A definition knows how to read its current value, which values
// are legal and how to apply one - the command handler, status panel and buttons are all
// generated from it, which keeps every owner command identical in behaviour.

const ON = ['on', 'true', 'enable', 'enabled', 'yes', '1'];
const OFF = ['off', 'false', 'disable', 'disabled', 'no', '0'];
const asBool = (v) => (ON.includes(v) ? 'on' : OFF.includes(v) ? 'off' : null);
const isTrue = (v) => String(v).toLowerCase() === 'true';
const flag = (userVal, defVal) => (userVal === undefined || userVal === null ? isTrue(defVal) : isTrue(userVal));
const onOff = (b) => (b ? 'ON ✅' : 'OFF ❌');

const saveConfig = async (ctx, mutate) => {
    const cfg = { ...(await ctx.helpers.loadUserConfig(ctx.sanitizedNumber)) };
    mutate(cfg);
    await ctx.helpers.updateUserConfig(ctx.sanitizedNumber, cfg);
    ctx.userConfig = cfg;
    return cfg;
};

const boolSetting = (cmd, label, icon, key, note) => ({
    cmd, label, icon, note,
    options: ['on', 'off'],
    current: (ctx) => onOff(flag(ctx.userConfig[key], config[key])),
    normalise: asBool,
    apply: (ctx, v) => saveConfig(ctx, (c) => { c[key] = v === 'on' ? 'true' : 'false'; }),
});

const SETTINGS = [
    boolSetting('anticall', 'ANTI-CALL', '📵', 'ANTICALL', 'Rejects incoming calls'),
    boolSetting('autoviewstatus', 'AUTO VIEW STATUS', '👁️', 'AUTO_VIEW_STATUS', 'Views contacts\' statuses'),
    boolSetting('autoreactstatus', 'AUTO REACT STATUS', '❤️', 'AUTO_LIKE_STATUS', 'Reacts to statuses'),
    boolSetting('autorecording', 'AUTO RECORDING', '🎙️', 'AUTO_RECORDING', 'Shows "recording…" presence'),
    {
        cmd: 'alwaysonline', label: 'ALWAYS ONLINE', icon: '🟢', note: 'Keeps the bot showing as online',
        options: ['on', 'off'],
        current: (ctx) => onOff(isTrue(ctx.userConfig.ALWAYS_ONLINE ?? 'false')),
        normalise: asBool,
        apply: async (ctx, v) => {
            const cfg = await saveConfig(ctx, (c) => { c.ALWAYS_ONLINE = v === 'on' ? 'true' : 'false'; });
            if (v === 'on') startPresence(ctx.socket, ctx.sanitizedNumber, cfg);
            else { stopPresence(ctx.sanitizedNumber); await ctx.socket.sendPresenceUpdate('unavailable').catch(() => {}); }
        },
    },
    {
        cmd: 'autoreact', label: 'AUTO REACT', icon: '😎', note: 'Reacts to messages',
        options: ['on', 'off'],
        current: (ctx) => onOff(isTrue(ctx.userConfig.AUTOREACT ?? config.AUTOREACT)),
        normalise: asBool,
        apply: (ctx, v) => saveConfig(ctx, (c) => { c.AUTOREACT = v === 'on' ? 'true' : 'false'; }),
    },
    {
        cmd: 'antiedit', label: 'ANTI-EDIT', icon: '📝', note: 'Shows the original of edited messages',
        options: ['on', 'private', 'owner', 'off'],
        current: (ctx) => {
            const v = fwdMode(ctx.userConfig.ANTIEDIT ?? config.ANTIEDIT ?? 'false');
            return v === 'private' ? 'BOT INBOX 🔒' : v === 'owner' ? 'OWNER INBOX 👤' : v === 'off' ? 'OFF ❌' : 'CHAT 💬';
        },
        normalise: (v) => { const m = fwdMode(v, ''); return m === 'private' ? 'private' : m === 'owner' ? 'owner' : m === 'chat' ? 'on' : m === 'off' ? 'off' : v; },
        apply: (ctx, v) => saveConfig(ctx, (c) => { c.ANTIEDIT = v === 'on' ? 'chat' : v === 'private' ? 'private' : v === 'owner' ? 'owner' : 'false'; }),
    },
    {
        cmd: 'mode', label: 'BOT MODE', icon: '🔐', note: 'public = everyone, private = owner & sudo',
        options: ['public', 'private'],
        current: (ctx) => String(ctx.userConfig.MODE || config.MODE).toUpperCase(),
        normalise: (v) => (v === 'public' || v === 'private' ? v : null),
        apply: (ctx, v) => saveConfig(ctx, (c) => { c.MODE = v; }),
    },
    {
        cmd: 'buttons', label: 'BUTTON MODE', icon: '🔘', note: 'Interactive buttons (applies to every session)',
        options: ['on', 'off'],
        current: () => onOff(isTrue(config.BUTTON_MODE)),
        normalise: asBool,
        apply: async (ctx, v) => {
            config.BUTTON_MODE = v === 'on' ? 'true' : 'false';
            process.env.BUTTON_MODE = config.BUTTON_MODE;
            await saveConfig(ctx, (c) => { c.BUTTON_MODE = config.BUTTON_MODE; });
        },
    },
];
const SETTING_BY_CMD = {};
const SETTING_ALIASES = {
    antical: 'anticall', viewstatus: 'autoviewstatus', reactstatus: 'autoreactstatus',
    setautorecording: 'autorecording', ae: 'antiedit', buttonmode: 'buttons', online: 'alwaysonline', botonline: 'alwaysonline',
};
SETTINGS.forEach((s) => { SETTING_BY_CMD[s.cmd] = s; });

async function cmdSetting(ctx) {
    if (await denyUnlessManager(ctx)) return;
    const def = SETTING_BY_CMD[SETTING_ALIASES[ctx.command] || ctx.command];
    const p = ctx.prefix;
    const arg = (ctx.args[0] || '').toLowerCase();

    if (arg) {
        const value = def.normalise(arg);
        if (!value || !def.options.includes(value)) {
            return say(ctx, fail(`Use: ${p}${def.cmd} ${def.options.join(' | ')}`));
        }
        await def.apply(ctx, value);
        await react(ctx, '✅');
        return say(ctx, withFooter(panel(`${def.icon} ${def.label}`, ['✅ Updated', `Now : ${def.current(ctx)}`])));
    }

    const body = panel(`${def.icon} ${def.label}`, [
        `Status : ${def.current(ctx)}`,
        ...(def.note ? [`Info   : ${def.note}`] : []),
        `Use    : ${p}${def.cmd} ${def.options.join(' | ')}`,
    ]);
    const labels = { on: '✅ ENABLE', off: '❌ DISABLE', private: '🔒 PRIVATE', public: '🔓 PUBLIC' };
    return sendButtons(ctx, {
        image: ctx.config.RCD_IMAGE_PATH, title: def.label, body,
        buttons: def.options.map((o) => ({ type: 'reply', label: labels[o] || o.toUpperCase(), value: `${p}${def.cmd} ${o}` })),
    });
}

// Where forwarded deleted / edited messages go: chat (same chat) | private (bot's own inbox) | owner (owner number)
const fwdMode = (v, fallback = 'chat') => {
    const x = String(v ?? '').toLowerCase().trim();
    if (x === 'owner') return 'owner';
    if (['private', 'bot', 'inbox', 'me'].includes(x)) return 'private';
    if (['chat', 'true', 'on', 'yes', '1', 'here', 'same'].includes(x)) return 'chat';
    if (['false', 'off', 'no', '0', 'none'].includes(x)) return 'off';
    return fallback;
};
const FWD_LABEL = { chat: 'CHAT 💬 (same chat)', private: 'BOT INBOX 🔒 (paired number)', owner: 'OWNER INBOX 👤 (owner number)' };

// .antidelete on|off | gc|dm|status [on|off] | chat|private|owner
async function cmdAntiDelete(ctx) {
    if (await denyUnlessManager(ctx)) return;
    const p = ctx.prefix;
    const a = (ctx.args[0] || '').toLowerCase();
    const b = (ctx.args[1] || '').toLowerCase();
    const targets = ['gc', 'dm', 'status'];

    const statusPanel = async () => {
        const s = await getAllAnti();
        const mode = fwdMode(ctx.userConfig.ANTIDELETE ?? config.ANTIDELETE ?? 'chat') === 'off' ? 'chat' : fwdMode(ctx.userConfig.ANTIDELETE ?? config.ANTIDELETE ?? 'chat');
        const body = panel('🗑️ ANTI-DELETE', [
            `Groups   : ${onOff(s.gc)}`,
            `DMs      : ${onOff(s.dm)}`,
            `Status   : ${onOff(s.status)}`,
            `Sends to : ${FWD_LABEL[mode]}`,
            '',
            `${p}antidelete on | off`,
            `${p}antidelete gc | dm | status  on | off`,
            `${p}antidelete chat | private | owner`,
        ]);
        return sendButtons(ctx, {
            image: ctx.config.RCD_IMAGE_PATH, title: 'ANTI-DELETE', body,
            buttons: [
                { type: 'reply', label: '✅ ALL ON', value: `${p}antidelete on` },
                { type: 'reply', label: '❌ ALL OFF', value: `${p}antidelete off` },
                { type: 'reply', label: '💬 SEND TO CHAT', value: `${p}antidelete chat` },
                { type: 'reply', label: '🔒 SEND TO BOT INBOX', value: `${p}antidelete private` },
                { type: 'reply', label: '👤 SEND TO OWNER', value: `${p}antidelete owner` },
            ],
        });
    };

    if (!a) return statusPanel();
    if (asBool(a)) { await setAllAnti(asBool(a) === 'on'); }
    else if (targets.includes(a)) {
        const cur = await getAnti(a);
        await setAnti(a, b ? asBool(b) === 'on' : !cur); // no value = toggle
    } else if (['chat', 'private', 'bot', 'owner'].includes(a)) {
        await saveConfig(ctx, (c) => { c.ANTIDELETE = a === 'bot' ? 'private' : a; });
    } else {
        return say(ctx, fail(`Unknown option "${a}". Send ${p}antidelete to see the options.`));
    }
    await react(ctx, '✅');
    return statusPanel();
}

// .antilink on|off - per group, group admins
async function cmdAntiLink(ctx) {
    const p = ctx.prefix;
    if (!ctx.isGroup) return say(ctx, fail('This command only works in groups.'));
    if (!ctx.isAdmins) return say(ctx, withFooter(panel('📛 ACCESS DENIED', ['Only group admins can use this.'])));
    if (!ctx.isBotAdmin) return say(ctx, fail('Make the bot an admin first - it needs that to delete links.'));
    const a = asBool((ctx.args[0] || '').toLowerCase());
    if (a) {
        await setAntiLink(ctx.from, a === 'on');
        await react(ctx, '✅');
    }
    const now = await getAntiLink(ctx.from);
    const body = panel('🔗 ANTI-LINK', [
        `Status : ${onOff(now)}`,
        'Info   : Deletes links and removes the sender (admins exempt).',
        `Use    : ${p}antilink on | off`,
    ]);
    return sendButtons(ctx, {
        image: ctx.config.RCD_IMAGE_PATH, title: 'ANTI-LINK', body,
        buttons: [
            { type: 'reply', label: '✅ ENABLE', value: `${p}antilink on` },
            { type: 'reply', label: '❌ DISABLE', value: `${p}antilink off` },
        ],
    });
}

// .setprefix <new>   (and .setprefix reset)
async function cmdSetPrefix(ctx) {
    if (await denyUnlessManager(ctx)) return;
    const p = ctx.prefix;
    const next = ctx.args[0];
    if (!next) {
        return say(ctx, withFooter(panel('📌 PREFIX', [`Current : ${p}`, `Use     : ${p}setprefix <1-3 characters>`, `Example : ${p}setprefix !`, `Reset   : ${p}setprefix reset`])));
    }
    const value = next.toLowerCase() === 'reset' ? config.PREFIX : next;
    if (value.length > 3 || /\s/.test(value)) return say(ctx, fail('A prefix must be 1-3 characters with no spaces.'));
    await saveConfig(ctx, (c) => { c.PREFIX = value; });
    await react(ctx, '✅');
    // Reply uses the NEW prefix so the owner can test it straight away.
    return say(ctx, withFooter(panel('📌 PREFIX CHANGED', [`New prefix : ${value}`, `Try        : ${value}menu`, `Old prefix "${p}" no longer works.`])));
}

// .settings - everything at a glance
const stripEmoji = (t) => String(t).replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\uFE0F]/gu, '').replace(/\s+/g, ' ').trim();

// The value a tap on a setting would switch to (cycles through its options).
function nextValue(d, ctx) {
    const cur = String(d.current(ctx)).toLowerCase();
    const idx = d.options.findIndex((o) => cur.includes(o) || (o === 'on' && /chat/.test(cur)));
    return d.options[(idx + 1) % d.options.length];
}

async function cmdSettings(ctx) {
    if (await denyUnlessManager(ctx)) return;
    const p = ctx.prefix;
    await react(ctx, '⚙️');
    const s = await getAllAnti();
    const flag = (v) => (v ? 'ON' : 'OFF');
    const status = [
        `▨ ${registry.smallcaps('Prefix')} ⟜ ${p}`,
        ...SETTINGS.map((d) => `▨ ${registry.smallcaps(d.label)} ⟜ ${stripEmoji(d.current(ctx))}`),
        `▨ ${registry.smallcaps('Anti Delete')} ⟜ GC ${flag(s.gc)} DM ${flag(s.dm)} ST ${flag(s.status)}`,
    ];

    if (!ctx.helpers.isButtonsEnabled()) {
        const how = SETTINGS.map((d) => `▣ ${p}${d.cmd} ⟜ ${d.options.join(' | ')}`);
        return say(ctx, withFooter(`${box('BOT SETTINGS', status)}\n\n${box('CHANGE', [`▣ ${p}setprefix <new>`, ...how, `▣ ${p}antidelete on | off`])}`));
    }

    const btn = new Button(ctx.socket)
        .setImage(menuImage(ctx))
        .setTitle(registry.bold('BOT SETTINGS'))
        .setBody(`${box('BOT SETTINGS', status)}\n\n◈ ${registry.smallcaps('Tap Change Settings to switch one')}`)
        .setFooter(FOOTER_INLINE)
        .addSelection('Change Settings')
        .makeSection('Switches', 'tap = switch to the next value');
    SETTINGS.forEach((d) => btn.makeRow('', d.label, `Now ${stripEmoji(d.current(ctx))}  |  next ${nextValue(d, ctx).toUpperCase()}`, `${p}${d.cmd} ${nextValue(d, ctx)}`));
    btn.makeSection('Anti Delete', 'all chats, DMs and statuses')
        .makeRow('', 'Anti Delete ON', 'Forward deleted messages', `${p}antidelete on`)
        .makeRow('', 'Anti Delete OFF', 'Stop forwarding', `${p}antidelete off`)
        .makeSection('More', 'other owner tools')
        .makeRow('', 'Presence', 'Online / typing / recording', `${p}presence`)
        .makeRow('', 'Menu Image', 'Change the menu picture', `${p}setmenuimage`)
        .makeRow('', 'Owner Menu', 'All owner commands', `${p}ownermenu`)
        .addReply('Owner Menu', `${p}ownermenu`)
        .addReply('All Menu', `${p}allmenu`);
    await btn.send(ctx.sender, { quoted: ctx.ai });
}

// .owner - who runs this bot, with tap-to-chat / copy buttons.
async function cmdOwner(ctx) {
    await react(ctx, '👑');
    const p = ctx.prefix;
    const superNum = digits((config.SUPER_OWNERS || [])[0] || config.OWNER_NUMBER);
    const botNum = digits(ctx.socket.user?.id);
    const lines = [
        `▨ ${registry.smallcaps('Developer')} ⟜ ${registry.bold('MR FRANK OFC')}`,
        `▨ ${registry.smallcaps('Contact')} ⟜ +${superNum}`,
        `▨ ${registry.smallcaps('Bot owner')} ⟜ +${botNum}`,
        `▨ ${registry.smallcaps('Website')} ⟜ ${SITE}`,
        `▨ ${registry.smallcaps('Buy a bot')} ⟜ message Mr Frank`,
    ];
    const vcard = ['BEGIN:VCARD', 'VERSION:3.0', 'FN:Mr Frank OFC', 'ORG:Subzero MD Mini;', `TEL;type=CELL;type=VOICE;waid=${superNum}:+${superNum}`, 'END:VCARD'].join('\n');

    if (ctx.helpers.isButtonsEnabled()) {
        await new Button(ctx.socket)
            .setImage(menuImage(ctx))
            .setTitle(registry.bold('OWNER'))
            .setBody(box('OWNER INFO', lines))
            .setFooter(FOOTER_INLINE)
            .addUrl('Chat With Mr Frank', `https://wa.me/${superNum}`)
            .addCopy('Copy Number', `+${superNum}`)
            .addUrl('Website', `https://${SITE}`)
            .addReply('Menu', `${p}menu`)
            .send(ctx.sender, { quoted: ctx.ai });
    } else {
        await ctx.socket.sendMessage(ctx.sender, { image: imgPayload(menuImage(ctx)), caption: withFooter(box('OWNER INFO', lines)), ...LABEL() }, { quoted: ctx.ai });
    }
    await ctx.socket.sendMessage(ctx.sender, { contacts: { displayName: 'Mr Frank OFC', contacts: [{ vcard }] } }, { quoted: ctx.msg });
}

// ---------------------------------------------------------------- SUDO / BAN / BLOCK

// Who does this command mean? reply > @mention > typed number > (in a DM) the other person.
function resolveTarget(ctx) {
    const ci = ctx.msg.message?.extendedTextMessage?.contextInfo;
    if (ci?.mentionedJid?.length) return ci.mentionedJid[0];
    if (ci?.quotedMessage && ci.participant) return ci.participant;
    const typed = ctx.args.join('').replace(/[^0-9]/g, ''); // tolerates "+263 77 123 4567"
    if (typed.length >= 7) return `${typed}@s.whatsapp.net`;
    if (!ctx.isGroup) return ctx.sender;
    return null;
}

const protectedIds = (ctx) => new Set([digits(config.OWNER_NUMBER), digits(config.DEV), digits(ctx.socket.user?.id)]);

function listAdd(file, title, verb, { ownerOnly = true, guardOwner = false } = {}) {
    return async (ctx) => {
        if (ownerOnly ? await denyUnlessOwner(ctx) : await denyUnlessManager(ctx)) return;
        const target = resolveTarget(ctx);
        if (!target) return say(ctx, fail('Reply to a user, @mention them, or type their number.'));
        if (guardOwner && protectedIds(ctx).has(digits(target))) return say(ctx, fail('You cannot do that to the owner or the bot itself.'));
        const list = readList(file);
        if (list.some((e) => digits(e) === digits(target))) return say(ctx, fail(`@${digits(target)} is already ${verb}.`));
        writeList(file, [...list, target]);
        await react(ctx, '✅');
        return ctx.socket.sendMessage(ctx.sender, {
            text: withFooter(panel(title, [`✅ @${digits(target)} is now ${verb}.`])), mentions: [target],
        }, { quoted: ctx.msg });
    };
}
function listRemove(file, title, verb, { ownerOnly = true } = {}) {
    return async (ctx) => {
        if (ownerOnly ? await denyUnlessOwner(ctx) : await denyUnlessManager(ctx)) return;
        const target = resolveTarget(ctx);
        if (!target) return say(ctx, fail('Reply to a user, @mention them, or type their number.'));
        const list = readList(file);
        if (!list.some((e) => digits(e) === digits(target))) return say(ctx, fail(`@${digits(target)} is not ${verb}.`));
        writeList(file, list.filter((e) => digits(e) !== digits(target)));
        await react(ctx, '✅');
        return ctx.socket.sendMessage(ctx.sender, {
            text: withFooter(panel(title, [`✅ @${digits(target)} removed.`])), mentions: [target],
        }, { quoted: ctx.msg });
    };
}
function listShow(file, title, empty) {
    return async (ctx) => {
        if (await denyUnlessOwner(ctx)) return;
        const list = [...new Set(readList(file))];
        const lines = list.length ? list.map((e, i) => `${i + 1}. ${digits(e)}`) : [empty];
        await react(ctx, '📋');
        return say(ctx, withFooter(panel(title, lines)));
    };
}

const blockCommand = (action) => async (ctx) => {
    if (await denyUnlessManager(ctx)) return;
    const target = resolveTarget(ctx);
    if (!target) return say(ctx, fail('In a group, reply to or @mention the user.'));
    if (action === 'block' && protectedIds(ctx).has(digits(target))) return say(ctx, fail('You cannot block the owner or the bot itself.'));
    try {
        await ctx.socket.updateBlockStatus(target, action);
        await react(ctx, '✅');
        return ctx.socket.sendMessage(ctx.sender, {
            text: withFooter(panel(action === 'block' ? '🚫 BLOCKED' : '✅ UNBLOCKED', [`@${digits(target)}`])), mentions: [target],
        }, { quoted: ctx.msg });
    } catch (err) {
        return say(ctx, fail(err.message));
    }
};

// ---------------------------------------------------------------- BUY (.repo and friends)

async function cmdBuy(ctx) {
    await react(ctx, '🛒');
    const owner = digits(config.OWNER_NUMBER);
    const waLink = `https://wa.me/${owner}?text=${encodeURIComponent('Hi Mr Frank, I want to buy Subzero MD Mini.')}`;
    const body = panel('🛒 𝐒𝐔𝐁𝐙𝐄𝐑𝐎 𝐌𝐃 𝐌𝐈𝐍𝐈', [
        'The source code is private.',
        'Want your own bot? It is sold',
        'directly by Mr Frank.',
        '',
        '💬 Send Mr Frank a message to buy:',
        `   wa.me/${owner}`,
        `🌐 ${SITE}`,
    ]);
    await sendButtons(ctx, {
        image: menuImage(ctx),
        title: 'BUY SUBZERO MD MINI',
        body,
        buttons: [
            { type: 'url', label: '💬 Message Mr Frank', value: waLink },
            { type: 'url', label: '🌐 Website', value: SITE_URL },
            { type: 'reply', label: '👑 Owner', value: `${ctx.prefix}owner` },
        ],
    });
}

// ---------------------------------------------------------------- VIEW-ONCE TEXT

const xmlEscape = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function wrapLines(text, width) {
    const lines = [];
    text.split('\n').forEach((para) => {
        let line = '';
        para.split(/\s+/).forEach((word) => {
            while (word.length > width) { if (line) { lines.push(line); line = ''; } lines.push(word.slice(0, width)); word = word.slice(width); }
            if (!line) line = word;
            else if ((line + ' ' + word).length <= width) line += ' ' + word;
            else { lines.push(line); line = word; }
        });
        lines.push(line);
    });
    return lines;
}

// WhatsApp only has "view once" for media, so the text is rendered onto a card and sent as a
// view-once image: the receiver can open it exactly one time.
async function cmdViewOnceText(ctx) {
    const text = (ctx.args.join(' ').trim() || quotedText(ctx.msg).trim()).slice(0, 700);
    if (!text) {
        return say(ctx, withFooter(panel('👁️ VIEW-ONCE TEXT', [`Usage: ${ctx.prefix}vot <your text>`, 'or reply to a text with the command.', 'Sends it as a one-time view message.'])));
    }
    await react(ctx, '⏳');
    try {
        let sharp;
        try { sharp = require('sharp'); } catch { sharp = null; }
        if (!sharp) {
            await ctx.socket.sendMessage(ctx.sender, { text, viewOnce: true }, { quoted: ctx.msg });
            return react(ctx, '✅');
        }
        const lines = wrapLines(text, 28);
        const size = 42, lh = 58, pad = 70, width = 900;
        const height = Math.max(420, pad * 2 + lines.length * lh + 70);
        const tspans = lines.map((l, i) => `<text x="${width / 2}" y="${pad + 40 + i * lh}" text-anchor="middle" font-size="${size}" fill="#ffffff" font-family="DejaVu Sans, Arial, Helvetica, sans-serif">${xmlEscape(l)}</text>`).join('');
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0f2027"/><stop offset="0.5" stop-color="#203a43"/><stop offset="1" stop-color="#2c5364"/></linearGradient></defs>
<rect width="100%" height="100%" rx="36" fill="url(#g)"/>
${tspans}
<text x="${width / 2}" y="${height - 34}" text-anchor="middle" font-size="22" fill="#9fb8c4" font-family="DejaVu Sans, Arial, sans-serif">👁 view once • ${SITE}</text>
</svg>`;
        const png = await sharp(Buffer.from(svg)).png().toBuffer();
        await ctx.socket.sendMessage(ctx.sender, { image: png, viewOnce: true, caption: '' }, { quoted: ctx.msg });
        await react(ctx, '✅');
    } catch (err) {
        await react(ctx, '❌');
        await say(ctx, fail(err.message));
    }
}

// ---------------------------------------------------------------- PRESENCE

const presenceTimers = new Map(); // bot number -> interval

function stopPresence(number) {
    const t = presenceTimers.get(number);
    if (t) { clearInterval(t); presenceTimers.delete(number); }
}

// Keep the account showing "online". WhatsApp drops presence after a while, so we re-assert it.
function startPresence(socket, number, cfg = {}) {
    stopPresence(number);
    if (String(cfg.ALWAYS_ONLINE).toLowerCase() !== 'true') return;
    const ping = () => socket.sendPresenceUpdate('available').catch(() => {});
    ping();
    presenceTimers.set(number, setInterval(ping, 25000));
}

const PRESENCE_MAP = {
    online: 'available', available: 'available',
    offline: 'unavailable', unavailable: 'unavailable',
    typing: 'composing', composing: 'composing',
    recording: 'recording', paused: 'paused',
};

const PRESENCE_ROWS = [
    ['online', 'Online', 'Show the bot as online now'],
    ['offline', 'Offline', 'Show the bot as offline now'],
    ['typing', 'Typing', 'Show "typing..." in this chat'],
    ['recording', 'Recording', 'Show "recording audio..." in this chat'],
    ['paused', 'Paused', 'Clear typing / recording in this chat'],
    ['auto on', 'Auto Online ON', 'Stay online all the time'],
    ['auto off', 'Auto Online OFF', 'Stop staying online'],
];

const lastPresence = new Map(); // bot number -> last mode chosen

async function cmdPresence(ctx) {
    if (await denyUnlessManager(ctx)) return;
    const p = ctx.prefix;
    let choice = (ctx.args[0] || '').toLowerCase();
    const auto = isTrue(ctx.userConfig.ALWAYS_ONLINE ?? 'false');

    // .presence auto on|off  (same switch as .alwaysonline)
    if (choice === 'auto' || choice === 'always') {
        const v = (ctx.args[1] || '').toLowerCase();
        if (!['on', 'off'].includes(v)) return say(ctx, withFooter(box('PRESENCE', [`▨ ${registry.smallcaps('Usage')} ⟜ ${p}presence auto on | off`])));
        const cfg = await saveConfig(ctx, (c) => { c.ALWAYS_ONLINE = v === 'on' ? 'true' : 'false'; });
        if (v === 'on') startPresence(ctx.socket, ctx.sanitizedNumber, cfg);
        else { stopPresence(ctx.sanitizedNumber); await ctx.socket.sendPresenceUpdate('unavailable').catch(() => {}); }
        lastPresence.set(ctx.number, v === 'on' ? 'online' : 'offline');
        await react(ctx, '✅');
        return say(ctx, withFooter(box('PRESENCE', [`▨ ${registry.smallcaps('Auto Online')} ⟜ ${v === 'on' ? 'ON' : 'OFF'}`])));
    }

    const mapped = PRESENCE_MAP[choice];
    if (!mapped) {
        const current = String(lastPresence.get(ctx.number) || (auto ? 'online' : 'unknown')).toUpperCase();
        const status = [
            `▨ ${registry.smallcaps('Current')} ⟜ ${current}`,
            `▨ ${registry.smallcaps('Auto Online')} ⟜ ${auto ? 'ON' : 'OFF'}`,
        ];
        if (!ctx.helpers.isButtonsEnabled()) {
            const list = PRESENCE_ROWS.map(([k, t, d]) => `▣ ${p}presence ${k}  ⟜ ${d}`);
            return say(ctx, withFooter(`${box('PRESENCE', status)}\n\n${box('MODES', list)}`));
        }
        const btn = new Button(ctx.socket)
            .setImage(menuImage(ctx))
            .setTitle(registry.bold('PRESENCE'))
            .setBody(`${box('PRESENCE', status)}\n\n◈ ${registry.smallcaps('Pick a mode below')}`)
            .setFooter(FOOTER_INLINE)
            .addSelection('Select Presence')
            .makeSection('Presence Modes', 'SUBZERO MD');
        PRESENCE_ROWS.forEach(([k, t, d]) => btn.makeRow('', `◈ ${registry.smallcaps(t)}`, d, `${p}presence ${k}`));
        return btn.send(ctx.sender, { quoted: ctx.msg });
    }

    // typing / recording / paused are per chat; online / offline are account-wide
    if (mapped === 'available' || mapped === 'unavailable') await ctx.socket.sendPresenceUpdate(mapped);
    else await ctx.socket.sendPresenceUpdate(mapped, ctx.sender);
    lastPresence.set(ctx.number, choice);
    await react(ctx, '✅');
    return say(ctx, withFooter(box('PRESENCE', [
        `▨ ${registry.smallcaps('Set to')} ⟜ ${choice.toUpperCase()}`,
        ...(mapped === 'unavailable' ? ['▨ WhatsApp may flip it back when the bot sends a message'] : []),
    ])));
}

// ---------------------------------------------------------------- LOCK / UNLOCK (super owner only)
// A locked bot ignores every command. Its paired owner is told to contact Mr Frank to unlock it.

const LOCK_FILE = path.join(__dirname, '..', 'data', 'locked.json');
// cached in memory: isLocked() runs for every command of every bot, it used to read the file each time
let lockedCache = null;
const readLocked = () => {
    if (lockedCache) return lockedCache;
    try { lockedCache = (JSON.parse(fs.readFileSync(LOCK_FILE, 'utf-8')) || []).map(digits); } catch { lockedCache = []; }
    return lockedCache;
};
const writeLocked = (list) => {
    fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
    fs.writeFileSync(LOCK_FILE, JSON.stringify([...new Set(list)], null, 2));
    lockedCache = [...new Set(list)].map(digits);
};
const isLocked = (number) => readLocked().includes(digits(number));

const lockNotified = new Map(); // bot number -> last notice time (so the owner is not spammed)
async function lockNotice(socket, sender, msg, number) {
    const last = lockNotified.get(number) || 0;
    if (Date.now() - last < 60000) return;
    lockNotified.set(number, Date.now());
    await socket.sendMessage(sender, { text: withFooter(box('BOT LOCKED', [`▨ ${config.LOCK_MESSAGE}`])) }, { quoted: msg }).catch(() => {});
}

async function cmdLock(ctx) {
    if (!ctxSuper(ctx)) return;
    const target = digits(resolveTarget({ ...ctx, isGroup: false, sender: '' }) || '');
    const typed = ctx.args.join('').replace(/\D/g, '');
    const number = typed.length >= 7 ? typed : target;
    if (!number || number.length < 7) return say(ctx, withFooter(box('LOCK', [`▨ ${registry.smallcaps('Usage')} ⟜ ${ctx.prefix}lock <number>`, `▨ ${registry.smallcaps('Undo')} ⟜ ${ctx.prefix}unlock <number>`, `▨ ${registry.smallcaps('List')} ⟜ ${ctx.prefix}locklist`])));
    if (superSet().has(number)) return say(ctx, fail('You cannot lock a super owner.'));
    const list = readLocked();
    if (list.includes(number)) return say(ctx, fail(`${number} is already locked.`));
    writeLocked([...list, number]);
    await react(ctx, '✅');
    return say(ctx, withFooter(box('LOCK', [`▨ ${registry.smallcaps('Locked')} ⟜ ${number}`, '▨ Their bot now ignores every command.'])));
}

async function cmdUnlock(ctx) {
    if (!ctxSuper(ctx)) return;
    const typed = ctx.args.join('').replace(/\D/g, '');
    if (typed.length < 7) return say(ctx, withFooter(box('UNLOCK', [`▨ ${registry.smallcaps('Usage')} ⟜ ${ctx.prefix}unlock <number>`])));
    const list = readLocked();
    if (!list.includes(typed)) return say(ctx, fail(`${typed} is not locked.`));
    writeLocked(list.filter((n) => n !== typed));
    lockNotified.delete(typed);
    await react(ctx, '✅');
    return say(ctx, withFooter(box('UNLOCK', [`▨ ${registry.smallcaps('Unlocked')} ⟜ ${typed}`])));
}

async function cmdLockList(ctx) {
    if (!ctxSuper(ctx)) return;
    const list = readLocked();
    return say(ctx, withFooter(box('LOCKED BOTS', list.length ? list.map((n) => `▣ ${n}`) : ['▨ None'])));
}

// ---------------------------------------------------------------- .> / .exec (super owner only)
// Runs JavaScript inside the bot process. Only super owners may use it: it can reach every session.

async function cmdExec(ctx) {
    if (!ctxSuper(ctx)) return;
    let code = String(ctx.body || '').trim();
    if (code.startsWith(ctx.prefix)) code = code.slice(ctx.prefix.length);
    code = code.replace(/^(exec|>)\s?/i, '').trim().replace(/^```(?:js|javascript)?\n?|```$/g, '').trim();
    if (!code) return say(ctx, withFooter(box('EXEC', [`▨ ${registry.smallcaps('Usage')} ⟜ ${ctx.prefix}> <javascript>`, `▨ ${registry.smallcaps('Example')} ⟜ ${ctx.prefix}> 1 + 1`, '▨ Multi-line and await are supported.'])));

    const logs = [];
    const fmt = (v) => (typeof v === 'string' ? v : util.inspect(v, { depth: 2 }));
    const fakeConsole = { ...console, log: (...a) => logs.push(a.map(fmt).join(' ')), error: (...a) => logs.push(a.map(fmt).join(' ')), warn: (...a) => logs.push(a.map(fmt).join(' ')) };
    let baileys = {};
    try { baileys = require('baileys'); } catch { /* optional */ }
    const sandbox = {
        ctx, socket: ctx.socket, sock: ctx.socket, conn: ctx.socket, m: ctx.m, msg: ctx.msg,
        from: ctx.from, sender: ctx.sender, args: ctx.args, q: ctx.q, config, api,
        activeSockets: ctx.helpers.activeSockets, axios: require('axios'), fs, os, path, util,
        proto: baileys.proto, generateWAMessageFromContent: baileys.generateWAMessageFromContent,
        require, process, console: fakeConsole,
    };
    const keys = Object.keys(sandbox);
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    let fn;
    try { fn = new AsyncFunction(...keys, `return (\n${code}\n);`); } catch { fn = new AsyncFunction(...keys, code); }

    try {
        const result = await fn(...Object.values(sandbox));
        const parts = [];
        if (logs.length) parts.push(logs.join('\n'));
        if (result !== undefined || !logs.length) parts.push(fmt(result));
        await say(ctx, withFooter(`◈ ${registry.smallcaps('RESULT')}\n\`\`\`\n${parts.join('\n').slice(0, 3600)}\n\`\`\``));
        await react(ctx, '✅');
    } catch (err) {
        await react(ctx, '❌');
        await say(ctx, withFooter(`◈ ${registry.smallcaps('ERROR')}\n\`\`\`\n${String(err.stack || err.message).slice(0, 1800)}\n\`\`\``));
    }
}

// ---------------------------------------------------------------- MENU IMAGE

async function cmdSetMenuImage(ctx) {
    if (await denyUnlessManager(ctx)) return;
    const arg = ctx.args.join(' ').trim();
    const p = ctx.prefix;
    if (['reset', 'default'].includes(arg.toLowerCase())) {
        await saveConfig(ctx, (c) => { delete c.MENU_IMAGE; });
        await react(ctx, '✅');
        return say(ctx, withFooter(box('MENU IMAGE', ['▨ Reset to the default image.'])));
    }
    let value = api.extractUrl(arg);
    if (value) {
        try {
            const head = await require('axios').head(value, { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' }, validateStatus: () => true });
            const ct = String(head.headers['content-type'] || '');
            if (head.status < 400 && ct && !/^image\//i.test(ct)) return say(ctx, fail('That link is not an image.'));
        } catch { /* some hosts block HEAD - accept the link and let WhatsApp fetch it */ }
    } else {
        const quoted = ctx.m?.quoted;
        const source = quoted && /image/i.test(quoted.type || quoted.mtype || '') ? quoted
            : /image/i.test(ctx.m?.type || ctx.m?.mtype || '') ? ctx.m : null;
        if (!source || typeof source.download !== 'function') {
            return say(ctx, withFooter(box('MENU IMAGE', [
                `▨ ${registry.smallcaps('Reply to an image')} ⟜ ${p}setmenuimage`,
                `▨ ${registry.smallcaps('Or send a link')} ⟜ ${p}setmenuimage https://...`,
                `▨ ${registry.smallcaps('Back to default')} ⟜ ${p}setmenuimage reset`,
            ])));
        }
        const buffer = await source.download();
        if (!buffer || !buffer.length) throw new Error('Could not download that image');
        const dir = path.join(__dirname, '..', 'data', 'menu-images');
        fs.mkdirSync(dir, { recursive: true });
        value = path.join(dir, `${digits(ctx.sanitizedNumber)}-${Date.now()}.jpg`);
        fs.readdirSync(dir).filter((f) => f.startsWith(`${digits(ctx.sanitizedNumber)}-`)).forEach((f) => fs.unlink(path.join(dir, f), () => {}));
        fs.writeFileSync(value, buffer);
    }
    await saveConfig(ctx, (c) => { c.MENU_IMAGE = value; });
    await react(ctx, '✅');
    await ctx.socket.sendMessage(ctx.sender, { image: imgPayload(menuImage({ userConfig: { MENU_IMAGE: value } })), caption: withFooter(box('MENU IMAGE', ['▨ Updated. This is your new menu image.', `▨ Try ${p}menu`])) }, { quoted: ctx.msg });
}

// ---------------------------------------------------------------- routing table

const routes = new Map();
const route = (names, fn) => names.forEach((n) => routes.set(n, fn));

route(['menu'], cmdMenu);
route(['allmenu', 'menuall', 'commands', 'help'], cmdAllMenu);
registry.allMenuNames().forEach((n) => route([n], cmdCategoryMenu));
route(['alive'], cmdAlive);
route(['repo', 'source', 'sourcecode', 'code', 'buy'], cmdBuy);
route(['vot', 'viewoncetext', 'vtext'], cmdViewOnceText);
route(['presence', 'setpresence'], cmdPresence);
route(['owner', 'creator', 'dev', 'developer'], cmdOwner);
route(['lock'], cmdLock);
route(['unlock'], cmdUnlock);
route(['locklist', 'lockedbots'], cmdLockList);
route(['>', 'exec'], cmdExec);
route(['setmenuimage', 'menuimage', 'setmenupic'], cmdSetMenuImage);

// round 9: getmsg/try, gcstatus, bot profile, privacy + presence
const extras = require('./extras')({ saveConfig, resolveTarget, box, say, react, fail, withFooter, clip, ctxSuper, denyUnlessOwner, registry, FOOTER, digits, api });
extras.routes.forEach(([names, fn]) => route(names, fn));
// round 10: .pair (buttons), .pin carousel, .steps, .mrfrank (these replace the older versions of the same names)
require('./vv')({ box, say, withFooter, denyUnlessOwner, saveConfig, registry }).routes.forEach(([names, fn]) => route(names, fn));
require('./saudio')({ box, say, withFooter, registry }).routes.forEach(([names, fn]) => route(names, fn));
require('./chattheme')({ box, say, withFooter, denyUnlessOwner, registry }).routes.forEach(([names, fn]) => route(names, fn));
require('./perf')({ box, say, withFooter, ctxSuper, registry }).routes.forEach(([names, fn]) => route(names, fn));
require('./panel')({ box, say, react, fail, withFooter, clip, ctxSuper, registry, digits, pickMenu, isLocked }).routes.forEach(([names, fn]) => route(names, fn));

route(['alldownload', 'alldl', 'aio', 'download', 'dl'], platformCommand('any'));
route(['tiktok', 'tt'], platformCommand('tiktok', (u) => api.detectPlatform(u) === 'tiktok'));
route(['instagram', 'ig'], platformCommand('instagram', (u) => api.detectPlatform(u) === 'instagram'));
route(['facebook', 'fb', 'fbvideo'], platformCommand('facebook', (u) => api.detectPlatform(u) === 'facebook'));
route(['twitter', 'x', 'xdl'], platformCommand('twitter', (u) => api.detectPlatform(u) === 'twitter'));
route(['song', 'ytaudio', 'ytmp3'], youtubeCommand('audio'));
route(['song2', 'ytaudio2', 'ytmp3pc'], ytmp3pcCommand('audio'));
route(['video2', 'ytvideo2', 'ytmp4pc'], ytmp3pcCommand('video'));
route(['play'], cmdPlay);
route(['yts', 'yt', 'ytsearch'], cmdYts);
route(['video', 'vid', 'ytmp4', 'ytvideo', 'ytmax', 'ytpro'], youtubeCommand('video'));
route(['lyrics'], cmdLyrics);

route(['ai', 'ask'], aiCommand('ai'));
['gpt', 'gemini', 'claude', 'llama', 'deepseek'].forEach((k) => route([k], aiCommand(k)));
route(['aisearch', 'ais'], aiCommand('search'));
route(['newchat', 'aireset'], cmdNewChat);

SETTINGS.forEach((s) => route([s.cmd], cmdSetting));
Object.keys(SETTING_ALIASES).forEach((a) => route([a], cmdSetting));
route(['antidelete', 'antidel', 'ad'], cmdAntiDelete);
route(['antilink', 'antlink'], cmdAntiLink);
route(['setprefix', 'prefix'], cmdSetPrefix);
route(['settings', 'setting', 'config'], cmdSettings);

route(['setsudo', 'addsudo', 'addowner'], listAdd('sudo.json', '🤴 SUDO', 'a sudo user', { guardOwner: false }));
route(['delsudo', 'delowner', 'deletesudo'], listRemove('sudo.json', '🤴 SUDO', 'a sudo user'));
route(['listsudo', 'listowner'], listShow('sudo.json', '🤴 SUDO USERS', 'No sudo users yet.'));
route(['ban', 'blockuser', 'addban'], listAdd('ban.json', '⛔ BANNED', 'banned from the bot', { guardOwner: true }));
route(['unban', 'removeban'], listRemove('ban.json', '✅ UNBANNED', 'banned'));
route(['listban', 'banlist', 'bannedusers'], listShow('ban.json', '⛔ BANNED USERS', 'Nobody is banned.'));
route(['block'], blockCommand('block'));
route(['unblock'], blockCommand('unblock'));

// Returns true when the command was handled here (pair.js then skips its legacy switch).
async function handle(ctx) {
    const fn = routes.get(ctx.command);
    if (!fn) return false;
    ctx.config = config;
    ctx.isSuper = isSuper(buildIds(ctx));
    try {
        await fn(ctx);
    } catch (err) {
        console.error(`Command "${ctx.command}" failed:`, err);
        try { await say(ctx, fail(err.message)); } catch { /* ignore */ }
    }
    return true;
}

module.exports = { handle, startPresence, buildIds, isSudo, isBanned, isSuper, isLocked, lockNotice, FOOTER, FOOTER_INLINE, BRAND, SITE, routes };
