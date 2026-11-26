// SUBZERO MD MINI - extra commands (round 9)
//
//   .getmsg / .try                  raw message export + replay (super owner)
//   .gcstatus                       WhatsApp group status (group admins, owner for cross-group)
//   .setbotpp / .removebotpp        bot profile picture
//   .setbotbio / .setbotname        bot "about" text and profile name
//   .privacy and the privacy setters, .botonline, .fakepresence
//
// Loaded by lib/newcmds.js, which hands in its helpers so every reply has the same look.

const { proto, generateMessageID, generateMessageIDV2, generateWAMessageFromContent, normalizeMessageContent, downloadContentFromMessage } = require('baileys');
const { AIRich, Button } = require('./messageBuilder');
const fs = require('fs');
const os = require('os');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const config = require('../config');
const gcstatusCommand = require('./gcstatus');
const rawstore = require('./rawstore');

const MAX_RAW_BYTES = 8 * 1024 * 1024;
const lastPayloadByChat = new Map();

module.exports = function build(h) {
    const { saveConfig, resolveTarget, box, say, react, fail, withFooter, clip, ctxSuper, denyUnlessOwner, registry, FOOTER, digits, api } = h;
    const sc = registry.smallcaps;
    const row = (k, v) => `▨ ${sc(k)} ⟜ ${v}`;
    const botJid = (ctx) => String(ctx.socket.user?.id || '').replace(/:\d+@/, '@');

    const denyUnlessSuper = async (ctx) => {
        if (ctxSuper(ctx)) return false;
        await say(ctx, withFooter(box('ACCESS DENIED', [row('Only', 'the super owner')])));
        return true;
    };

    // ------------------------------------------------------------ getmsg / try
    //
    // Same recipe as the CRM bot: keep the message as a protobuf object, export it with
    // proto.Message.toObject({ bytes: String (base64), longs: Number, enums: Number }) and rebuild it with
    // proto.Message.fromObject(). That round trip keeps mediaKey / fileSha256 / thumbnails intact, so a
    // replayed image / video / document still opens. Plain JSON.stringify of Buffers does not survive.

    const RAW_OPT = { longs: Number, enums: Number, bytes: String, defaults: false };
    const toPlain = (m) => proto.Message.toObject(proto.Message.fromObject(m), RAW_OPT);
    const safeStringify = (o, space = 2) => JSON.stringify(o, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), space);
    // for the chat code block only: long base64 blobs are summarised so the JSON stays readable
    const readable = (o) => JSON.parse(JSON.stringify(o, (_k, v) => (typeof v === 'string' && v.length > 120 && /^[A-Za-z0-9+/=_-]+$/.test(v) ? `<base64 ${v.length} chars>` : v)));
    const genId = (sock) => { try { return typeof generateMessageIDV2 === 'function' ? generateMessageIDV2(sock.user?.id) : generateMessageID(); } catch { return generateMessageID(); } };

    const unwrap = (value) => {
        try { return normalizeMessageContent(value) || value; } catch { return value; }
    };
    // The context of the command message, whatever type it is (text, image caption, ...)
    const commandContext = (msg) => {
        const m = unwrap(msg?.message) || {};
        for (const k of Object.keys(m)) if (m[k] && typeof m[k] === 'object' && m[k].contextInfo) return m[k].contextInfo;
        return null;
    };
    const commandText = (msg) => {
        const m = unwrap(msg?.message) || {};
        return m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.videoMessage?.caption || m.documentMessage?.caption || '';
    };
    const textFromPayload = (p) => {
        const x = unwrap(p) || {};
        return x.conversation || x.extendedTextMessage?.text || x.imageMessage?.caption || x.videoMessage?.caption || x.documentMessage?.caption || '';
    };
    const stripFences = (t) => String(t).trim().replace(/^```[a-z]*\s*/i, '').replace(/\s*```$/, '').trim();
    function parseJsonLoose(text) {
        const t = stripFences(text);
        if (!t || (t[0] !== '{' && t[0] !== '[')) return null;
        try { const parsed = JSON.parse(t); return parsed?.message && typeof parsed.message === 'object' ? parsed.message : parsed; } catch { return null; }
    }

    // The quoted message, as complete as we can get it: our own store first (the full original), then what
    // WhatsApp put in the reply's contextInfo.
    function resolveQuoted(ctx) {
        const c = commandContext(ctx.msg);
        if (!c?.quotedMessage && !c?.stanzaId) return null;
        const id = c.stanzaId;
        let stored = null;
        try { stored = id ? ctx.helpers?.getStoredMessage?.(ctx.sender, id) : null; } catch { /* no store */ }
        const fromStore = stored?.message ? stored : null;
        return {
            id,
            participant: c.participant || null,
            message: fromStore ? fromStore.message : c.quotedMessage,
            key: fromStore?.key || { remoteJid: ctx.sender, id, participant: c.participant || undefined, fromMe: false },
            pushName: fromStore?.pushName || null,
            timestamp: fromStore?.messageTimestamp || null,
            source: fromStore ? 'store' : 'quoted',
        };
    }

    const CHUNK = 3400;
    const MAX_CHUNKS = 6;

    async function cmdGetMsg(ctx) {
        if (await denyUnlessSuper(ctx)) return;
        const q = resolveQuoted(ctx);
        if (!q?.message) {
            return say(ctx, withFooter(box('RAW MESSAGE', [
                row('Usage', `reply to any message with ${ctx.prefix}getmsg`),
                row('Replay', `reply to the JSON file with ${ctx.prefix}try`),
            ])));
        }
        let plain;
        try { plain = toPlain(q.message); } catch (err) { return say(ctx, fail(`Could not read that message: ${err.message}`)); }
        const type = Object.keys(plain).find((k) => k !== 'messageContextInfo') || 'unknown';

        // The exact bytes WhatsApp sent (keeps fields this Baileys version does not know about) + the stanza.
        const entry = rawstore.get(q.id);
        const envelope = {
            key: q.key, pushName: q.pushName || undefined,
            messageTimestamp: q.timestamp ? Number(q.timestamp?.low ?? q.timestamp) : undefined,
            source: q.source,
            raw: entry?.raw || undefined,          // base64 of the original protobuf (complete, unknown fields included)
            node: entry?.node || undefined,        // the stanza without the encrypted part
            message: plain,                        // decoded view
        };
        const json = safeStringify(envelope);
        const short = safeStringify(readable(envelope));
        lastPayloadByChat.set(ctx.sender, envelope);

        // Chat view: the whole JSON in code blocks (long ones continue in more blocks, never cut off silently)
        const chunks = [];
        for (let i = 0; i < short.length && chunks.length < MAX_CHUNKS; i += CHUNK) chunks.push(short.slice(i, i + CHUNK));
        const cut = short.length > CHUNK * MAX_CHUNKS;
        const ids = [q.id].filter(Boolean);
        for (let i = 0; i < chunks.length; i++) {
            const head = i === 0 ? `*${sc('Raw message')}* ⟜ ${type} ⟜ ${sc(entry?.raw ? 'exact bytes saved' : q.source)}${chunks.length > 1 ? ` ⟜ ${i + 1}/${chunks.length}` : ''}` : `*${sc('Raw message')}* ⟜ ${i + 1}/${chunks.length}`;
            try {
                const sent = await new AIRich(ctx.socket).addText(head).addCode('json', chunks[i] + (cut && i === chunks.length - 1 ? '\n… (rest is in the file)' : '')).send(ctx.sender, { quoted: ctx.msg });
                if (sent?.key?.id) ids.push(sent.key.id);
            } catch (err) {
                console.error('getmsg AIRich failed, using plain text:', err.message);
                const sent = await ctx.socket.sendMessage(ctx.sender, { text: `${head}\n\`\`\`${chunks[i]}\`\`\`` }, { quoted: ctx.msg });
                if (sent?.key?.id) ids.push(sent.key.id);
            }
        }
        const doc = await ctx.socket.sendMessage(ctx.sender, {
            document: Buffer.from(json, 'utf8'),
            mimetype: 'application/json',
            fileName: `message-${type}-${String(q.id || Date.now()).slice(0, 12)}.json`,
            caption: withFooter(box('RAW MESSAGE', [row('Type', type), row('Size', `${json.length} chars`), row('Bytes', entry?.raw ? 'exact copy saved' : 'decoded view only'), row('Replay', `reply to this file or any block with ${ctx.prefix}try`)])),
        }, { quoted: ctx.msg });
        if (doc?.key?.id) ids.push(doc.key.id);
        // so .try works when the user replies to ANY of these messages, even the shortened code blocks
        ids.forEach((id) => rawstore.savePayload(id, envelope));
    }

    async function readJsonDocument(ctx, quotedMessage) {
        const document = unwrap(quotedMessage)?.documentMessage;
        if (!document) return null;
        const stream = await downloadContentFromMessage(document, 'document');
        const chunks = [];
        let size = 0;
        for await (const chunk of stream) {
            size += chunk.length;
            if (size > MAX_RAW_BYTES) throw new Error('payload too large');
            chunks.push(chunk);
        }
        return parseJsonLoose(Buffer.concat(chunks).toString('utf8'));
    }

    // .try [plain] [nodes] [{json}]
    //   plain : rebuild from the decoded view instead of the exact bytes
    //   nodes : also send the stanza's extra nodes (bot / biz / meta ...) with the message
    async function cmdTry(ctx) {
        if (await denyUnlessSuper(ctx)) return;
        const q = resolveQuoted(ctx);
        const inline = commandText(ctx.msg).replace(/^\S+\s*/, '').trim();
        const flags = new Set();
        let rest = inline;
        for (;;) { const m = rest.match(/^(plain|nodes)\b\s*/i); if (!m) break; flags.add(m[1].toLowerCase()); rest = rest.slice(m[0].length); }

        let payload = null;
        // 0) something .getmsg saved for exactly this message (code block, file) - always complete
        if (q?.id) payload = rawstore.loadPayload(q.id);
        // 1) JSON typed after the command   2) a quoted .json file   3) quoted text that is JSON
        if (!payload && rest) payload = parseJsonLoose(rest);
        if (!payload && q?.message) {
            try { payload = await readJsonDocument(ctx, q.message); } catch (err) { return say(ctx, fail(`Could not read the JSON file: ${err.message}`)); }
        }
        if (!payload && q?.message) {
            const text = textFromPayload(q.message);
            if (/<base64 \d+ chars>/.test(text)) return say(ctx, fail(`That block is shortened for reading and was not saved. Reply to the .json file instead.`));
            payload = parseJsonLoose(text);
        }
        // 4) replay the quoted message itself   5) the last one exported with .getmsg
        if (!payload && q?.message && !unwrap(q.message)?.documentMessage) payload = q.message;
        if (!payload) payload = lastPayloadByChat.get(ctx.sender);
        if (!payload || typeof payload !== 'object') {
            return say(ctx, withFooter(box('REPLAY', [row('Usage', `reply to a .json file from ${ctx.prefix}getmsg`), row('Or', `${ctx.prefix}try {json}  /  reply to any message`), row('Flags', 'plain, nodes')])));
        }

        const envelope = payload.message && typeof payload.message === 'object' && !payload.conversation && !payload.extendedTextMessage ? payload : { message: payload };
        const id = genId(ctx.socket);
        const opts = { messageId: id };
        if (flags.has('nodes') && Array.isArray(envelope.node?.content)) {
            opts.additionalNodes = envelope.node.content.filter((n) => n && n.tag).map((n) => ({ tag: n.tag, attrs: n.attrs || {}, content: n.content }));
        }

        // exact bytes first: nothing WhatsApp sent is lost, whatever the feature
        if (envelope.raw && !flags.has('plain') && rawstore.isActive()) {
            try {
                const bytes = Buffer.from(envelope.raw, 'base64');
                const content = proto.Message.decode(bytes);
                Object.defineProperty(content, '__replayRaw', { value: bytes, enumerable: false, configurable: true });
                await ctx.socket.relayMessage(ctx.sender, content, opts);
                return;
            } catch (err) {
                console.warn('[try] exact-bytes replay failed, rebuilding from the decoded view:', err.message);
            }
        }
        let content;
        try { content = proto.Message.fromObject(envelope.message || envelope); } catch (err) { return say(ctx, fail(`That JSON is not a WhatsApp message: ${err.message}`)); }
        try {
            let out = content;
            try { out = generateWAMessageFromContent(ctx.sender, content, { userJid: ctx.socket.user?.id, messageId: id }).message || content; } catch { /* relay the raw content */ }
            await ctx.socket.relayMessage(ctx.sender, out, opts);
        } catch (err) {
            console.error('[try raw message]', err);
            await say(ctx, fail(`Could not replay this payload: ${err.message}`));
        }
    }

    // ------------------------------------------------------------ gcstatus

    async function cmdGcStatus(ctx) {
        const owner = !!(ctx.isOwner || ctxSuper(ctx));
        const senderId = ctx.m?.sender || ctx.nowsender || ctx.senderNumber || ctx.sender;
        await gcstatusCommand(ctx.socket, ctx.sender, senderId, ctx.msg, { owner, prefix: ctx.prefix, isAdmin: !!ctx.isAdmins });
    }

    // ------------------------------------------------------------ bot profile

    async function imageFromContext(ctx) {
        const quoted = ctx.m?.quoted;
        const source = quoted && /image/i.test(quoted.type || quoted.mtype || '') ? quoted
            : /image/i.test(ctx.m?.type || ctx.m?.mtype || '') ? ctx.m : null;
        if (!source || typeof source.download !== 'function') return null;
        const buf = await source.download();
        return buf && buf.length ? buf : null;
    }

    async function cmdSetBotPp(ctx) {
        if (await denyUnlessOwner(ctx)) return;
        let buf = null;
        try { buf = await imageFromContext(ctx); } catch { /* handled below */ }
        const url = api.extractUrl(ctx.args.join(' '));
        if (!buf && url) buf = await api.fetchBuffer(url, { maxMB: 8, timeout: 20000 });
        if (!buf) {
            return say(ctx, withFooter(box('BOT PROFILE PICTURE', [
                row('Reply to an image', `${ctx.prefix}setbotpp`),
                row('Or a link', `${ctx.prefix}setbotpp https://...`),
                row('Remove', `${ctx.prefix}removebotpp`),
            ])));
        }
        await react(ctx, '⏳');
        await ctx.socket.updateProfilePicture(botJid(ctx), buf);
        await react(ctx, '✅');
        return say(ctx, withFooter(box('BOT PROFILE PICTURE', [row('Status', 'updated')])));
    }

    async function cmdRemoveBotPp(ctx) {
        if (await denyUnlessOwner(ctx)) return;
        await ctx.socket.removeProfilePicture(botJid(ctx));
        await react(ctx, '✅');
        return say(ctx, withFooter(box('BOT PROFILE PICTURE', [row('Status', 'removed')])));
    }

    async function cmdSetBotBio(ctx) {
        if (await denyUnlessOwner(ctx)) return;
        const text = ctx.args.join(' ').trim();
        if (!text) return say(ctx, withFooter(box('BOT BIO', [row('Usage', `${ctx.prefix}setbotbio <text>`), row('Limit', '139 characters')])));
        if (text.length > 139) return say(ctx, fail('The bio can be at most 139 characters.'));
        await ctx.socket.updateProfileStatus(text);
        await react(ctx, '✅');
        return say(ctx, withFooter(box('BOT BIO', [row('Now', clip(text, 80))])));
    }

    async function cmdSetBotName(ctx) {
        if (await denyUnlessOwner(ctx)) return;
        const text = ctx.args.join(' ').trim();
        if (!text) return say(ctx, withFooter(box('BOT NAME', [row('Usage', `${ctx.prefix}setbotname <name>`), row('Limit', '25 characters')])));
        if (text.length > 25) return say(ctx, fail('The name can be at most 25 characters.'));
        await ctx.socket.updateProfileName(text);
        await react(ctx, '✅');
        return say(ctx, withFooter(box('BOT NAME', [row('Now', text)])));
    }

    // ------------------------------------------------------------ privacy + presence

    const PRIVACY = {
        lastseen:     { fn: 'updateLastSeenPrivacy',      key: 'last',        values: ['all', 'contacts', 'contact_blacklist', 'none'], title: 'LAST SEEN' },
        ppprivacy:    { fn: 'updateProfilePicturePrivacy', key: 'profile',    values: ['all', 'contacts', 'contact_blacklist', 'none'], title: 'PROFILE PICTURE' },
        statusprivacy:{ fn: 'updateStatusPrivacy',        key: 'status',      values: ['all', 'contacts', 'contact_blacklist', 'none'], title: 'ABOUT / STATUS' },
        onlineprivacy:{ fn: 'updateOnlinePrivacy',        key: 'online',      values: ['all', 'match_last_seen'], title: 'ONLINE' },
        readreceipts: { fn: 'updateReadReceiptsPrivacy',  key: 'readreceipts', values: ['all', 'none'], title: 'READ RECEIPTS' },
        groupadd:     { fn: 'updateGroupsAddPrivacy',     key: 'groupadd',    values: ['all', 'contacts', 'contact_blacklist'], title: 'GROUP ADD' },
        callprivacy:  { fn: 'updateCallPrivacy',          key: 'calladd',     values: ['all', 'known'], title: 'CALLS' },
        messagesprivacy: { fn: 'updateMessagesPrivacy',   key: 'messages',    values: ['all', 'contacts'], title: 'MESSAGES' },
    };
    const ALIAS = { everyone: 'all', nobody: 'none', contact: 'contacts', exceptions: 'contact_blacklist', except: 'contact_blacklist', same: 'match_last_seen', known: 'known' };

    function privacyCommand(name) {
        const def = PRIVACY[name];
        return async (ctx) => {
            if (await denyUnlessOwner(ctx)) return;
            let value = String(ctx.args[0] || '').toLowerCase();
            value = ALIAS[value] && def.values.includes(ALIAS[value]) ? ALIAS[value] : value;
            if (!def.values.includes(value)) {
                return say(ctx, withFooter(box(def.title, [row('Usage', `${ctx.prefix}${name} <${def.values.join('|')}>`)])));
            }
            await ctx.socket[def.fn](value);
            await react(ctx, '✅');
            return say(ctx, withFooter(box(def.title, [row('Now', value)])));
        };
    }

    async function cmdPrivacy(ctx) {
        if (await denyUnlessOwner(ctx)) return;
        const s = await ctx.socket.fetchPrivacySettings(true);
        const rows = Object.entries(PRIVACY).map(([cmd, def]) => row(`${ctx.prefix}${cmd}`, String(s?.[def.key] ?? 'unknown')));
        return say(ctx, withFooter(box('PRIVACY', rows)));
    }

    async function cmdBotOnline(ctx) {
        if (await denyUnlessOwner(ctx)) return;
        const v = String(ctx.args[0] || '').toLowerCase();
        if (!['on', 'off'].includes(v)) return say(ctx, withFooter(box('BOT ONLINE', [row('Usage', `${ctx.prefix}setonline on|off`), row('Note', 'on = appear online, off = appear offline')])));
        await ctx.socket.sendPresenceUpdate(v === 'on' ? 'available' : 'unavailable');
        await react(ctx, '✅');
        return say(ctx, withFooter(box('BOT ONLINE', [row('Now', v === 'on' ? 'online' : 'offline')])));
    }

    // .fakepresence typing|recording|paused [seconds]  - shows in the current chat
    async function cmdFakePresence(ctx) {
        if (await denyUnlessOwner(ctx)) return;
        const map = { typing: 'composing', recording: 'recording', paused: 'paused' };
        const kind = String(ctx.args[0] || '').toLowerCase();
        if (!map[kind]) return say(ctx, withFooter(box('FAKE PRESENCE', [row('Usage', `${ctx.prefix}fakepresence typing|recording|paused [seconds]`)])));
        const secs = Math.min(Math.max(parseInt(ctx.args[1], 10) || 10, 1), 120);
        await ctx.socket.presenceSubscribe(ctx.sender).catch(() => {});
        await ctx.socket.sendPresenceUpdate(map[kind], ctx.sender);
        if (kind !== 'paused') setTimeout(() => ctx.socket.sendPresenceUpdate('paused', ctx.sender).catch(() => {}), secs * 1000);
        await react(ctx, '✅');
    }


    // ------------------------------------------------------------ fetch someone's status + profile picture

    const needTarget = (ctx, cmd) => say(ctx, withFooter(box(cmd.toUpperCase(), [
        row('Usage', `${ctx.prefix}${cmd} <number> | @mention | reply to a user`),
        row('Example', `${ctx.prefix}${cmd} 263719647303`),
    ])));

    async function cmdGetStatus(ctx) {
        const target = resolveTarget(ctx);
        if (!target) return needTarget(ctx, 'getstatus');
        await react(ctx, '⏳');
        let res;
        try { res = await ctx.socket.fetchStatus(target); } catch (err) { await react(ctx, '❌'); return say(ctx, fail(`Could not fetch the status: ${err.message}`)); }
        const entry = Array.isArray(res) ? res[0] : res;
        const data = entry?.status && typeof entry.status === 'object' ? entry.status : entry;
        const text = data?.status ?? data?.text ?? (typeof data === 'string' ? data : '');
        const setAt = data?.setAt ? new Date(data.setAt).toISOString().slice(0, 10) : null;
        await react(ctx, text ? '✅' : '❌');
        if (!text) return say(ctx, withFooter(box('USER STATUS', [row('User', `+${digits(target)}`), row('About', 'hidden or not set')])));
        await ctx.socket.sendMessage(ctx.sender, {
            text: withFooter(box('USER STATUS', [row('User', `+${digits(target)}`), row('About', text), ...(setAt ? [row('Set', setAt)] : [])])),
            mentions: [target],
        }, { quoted: ctx.msg });
    }

    async function cmdGetPp(ctx) {
        const target = resolveTarget(ctx);
        if (!target) return needTarget(ctx, 'getpp');
        await react(ctx, '⏳');
        const hd = !/^(low|lowres|small)$/i.test(String(ctx.args[ctx.args.length - 1] || ''));
        let url = null;
        try { url = await ctx.socket.profilePictureUrl(target, hd ? 'image' : undefined, 10000); } catch { /* none / private */ }
        if (!url && hd) { try { url = await ctx.socket.profilePictureUrl(target); } catch { /* none */ } }
        if (!url) { await react(ctx, '❌'); return say(ctx, withFooter(box('PROFILE PICTURE', [row('User', `+${digits(target)}`), row('Photo', 'none, or hidden by privacy')]))); }
        await react(ctx, '✅');
        await ctx.socket.sendMessage(ctx.sender, {
            image: { url },
            caption: withFooter(box('PROFILE PICTURE', [row('User', `+${digits(target)}`), row('Quality', hd ? 'high' : 'low')])),
            mentions: [target],
        }, { quoted: ctx.msg });
    }


    // ------------------------------------------------------------ .cdn / .upload / .tourl

    const MIME_EXT = {
        'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
        'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm', 'video/3gpp': '3gp', 'video/x-matroska': 'mkv',
        'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/webm': 'webm', 'audio/aac': 'aac', 'audio/x-m4a': 'm4a',
        'application/pdf': 'pdf', 'application/zip': 'zip', 'application/x-zip-compressed': 'zip', 'application/json': 'json',
        'application/vnd.android.package-archive': 'apk', 'application/x-rar-compressed': 'rar', 'application/vnd.rar': 'rar', 'text/plain': 'txt',
        'application/msword': 'doc', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
        'application/vnd.ms-excel': 'xls', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
    };
    const MEDIA_NODES = [['imageMessage', 'image'], ['videoMessage', 'video'], ['audioMessage', 'audio'], ['documentMessage', 'document'], ['stickerMessage', 'sticker'], ['ptvMessage', 'video']];
    const findMedia = (container) => {
        const c = unwrap(container) || {};
        for (const [key, type] of MEDIA_NODES) if (c[key]) return { node: c[key], type, key };
        return null;
    };
    // extension: the file's own name wins, then the mime type, then the mime subtype, never ".dat"
    function extensionFor(media) {
        const own = String(media.node.fileName || '').match(/\.([A-Za-z0-9]{1,8})$/);
        if (own) return own[1].toLowerCase();
        const mime = String(media.node.mimetype || '').split(';')[0].trim().toLowerCase();
        if (MIME_EXT[mime]) return MIME_EXT[mime];
        const sub = (mime.split('/')[1] || '').replace(/^x-/, '').replace(/[^a-z0-9]/g, '');
        if (sub && sub.length <= 6) return sub;
        return media.type === 'image' ? 'jpg' : media.type === 'video' ? 'mp4' : media.type === 'audio' ? 'mp3' : media.type === 'sticker' ? 'webp' : 'bin';
    }
    const formatBytes = (n) => { if (!n) return '0 B'; const u = ['B', 'KB', 'MB', 'GB']; const i = Math.min(3, Math.floor(Math.log(n) / Math.log(1024))); return `${(n / 1024 ** i).toFixed(i ? 2 : 0)} ${u[i]}`; };

    async function cmdCdn(ctx) {
        const media = findMedia(ctx.msg.message) || findMedia(commandContext(ctx.msg)?.quotedMessage);
        if (!media) {
            return say(ctx, withFooter(box('CDN UPLOAD', [row('Usage', `reply to a file, or send one with ${ctx.prefix}cdn as the caption`), row('Name', `${ctx.prefix}cdn my-file (optional)`)])));
        }
        await react(ctx, '⏳');
        const tmp = path.join(os.tmpdir(), `cdn-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
        try {
            // stream to disk, never the whole file in RAM
            let size = 0;
            const out = fs.createWriteStream(tmp);
            const stream = await downloadContentFromMessage(media.node, media.type);
            await new Promise((resolve, reject) => {
                stream.on('data', (c) => { size += c.length; if (!out.write(c)) { stream.pause(); out.once('drain', () => stream.resume()); } });
                stream.on('end', () => out.end(resolve));
                stream.on('error', reject); out.on('error', reject);
            });
            if (!size) throw new Error('The file could not be downloaded from WhatsApp');

            const ext = extensionFor(media);
            const custom = ctx.args.join(' ').trim().replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '');
            let fileName = custom ? (/\.[A-Za-z0-9]{1,8}$/.test(custom) ? custom : `${custom}.${ext}`) : (media.node.fileName || `file_${Date.now()}.${ext}`);
            if (!/\.[A-Za-z0-9]{1,8}$/.test(fileName)) fileName += `.${ext}`;

            const form = new FormData();
            const rs = fs.createReadStream(tmp); rs.on('error', () => {});
            form.append('file', rs, { filename: fileName, contentType: media.node.mimetype || 'application/octet-stream' });
            form.append('path', config.CDN_PATH || 'ice/');
            const base = String(config.CDN_BASE_URL || 'https://mrfranko-cdn.hf.space').replace(/\/+$/, '');
            const res = await axios.post(`${base}/upload`, form, {
                headers: { ...form.getHeaders(), 'X-API-Key': config.CDN_API_KEY },
                maxBodyLength: Infinity, maxContentLength: Infinity, timeout: 180000,
            });
            if (!res.data?.success) throw new Error(res.data?.message || 'Upload failed');
            let link = res.data.cdnUrl || res.data.url;
            if (!link) throw new Error('The CDN did not return a link');
            if (!/^https?:\/\//i.test(link)) link = `${base}/${String(link).replace(/^\/+/, '')}`;

            await react(ctx, '✅');
            const body = box('CDN UPLOAD', [row('File', clip(fileName, 40)), row('Size', formatBytes(size)), row('Link', link)]);
            if (ctx.helpers.isButtonsEnabled()) {
                await new Button(ctx.socket).setTitle('CDN UPLOAD').setBody(body).setFooter('subzero.mrfrankofc.com')
                    .addCopy('COPY LINK', link).addUrl('VISIT LINK', link)
                    .send(ctx.sender, { quoted: ctx.msg });
            } else {
                await say(ctx, withFooter(body));
            }
        } catch (err) {
            console.error('CDN upload error:', err.message);
            await react(ctx, '❌');
            await say(ctx, fail(`CDN upload failed: ${err.response?.data?.message || err.message}`));
        } finally {
            fs.promises.unlink(tmp).catch(() => {});
        }
    }

    // ------------------------------------------------------------ .post  (normal status on the connected account)

    const STATUS_COLORS = {
        purple: '#9C27B0', violet: '#7B1FA2', pink: '#E91E63', red: '#F44336', orange: '#FF5722', amber: '#FF8F00', yellow: '#FFC107',
        lime: '#8BC34A', green: '#4CAF50', teal: '#009688', cyan: '#00BCD4', blue: '#2196F3', navy: '#1565C0', indigo: '#3F51B5',
        black: '#212121', dark: '#263238', grey: '#607D8B', white: '#FAFAFA', brown: '#795548', gold: '#F9A825', maroon: '#880E4F',
    };
    const colorOf = (v) => {
        const x = String(v || '').toLowerCase().trim();
        if (x === 'random') { const k = Object.keys(STATUS_COLORS); return STATUS_COLORS[k[Math.floor(Math.random() * k.length)]]; }
        if (STATUS_COLORS[x]) return STATUS_COLORS[x];
        if (/^#?[0-9a-f]{6}$/i.test(x)) return x.startsWith('#') ? x : `#${x}`;
        return null;
    };
    function takeFlags(args, defs) {
        // defs: { '-color': true (takes a value), '-me': false }
        const out = {}; const rest = [];
        for (let i = 0; i < args.length; i++) {
            const a = String(args[i]).toLowerCase();
            if (a in defs) { if (defs[a]) out[a] = args[++i]; else out[a] = true; } else rest.push(args[i]);
        }
        return { flags: out, text: rest.join(' ').trim() };
    }
    async function mediaBuffer(media) {
        const stream = await downloadContentFromMessage(media.node, media.type);
        const chunks = []; let size = 0;
        for await (const c of stream) { size += c.length; if (size > 64 * 1024 * 1024) throw new Error('That file is too large for a status'); chunks.push(c); }
        return Buffer.concat(chunks);
    }

    const audienceCache = new WeakMap(); // socket -> { ts, list }
    // Who can see the status: everyone from your groups (phone numbers where known) plus the account itself.
    async function statusAudience(ctx) {
        const cached = audienceCache.get(ctx.socket);
        if (cached && Date.now() - cached.ts < 10 * 60 * 1000) return cached.list;
        const me = botJid(ctx);
        const set = new Set([me]);
        try {
            const groups = await ctx.socket.groupFetchAllParticipating();
            for (const g of Object.values(groups || {})) {
                for (const p of g.participants || []) {
                    const pn = p.phoneNumber || (/@s\.whatsapp\.net$/.test(p.id) ? p.id : null);
                    const j = String(pn || p.id || '').replace(/:\d+@/, '@');
                    if (j) set.add(j.includes('@') ? j : `${j}@s.whatsapp.net`);
                }
            }
        } catch (err) { console.warn('[post] could not read groups for the audience:', err.message); }
        const max = Math.max(1, Number(config.STATUS_MAX_AUDIENCE) || 1500);
        const list = [me, ...[...set].filter((j) => j !== me)].slice(0, max);
        audienceCache.set(ctx.socket, { ts: Date.now(), list });
        return list;
    }

    async function cmdPost(ctx) {
        if (await denyUnlessOwner(ctx)) return;
        const { flags, text } = takeFlags(ctx.args, { '-color': true, '-font': true, '-me': false, '-all': false });
        const media = findMedia(ctx.msg.message) || findMedia(commandContext(ctx.msg)?.quotedMessage);
        const quotedText = textFromPayload(commandContext(ctx.msg)?.quotedMessage);
        const body = text || (!media ? quotedText : '') || '';
        if (!media && !body) {
            return say(ctx, withFooter(box('POST STATUS', [
                row('Text', `${ctx.prefix}post <text>`),
                row('Media', `reply to an image / video / voice note with ${ctx.prefix}post [caption]`),
                row('Options', '-color <name|#hex|random>  -font 0-5  -me (only you)'),
                row('Colors', Object.keys(STATUS_COLORS).join(', ')),
            ])));
        }
        await react(ctx, '⏳');
        try {
            const color = colorOf(flags['-color']) || colorOf('random');
            const font = Math.min(5, Math.max(0, parseInt(flags['-font'], 10) || 0));
            let content;
            if (!media) content = { text: body, backgroundColor: color, font };
            else {
                const buf = await mediaBuffer(media);
                if (media.type === 'image' || media.type === 'sticker') content = { image: buf, caption: body || undefined };
                else if (media.type === 'video') content = { video: buf, caption: body || undefined };
                else if (media.type === 'audio') content = { audio: buf, mimetype: 'audio/ogg; codecs=opus', ptt: true, backgroundColor: color };
                else throw new Error('Statuses can be text, image, video or voice note');
            }
            const jids = flags['-me'] ? [botJid(ctx)] : await statusAudience(ctx);
            await ctx.socket.sendMessage('status@broadcast', content, { statusJidList: jids, backgroundColor: color, font });
            await react(ctx, '✅');
            return say(ctx, withFooter(box('STATUS POSTED', [row('Type', media ? media.type : 'text'), row('Visible to', flags['-me'] ? 'only you' : `${jids.length} people`)])));
        } catch (err) {
            console.error('[post]', err);
            await react(ctx, '❌');
            return say(ctx, fail(`Could not post the status: ${err.message}`));
        }
    }

    // ------------------------------------------------------------ .channelstatus / .cstatus  (post to your WhatsApp channel)

    async function resolveChannel(ctx, value) {
        const v = String(value || '').trim();
        if (/@newsletter$/.test(v)) return v;
        const m = v.match(/whatsapp\.com\/channel\/([\w-]+)/i);
        if (m) {
            const meta = await ctx.socket.newsletterMetadata('invite', m[1]);
            if (!meta?.id) throw new Error('Could not resolve that channel link');
            return meta.id;
        }
        return null;
    }

    async function cmdChannelStatus(ctx) {
        if (await denyUnlessOwner(ctx)) return;
        const first = ctx.args[0] || '';
        if (first.toLowerCase() === '-set') {
            try {
                const jid = await resolveChannel(ctx, ctx.args[1]);
                if (!jid) return say(ctx, withFooter(box('CHANNEL', [row('Usage', `${ctx.prefix}cstatus -set <channel link | id@newsletter>`)])));
                await saveConfig(ctx, (c) => { c.CHANNEL_JID = jid; });
                return say(ctx, withFooter(box('CHANNEL', [row('Default channel', jid)])));
            } catch (err) { return say(ctx, fail(err.message)); }
        }
        let target = null; let args = ctx.args;
        try { target = await resolveChannel(ctx, first); if (target) args = ctx.args.slice(1); } catch (err) { return say(ctx, fail(err.message)); }
        target = target || ctx.userConfig?.CHANNEL_JID || config.CHANNEL_JID;
        const media = findMedia(ctx.msg.message) || findMedia(commandContext(ctx.msg)?.quotedMessage);
        const body = args.join(' ').trim() || (!media ? textFromPayload(commandContext(ctx.msg)?.quotedMessage) : '');
        if (!target || (!media && !body)) {
            return say(ctx, withFooter(box('CHANNEL STATUS', [
                row('Post', `${ctx.prefix}cstatus <text>  or reply to media`),
                row('Other channel', `${ctx.prefix}cstatus <link|id> <text>`),
                row('Default', `${ctx.prefix}cstatus -set <link|id>`),
                row('Needs', 'you must own / admin the channel'),
            ])));
        }
        await react(ctx, '⏳');
        try {
            let content;
            if (!media) content = { text: body };
            else {
                const buf = await mediaBuffer(media);
                if (media.type === 'image' || media.type === 'sticker') content = { image: buf, caption: body || undefined };
                else if (media.type === 'video') content = { video: buf, caption: body || undefined };
                else if (media.type === 'audio') content = { audio: buf, mimetype: 'audio/mp4', ptt: false };
                else content = { document: buf, mimetype: media.node.mimetype || 'application/octet-stream', fileName: media.node.fileName || 'file', caption: body || undefined };
            }
            await ctx.socket.sendMessage(target, content);
            await react(ctx, '✅');
            return say(ctx, withFooter(box('CHANNEL STATUS', [row('Posted to', target), row('Type', media ? media.type : 'text')])));
        } catch (err) {
            console.error('[cstatus]', err);
            await react(ctx, '❌');
            return say(ctx, fail(`Could not post to the channel: ${err.message}`));
        }
    }

    // ------------------------------------------------------------ .mentionall

    async function cmdMentionAll(ctx) {
        if (!ctx.isGroup) return say(ctx, fail('This command works in groups only.'));
        if (!(ctx.isAdmins || ctx.isOwner || ctxSuper(ctx))) return say(ctx, withFooter(box('ACCESS DENIED', [row('Only', 'group admins and the bot owner')])));
        const qText = textFromPayload(commandContext(ctx.msg)?.quotedMessage);
        let text = ctx.args.join(' ').trim() || qText || '@all';
        if (!/@all\b/i.test(text)) text = `${text} @all`;
        await ctx.socket.sendMessage(ctx.sender, { text, mentionAll: true }, { quoted: ctx.msg });
    }

    const routes = [
        [['post', 'poststatus', 'mystatus'], cmdPost],
        [['channelstatus', 'cstatus', 'channelpost'], cmdChannelStatus],
        [['mentionall', 'tagall2'], cmdMentionAll],
        [['cdn', 'upload', 'tourl'], cmdCdn],
        [['getstatus', 'fetchstatus', 'getabout', 'userstatus'], cmdGetStatus],
        [['getpp', 'profilepic', 'pfp', 'userpp'], cmdGetPp],
        [['getmsg', 'rawmsg'], cmdGetMsg],
        [['try', 'replay'], cmdTry],
        [['gcstatus', 'groupstatus', 'gcs'], cmdGcStatus],
        [['setbotpp', 'setppbot', 'botpp'], cmdSetBotPp],
        [['removebotpp', 'delbotpp', 'rmbotpp'], cmdRemoveBotPp],
        [['setbotbio', 'botbio'], cmdSetBotBio],
        [['setbotname', 'botname'], cmdSetBotName],
        [['privacy'], cmdPrivacy],
        [['setonline', 'onlinenow'], cmdBotOnline],
        [['fakepresence', 'fakepres'], cmdFakePresence],
        ...Object.keys(PRIVACY).map((n) => [[n], privacyCommand(n)]),
    ];
    return { routes, PRIVACY };
};
