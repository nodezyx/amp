// SUBZERO MD MINI - view-once saver (.vv2 + silent reply triggers)
//
//   .vv2 / .vo / .rvo2 / .viewonce2   reply to a view-once -> saved to your chosen destination
//   .setvvcmd <name>|reset            rename the command (default vv2)
//   .vvdest bot|owner|<number>        where saves go: the bot's own DM (default), the owner number, or a number
//   .vvtrigger list|add <w>|remove <w>|on|off|reset
//                                     silent reply words (default: lol, keep, wtf; any text or emoji)
//
// A trigger is a plain reply (no prefix) to a view-once message. Nothing is sent to the chat, no
// reaction, no read of the command - the media just lands in the destination DM.
//
// WhatsApp only delivers view-once media to a phone-type (Android) device; a web-type session only
// gets an empty stub. pair.js picks the Android identity once a session is registered (config
// ANDROID_IDENTITY) and keeps the stored original so it can be saved even after being opened.

const { normalizeMessageContent, downloadMediaMessage, downloadContentFromMessage } = require('baileys');
const config = require('../config');

const DEFAULT_CMD = 'vv2';
const DEFAULT_ALIASES = ['vo', 'rvo2', 'viewonce2'];
const DEFAULT_TRIGGERS = ['lol', 'keep', 'wtf'];
const silentLogger = { level: 'silent', child() { return this; }, trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {} };

const DL_TIMEOUT = 90000;
const withTimeout = (p, ms, msg) => { let t; return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(msg)), ms); })]).finally(() => clearTimeout(t)); };
const digits = (v) => String(v || '').replace(/[^0-9]/g, '');
const jidNumber = (jid) => String(jid || '').split('@')[0].split(':')[0];

// ------------------------------------------------------------------ pure helpers

function unwrap(message) {
    let cur = message, viewOnce = false;
    for (let i = 0; i < 6 && cur; i++) {
        const vo = cur.viewOnceMessage || cur.viewOnceMessageV2 || cur.viewOnceMessageV2Extension;
        if (vo?.message) { viewOnce = true; cur = vo.message; continue; }
        const wrap = cur.ephemeralMessage || cur.documentWithCaptionMessage;
        if (wrap?.message) { cur = wrap.message; continue; }
        break;
    }
    const type = cur?.imageMessage ? 'image' : cur?.videoMessage ? 'video' : cur?.audioMessage ? 'audio' : null;
    const media = type ? cur[`${type}Message`] : null;
    if (media?.viewOnce) viewOnce = true;
    return { cur, type, media, viewOnce };
}

// The reply context of a message: { stanzaId, participant, quotedMessage } or null.
function quotedOf(message) {
    let own = {};
    try { own = normalizeMessageContent(message) || message || {}; } catch { own = message || {}; }
    const holder = Object.values(own).find((v) => v && typeof v === 'object' && v.contextInfo?.stanzaId);
    return holder ? holder.contextInfo : null;
}

function text(message) {
    const o = (() => { try { return normalizeMessageContent(message) || message || {}; } catch { return message || {}; } })();
    return o.conversation || o.extendedTextMessage?.text || '';
}

const settings = (cfg = {}) => {
    const trig = Array.isArray(cfg.VV_TRIGGERS) ? cfg.VV_TRIGGERS : (config.VV_TRIGGERS || DEFAULT_TRIGGERS);
    return {
        cmd: String(cfg.VV_CMD || config.VV_CMD || DEFAULT_CMD).toLowerCase(),
        dest: String(cfg.VV_DEST || config.VV_DEST || 'bot').toLowerCase(),
        triggersOn: String(cfg.VV_TRIGGERS_ON ?? config.VV_TRIGGERS_ON ?? 'true') !== 'false',
        triggers: trig.map((t) => String(t).trim().toLowerCase()).filter(Boolean)
    };
};

function destJid(socket, dest) {
    if (dest === 'owner' && digits(config.OWNER_NUMBER)) return `${digits(config.OWNER_NUMBER)}@s.whatsapp.net`;
    if (/^\d{6,}$/.test(dest)) return `${dest}@s.whatsapp.net`;
    return `${jidNumber(socket.user?.id)}@s.whatsapp.net`;
}

// ------------------------------------------------------------------ the saver

// Returns { ok, notes }. Never throws. Failures are sent to the destination DM only.
async function save({ socket, msg, dest, getStored, cmdName = DEFAULT_CMD, onNoQuote }) {
    const to = destJid(socket, dest);
    const tell = (t) => socket.sendMessage(to, { text: t }).catch(() => {});
    const chat = msg.key.remoteJid;
    const notes = [];
    try {
        const ctx = quotedOf(msg.message);
        if (!ctx?.stanzaId) {
            if (onNoQuote) await onNoQuote(); else await tell(`ℹ️ .${cmdName} - reply to a view-once message with .${cmdName}`);
            return { ok: false, notes, reason: 'noquote' };
        }

        const key = {
            remoteJid: chat, id: ctx.stanzaId,
            ...(ctx.participant ? { participant: ctx.participant } : {}),
            ...(msg.key.remoteJidAlt ? { remoteJidAlt: msg.key.remoteJidAlt } : {})
        };
        const stored = getStored ? getStored(chat, ctx.stanzaId) : null;
        const sources = [['original copy', stored?.message], ['quoted copy', ctx.quotedMessage]].filter(([, s]) => s);
        if (!sources.length) notes.push('The bot has no copy of that message (it was probably sent before the bot started).');

        let buffer = null, found = null;
        for (const [label, source] of sources) {
            const u = unwrap(source);
            if (!u.type) { notes.push(`${label}: no photo/video/voice inside`); continue; }
            notes.push(`${label}: ${u.type}${u.viewOnce ? ' (view-once)' : ''}, mediaKey ${u.media.mediaKey ? 'yes' : 'NO'}, directPath ${u.media.directPath ? 'yes' : 'NO'}`);
            try {
                buffer = await withTimeout(downloadMediaMessage({ key, message: u.cur }, 'buffer', {}, {
                    logger: silentLogger, reuploadRequest: (m) => socket.updateMediaMessage(m)
                }), DL_TIMEOUT, 'download timed out');
            } catch (e1) {
                notes.push(`${label} download error: ${e1?.message || e1}`);
                try {
                    buffer = await withTimeout((async () => {
                        const stream = await downloadContentFromMessage(u.media, u.type);
                        const chunks = [];
                        for await (const c of stream) chunks.push(c);
                        return Buffer.concat(chunks);
                    })(), DL_TIMEOUT, 'retry timed out');
                } catch (e2) { notes.push(`${label} retry error: ${e2?.message || e2}`); buffer = null; }
            }
            if (Buffer.isBuffer(buffer) && buffer.length) { found = u; break; }
            buffer = null;
        }
        if (!found) throw new Error('Could not download the media');

        const caption = `🔓 View-once saved\n💬 Chat: ${jidNumber(chat)}` +
            (ctx.participant ? `\n👤 Sender: ${jidNumber(ctx.participant)}` : '') +
            (found.media.caption ? `\n📝 ${found.media.caption}` : '');
        if (found.type === 'image') await socket.sendMessage(to, { image: buffer, caption, mimetype: found.media.mimetype || 'image/jpeg' });
        else if (found.type === 'video') await socket.sendMessage(to, { video: buffer, caption, mimetype: found.media.mimetype || 'video/mp4' });
        else {
            await socket.sendMessage(to, { audio: buffer, mimetype: found.media.mimetype || 'audio/ogg; codecs=opus', ptt: !!found.media.ptt });
            await socket.sendMessage(to, { text: caption });
        }
        return { ok: true, notes };
    } catch (e) {
        await tell(`❌ .${cmdName} failed\n💬 Chat: ${jidNumber(chat)}\n⚠️ ${e?.message || e}\n\n🔎 Details:\n${notes.join('\n') || '(none)'}\n\n💡 Reply to the view-once BEFORE opening it on your phone - once opened, WhatsApp may delete the file.`);
        return { ok: false, notes };
    }
}

// True when the message replies to a view-once (checked on our stored copy first, then the quoted copy).
function repliesToViewOnce(msg, getStored) {
    const ctx = quotedOf(msg.message);
    if (!ctx?.stanzaId) return false;
    const stored = getStored ? getStored(msg.key.remoteJid, ctx.stanzaId) : null;
    for (const src of [stored?.message, ctx.quotedMessage]) {
        if (!src) continue;
        const u = unwrap(src);
        if (u.type && u.viewOnce) return true;
    }
    return false;
}

// ------------------------------------------------------------------ pair.js hooks

// Silent trigger. Returns true when it handled the message (caller should stop).
async function trigger(ctx) {
    const { socket, msg, userConfig, isOwner, getStored } = ctx;
    if (!isOwner) return false;
    const s = settings(userConfig);
    if (!s.triggersOn || !s.triggers.length) return false;
    const raw = text(msg.message).trim().toLowerCase();
    const t = s.triggers.includes(raw) ? raw : raw.replace(/[.!?\s]+$/u, '');
    if (!t || t.length > 40 || !s.triggers.includes(t)) return false;
    if (!repliesToViewOnce(msg, getStored)) return false;
    await save({ socket, msg, dest: s.dest, getStored, cmdName: t });
    return true;
}

// The user-renamed command (.setvvcmd). Static names are routed below; this covers custom ones.
async function dynamic(ctx) {
    const s = settings(ctx.userConfig);
    if (ctx.command !== s.cmd || s.cmd === DEFAULT_CMD) return false;
    if (!ctx.isOwner) return true;
    await ctx.socket.sendMessage(ctx.sender || ctx.msg.key.remoteJid, { react: { text: '⏳', key: ctx.msg.key } }).catch(() => {});
    const r = await save({ socket: ctx.socket, msg: ctx.msg, dest: s.dest, getStored: ctx.helpers.getStoredMessage, cmdName: s.cmd });
    await ctx.socket.sendMessage(ctx.sender || ctx.msg.key.remoteJid, { react: { text: r.ok ? '✅' : '❌', key: ctx.msg.key } }).catch(() => {});
    return true;
}

// ------------------------------------------------------------------ commands

module.exports = function build(h) {
    const { box, say, withFooter, denyUnlessOwner, saveConfig, registry } = h;
    const sc = registry.smallcaps;
    const row = (k, v) => `▨ ${sc(k)} ⟜ ${v}`;

    async function cmdVv2(ctx) {
        if (await denyUnlessOwner(ctx)) return;
        const s = settings(ctx.userConfig);
        await run(ctx, s);
    }

    // explicit command: show progress / result on the command message itself (triggers stay fully silent)
    async function run(ctx, s) {
        await ctx.socket.sendMessage(ctx.sender, { react: { text: '⏳', key: ctx.msg.key } }).catch(() => {});
        const r = await save({
            socket: ctx.socket, msg: ctx.msg, dest: s.dest, getStored: ctx.helpers.getStoredMessage, cmdName: ctx.command,
            onNoQuote: () => say(ctx, withFooter(box('VIEW-ONCE', [`Reply to a view-once with ${ctx.prefix}${ctx.command}`, `Saves to: ${s.dest}`])))
        });
        await ctx.socket.sendMessage(ctx.sender, { react: { text: r.ok ? '✅' : '❌', key: ctx.msg.key } }).catch(() => {});
    }

    async function cmdSetVvCmd(ctx) {
        if (await denyUnlessOwner(ctx)) return;
        const raw = String(ctx.args[0] || '').toLowerCase().replace(/^[^a-z0-9]+/, '');
        const cur = settings(ctx.userConfig).cmd;
        if (!raw) return say(ctx, withFooter(box('VIEW-ONCE COMMAND', [
            row('Current', `${ctx.prefix}${cur}`), '',
            `${ctx.prefix}setvvcmd <name>  change it`, `${ctx.prefix}setvvcmd reset   back to ${DEFAULT_CMD}`, '',
            `Also works: ${DEFAULT_ALIASES.map((a) => ctx.prefix + a).join(' ')}`
        ])));
        if (raw === 'reset' || raw === 'default') {
            await saveConfig(ctx, (c) => { c.VV_CMD = DEFAULT_CMD; });
            return say(ctx, withFooter(box('VIEW-ONCE COMMAND', [`Reset to ${ctx.prefix}${DEFAULT_CMD}`])));
        }
        if (!/^[a-z][a-z0-9]{0,24}$/.test(raw)) return say(ctx, withFooter(box('VIEW-ONCE COMMAND', ['Name must start with a letter,', 'letters and numbers only, max 25.'])));
        await saveConfig(ctx, (c) => { c.VV_CMD = raw; });
        return say(ctx, withFooter(box('VIEW-ONCE COMMAND', [`Now ${ctx.prefix}${raw}`, `Reply to a view-once with ${ctx.prefix}${raw}`])));
    }

    async function cmdVvDest(ctx) {
        if (await denyUnlessOwner(ctx)) return;
        const v = String(ctx.args[0] || '').toLowerCase();
        const cur = settings(ctx.userConfig).dest;
        if (!v) return say(ctx, withFooter(box('VIEW-ONCE DESTINATION', [
            row('Current', cur), '',
            `${ctx.prefix}vvdest bot     the bot's own DM`, `${ctx.prefix}vvdest owner   the owner number`, `${ctx.prefix}vvdest <number> any number`
        ])));
        const num = digits(v);
        if (v !== 'bot' && v !== 'owner' && num.length < 6) return say(ctx, withFooter(box('VIEW-ONCE DESTINATION', ['Use: bot, owner or a phone number.'])));
        const val = v === 'bot' || v === 'owner' ? v : num;
        await saveConfig(ctx, (c) => { c.VV_DEST = val; });
        return say(ctx, withFooter(box('VIEW-ONCE DESTINATION', [row('Saved to', val)])));
    }

    async function cmdVvTrigger(ctx) {
        if (await denyUnlessOwner(ctx)) return;
        const sub = String(ctx.args[0] || 'list').toLowerCase();
        const word = ctx.args.slice(1).join(' ').trim().toLowerCase();
        const s = settings(ctx.userConfig);
        const show = (extra) => say(ctx, withFooter(box('VIEW-ONCE TRIGGERS', [
            ...(extra ? [extra, ''] : []),
            row('Status', s.triggersOn ? 'ON' : 'OFF'), row('Words', s.triggers.join('  ') || 'none'), row('Saves to', s.dest), '',
            `${ctx.prefix}vvtrigger add <word|emoji>`, `${ctx.prefix}vvtrigger remove <word>`, `${ctx.prefix}vvtrigger on|off|reset`,
            '', 'Reply with a trigger word to a view-once - saved silently.'
        ])));
        if (sub === 'list') return show();
        if (sub === 'on' || sub === 'off') { s.triggersOn = sub === 'on'; await saveConfig(ctx, (c) => { c.VV_TRIGGERS_ON = sub === 'on' ? 'true' : 'false'; }); return show(`Triggers ${sub.toUpperCase()}`); }
        if (sub === 'reset') { s.triggers = [...DEFAULT_TRIGGERS]; await saveConfig(ctx, (c) => { c.VV_TRIGGERS = [...DEFAULT_TRIGGERS]; }); return show('Reset to defaults'); }
        if ((sub === 'add' || sub === 'remove' || sub === 'del') && word) {
            if (word.length > 40) return show('Too long (max 40 characters)');
            if (word.startsWith(ctx.prefix) && word.length > 1) return show('Triggers are plain words, no prefix');
            const list = new Set(s.triggers);
            if (sub === 'add') list.add(word); else list.delete(word);
            s.triggers = [...list];
            await saveConfig(ctx, (c) => { c.VV_TRIGGERS = [...list]; });
            return show(sub === 'add' ? `Added "${word}"` : `Removed "${word}"`);
        }
        return show('Usage: add <word> | remove <word> | on | off | reset');
    }

    return {
        routes: [
            [[DEFAULT_CMD, ...DEFAULT_ALIASES], cmdVv2],
            [['setvvcmd', 'setvv', 'vvcommand'], cmdSetVvCmd],
            [['vvdest', 'vvto'], cmdVvDest],
            [['vvtrigger', 'vvtriggers', 'vvwords'], cmdVvTrigger]
        ]
    };
};
module.exports.trigger = trigger;
module.exports.dynamic = dynamic;
module.exports.save = save;
module.exports.unwrap = unwrap;
module.exports.settings = settings;
module.exports.quotedOf = quotedOf;
module.exports.repliesToViewOnce = repliesToViewOnce;
module.exports.DEFAULT_TRIGGERS = DEFAULT_TRIGGERS;
