'use strict';
// SUBZERO MD MINI - shared chat themes (credit for the research: SILENT TECH)
//   .theme <colour>|off|list      solid background colour for EVERYONE in the chat
//   .bubblecolor <name>           bubble colour for everyone
//   .wallpaper                    reply to an image (or give a URL): chat background for everyone
//   .themecheck                   diagnostics: patch state, Baileys version, is the bot admin
//
// A theme is a protocolMessage type 34 with a chatThemeSetting (field 30). Baileys needs three fixes:
//  1. its proto drops field 30        -> ProtocolMessage.encode is patched to write it (tag 242)
//  2. relayMessage sends no mediatype -> messages-send.js gets a 'chat_theme' branch. This file is patched
//     ON DISK; because this module is loaded BEFORE Baileys (top of pair.js) the patch is normally live at once,
//     and only if Baileys was already loaded the bot restarts once.
//  3. no chat-wallpaper media type    -> the HKDF / upload-path maps get an entry at runtime
// WhatsApp rule: in a group the theme is DISCARDED unless the sender may edit group info, so the bot must be a
// group admin (or the group setting "Edit group info" = all participants). In a 1:1 chat it just works.

const fs = require('fs');
const path = require('path');

const COLORS = {
    red: 'FF0000', green: '00FF00', blue: '0000FF', yellow: 'FFFF00', orange: 'FF8000', pink: 'FF69B4', purple: '800080',
    black: '000000', white: 'FFFFFF', brown: 'A52A2A', grey: '808080', gray: '808080', cyan: '00FFFF', lime: '00FF00',
    gold: 'FFD700', silver: 'C0C0C0', maroon: '800000', navy: '000080', teal: '008080', magenta: 'FF00FF', violet: '8A2BE2',
    indigo: '4B0082', peach: 'FFDAB9', sky: '87CEEB', mint: '98FF98', coral: 'FF7F50', lavender: 'E6E6FA', crimson: 'DC143C',
    turquoise: '40E0D0'
};
const BUBBLES = {
    blue: 'Default-Blue@Minimal', tonal: 'Default-Blue@Tonal@Minimal', emerald: 'Emerald@Minimal', emeraldtonal: 'Emerald@Tonal@Minimal',
    pink: 'Pink@Minimal', red: 'Red@Minimal', royal: 'Royal-Blue@Minimal', purple: 'Tyrian-Purple@Minimal', green: 'WhatsApp-Green@Minimal'
};

// "red" | "#ff0000" | "FF0000" | "FF0000FF" -> 0xAARRGGBB number, or null
function argb(name) {
    const n = String(name || '').trim().toLowerCase();
    const hex = COLORS[n] || (/^#?[0-9a-f]{6}$/.test(n) ? n.replace('#', '').toUpperCase() : null);
    if (!hex) return null;
    return (0xFF000000 | parseInt(hex, 16)) >>> 0;
}

// ------------------------------------------------------------------ 1. proto patch

function patchProto(proto) {
    const M = proto && proto.Message;
    if (!M || M.__szThemePatched) return false;
    const PM = M.ProtocolMessage;
    if (PM) {
        if (PM.Type && PM.Type.CHAT_THEME_SETTING == null) { PM.Type.CHAT_THEME_SETTING = 34; PM.Type[34] = 'CHAT_THEME_SETTING'; }
        if (typeof PM.encode === 'function') {
            const prev = PM.encode;
            PM.encode = function (message, writer) {
                const cts = message && message.chatThemeSetting;
                if (cts && Object.prototype.hasOwnProperty.call(message, 'chatThemeSetting')) delete message.chatThemeSetting;
                const w = prev.call(this, message, writer);
                if (cts) {
                    message.chatThemeSetting = cts;
                    const sub = w.uint32(242).fork();
                    if (cts.settingTimestampMs != null) sub.uint32(8).int64(cts.settingTimestampMs);
                    if (cts.clearTheme) sub.uint32(16).bool(true);
                    if (cts.colorSchemeId) sub.uint32(26).string(cts.colorSchemeId);
                    if (cts.solidColor) {
                        const sc = sub.uint32(90).fork();
                        if (cts.solidColor.backgroundLightArgb != null) sc.uint32(13).fixed32(cts.solidColor.backgroundLightArgb >>> 0);
                        if (cts.solidColor.backgroundDarkArgb != null) sc.uint32(21).fixed32(cts.solidColor.backgroundDarkArgb >>> 0);
                        if (cts.solidColor.isDoodleEnabled != null) sc.uint32(24).bool(!!cts.solidColor.isDoodleEnabled);
                        sc.ldelim();
                    }
                    if (cts.customImage) {
                        const ci = sub.uint32(106).fork();
                        if (cts.customImage.directPath) ci.uint32(10).string(cts.customImage.directPath);
                        if (cts.customImage.mediaKey) ci.uint32(18).bytes(cts.customImage.mediaKey);
                        if (cts.customImage.fileEncSha256) ci.uint32(26).bytes(cts.customImage.fileEncSha256);
                        if (cts.customImage.fileSha256) ci.uint32(34).bytes(cts.customImage.fileSha256);
                        if (cts.customImage.dimLevel != null) ci.uint32(45).float(cts.customImage.dimLevel);
                        ci.ldelim();
                    }
                    sub.ldelim();
                }
                return w;
            };
        }
        if (typeof PM.fromObject === 'function') {
            const prevFrom = PM.fromObject;
            PM.fromObject = function (object) {
                const msg = prevFrom.call(this, object);
                if (object && object.chatThemeSetting) msg.chatThemeSetting = object.chatThemeSetting;
                return msg;
            };
        }
    }
    M.__szThemePatched = true;
    return true;
}

// ------------------------------------------------------------------ 2. server file patch (mediatype chat_theme)

const BRANCH = "        if (message.protocolMessage && message.protocolMessage.type === 34) {\n            return 'chat_theme';\n        }\n";

function candidateFiles() {
    const list = [];
    for (const pkg of ['baileys', '@whiskeysockets/baileys']) {
        try { list.push(path.join(path.dirname(require.resolve(pkg)), 'Socket', 'messages-send.js')); } catch { /* not resolvable */ }
        list.push(path.join(process.cwd(), 'node_modules', pkg, 'lib', 'Socket', 'messages-send.js'));
        list.push(path.join(__dirname, '..', 'node_modules', pkg, 'lib', 'Socket', 'messages-send.js'));
    }
    return [...new Set(list)];
}

// -> { state: 'present' | 'patched' | 'failed: ...', file }
function patchServerFile(files = candidateFiles()) {
    let lastErr = 'messages-send.js not found';
    for (const file of files) {
        try {
            if (!fs.existsSync(file)) continue;
            let src = fs.readFileSync(file, 'utf8');
            if (src.includes("return 'chat_theme';")) return { state: 'present', file };
            const re = /(const getMediaType\s*=\s*\(?\s*message\s*\)?\s*=>\s*\{\s*\n)/;
            if (!re.test(src)) { lastErr = 'getMediaType anchor not found in ' + file; continue; }
            src = src.replace(re, (m) => m + BRANCH);
            fs.writeFileSync(file, src);
            if (!fs.readFileSync(file, 'utf8').includes("return 'chat_theme';")) return { state: 'failed: write did not stick', file };
            return { state: 'patched', file };
        } catch (e) { lastErr = e.message || String(e); }
    }
    return { state: 'failed: ' + lastErr, file: files[0] };
}

// ------------------------------------------------------------------ 3. wallpaper maps

function fixWallpaperMappings() {
    try {
        const b = require('baileys');
        if (b.MEDIA_HKDF_KEY_MAPPING && b.MEDIA_HKDF_KEY_MAPPING['chat-wallpaper-image'] == null) b.MEDIA_HKDF_KEY_MAPPING['chat-wallpaper-image'] = 'Chat Wallpaper';
        if (b.MEDIA_PATH_MAP && b.MEDIA_PATH_MAP['chat-wallpaper-image'] == null) b.MEDIA_PATH_MAP['chat-wallpaper-image'] = '/mms/image';
    } catch { /* optional */ }
}

// ------------------------------------------------------------------ patch at load (before Baileys is required)

const baileysAlreadyLoaded = Object.keys(require.cache).some((k) => /[\\/]node_modules[\\/](@whiskeysockets[\\/])?baileys[\\/]/.test(k));
const server = patchServerFile();
// only a patched file + an already-loaded Baileys means the running process still lacks the branch
let needsRestart = server.state === 'patched' && baileysAlreadyLoaded;

// ------------------------------------------------------------------ commands

module.exports = function build(h) {
    const { box, say, withFooter, denyUnlessOwner, registry } = h;
    const sc = registry.smallcaps;
    const row = (k, v) => `▨ ${sc(k)} ⟜ ${v}`;
    const out = (ctx, title, lines) => say(ctx, withFooter(box(title, lines)));

    async function send(ctx, setting, what) {
        try { patchProto(require('baileys').proto); } catch { /* checked below */ }
        if (needsRestart) {
            await out(ctx, 'CHAT THEME', ['Server patch installed - restarting the bot once.', `Run ${ctx.prefix}${what} again in about 20 seconds.`]);
            setTimeout(() => process.exit(1), 1500); // non-zero so the guard / panel starts it again
            return false;
        }
        if (server.state.startsWith('failed')) { await out(ctx, 'CHAT THEME', ['The server patch could not be applied:', server.state, '', 'Themes cannot work without it.']); return false; }
        await ctx.socket.relayMessage(ctx.sender, {
            protocolMessage: { type: 34, chatThemeSetting: Object.assign({ settingTimestampMs: Date.now() }, setting) }
        }, { additionalAttributes: { type: 'media' } });
        if (ctx.isGroup && ctx.isBotAdmin === false) await out(ctx, 'CHAT THEME', ['Sent. If nothing changed: the bot must be a', 'group admin (or "Edit group info" = all', 'participants). That is WhatsApp\'s rule.']);
        return true;
    }

    async function cmdTheme(ctx) {
        if (await denyUnlessOwner(ctx)) return;
        const sub = String(ctx.args[0] || '').toLowerCase();
        if (!sub || sub === 'list' || sub === 'help') {
            return out(ctx, 'CHAT THEME', [
                'Background colour for everyone in this chat.', '', `${ctx.prefix}theme <colour>  set it`, `${ctx.prefix}theme off       back to default`, '',
                'Colours: ' + Object.keys(COLORS).join(', '), 'or a hex like FF0000', '',
                'In a group the bot must be admin (or "Edit', 'group info" = all participants).'
            ]);
        }
        if (['off', 'clear', 'default'].includes(sub)) {
            if (await send(ctx, { clearTheme: true }, 'theme off')) return out(ctx, 'CHAT THEME', ['Theme cleared for everyone.']);
            return;
        }
        const a = argb(sub);
        if (a == null) return out(ctx, 'CHAT THEME', [`Unknown colour "${sub}".`, `Use ${ctx.prefix}theme list`]);
        if (await send(ctx, { solidColor: { backgroundLightArgb: a, backgroundDarkArgb: a, isDoodleEnabled: false } }, `theme ${sub}`)) return out(ctx, 'CHAT THEME', [`Background set to ${sub} for everyone.`]);
    }

    async function cmdBubble(ctx) {
        if (await denyUnlessOwner(ctx)) return;
        const sub = String(ctx.args[0] || '').toLowerCase();
        if (!sub || sub === 'list' || sub === 'help') return out(ctx, 'BUBBLE COLOUR', [`${ctx.prefix}bubblecolor <name>`, '', Object.keys(BUBBLES).join(', ')]);
        if (!BUBBLES[sub]) return out(ctx, 'BUBBLE COLOUR', [`Unknown bubble "${sub}".`, Object.keys(BUBBLES).join(', ')]);
        if (await send(ctx, { colorSchemeId: BUBBLES[sub] }, `bubblecolor ${sub}`)) return out(ctx, 'BUBBLE COLOUR', [`Bubble colour set to ${sub} for everyone.`]);
    }

    async function cmdWallpaper(ctx) {
        if (await denyUnlessOwner(ctx)) return;
        const { downloadMediaMessage, encryptedStream } = require('baileys');
        try {
            const { quotedOf } = require('./vv');
            const qc = quotedOf(ctx.msg.message);
            const qm = qc && qc.quotedMessage;
            let media = null;
            if (qm && qm.imageMessage) {
                const key = { remoteJid: ctx.sender, id: qc.stanzaId, ...(qc.participant ? { participant: qc.participant } : {}) };
                media = await downloadMediaMessage({ key, message: qm }, 'buffer', {}, { logger: { level: 'silent', child() { return this; }, trace() {}, debug() {}, info() {}, warn() {}, error() {} }, reuploadRequest: (m) => ctx.socket.updateMediaMessage(m) });
                if (!Buffer.isBuffer(media) || !media.length) return out(ctx, 'WALLPAPER', ['Could not download that image.']);
            } else if (ctx.args[0] && /^https?:\/\//i.test(ctx.args[0])) media = { url: ctx.args[0] };
            else return out(ctx, 'WALLPAPER', ['Custom background for everyone.', '', `Reply to an image with ${ctx.prefix}wallpaper`, `or ${ctx.prefix}wallpaper <image-url>`, `${ctx.prefix}theme off removes it.`]);
            if (needsRestart || server.state.startsWith('failed')) return send(ctx, {}, 'wallpaper');
            fixWallpaperMappings();
            if (typeof encryptedStream !== 'function') return out(ctx, 'WALLPAPER', ['This Baileys version has no encryptedStream.']);
            const enc = await encryptedStream(media, 'chat-wallpaper-image', { logger: ctx.socket.logger });
            let directPath = null;
            try {
                const up = await ctx.socket.waUploadToServer(enc.encFilePath, { mediaType: 'chat-wallpaper-image', fileEncSha256B64: enc.fileEncSha256.toString('base64') });
                directPath = up && up.directPath;
            } finally { await fs.promises.unlink(enc.encFilePath).catch(() => {}); }
            if (!directPath) return out(ctx, 'WALLPAPER', ['Upload failed - the server returned no path.']);
            if (await send(ctx, { customImage: { directPath, mediaKey: enc.mediaKey, fileEncSha256: enc.fileEncSha256, fileSha256: enc.fileSha256, dimLevel: 0 } }, 'wallpaper')) return out(ctx, 'WALLPAPER', ['Wallpaper set for everyone.']);
        } catch (e) { return out(ctx, 'WALLPAPER FAILED', [String((e && e.message) || e).slice(0, 200)]); }
    }

    async function cmdThemeCheck(ctx) {
        if (await denyUnlessOwner(ctx)) return;
        let ver = '?'; let admin = '?';
        try { ver = JSON.parse(fs.readFileSync(path.join(path.dirname(server.file), '..', '..', 'package.json'), 'utf8')).version || '?'; } catch { /* unknown */ }
        if (ctx.isGroup) admin = String(!!ctx.isBotAdmin); else admin = 'n/a (not a group)';
        return out(ctx, 'THEME CHECK', [row('Patch', server.state), row('Restart needed', needsRestart ? 'yes' : 'no'), row('Baileys', ver), row('Bot is admin', admin), row('File', path.relative(process.cwd(), server.file || '') || '-')]);
    }

    return { routes: [[['theme', 'chattheme', 'wallcolor'], cmdTheme], [['bubblecolor', 'chatbubble', 'bubblecolour'], cmdBubble], [['wallpaper', 'wall', 'setwallpaper', 'chatwallpaper'], cmdWallpaper], [['themecheck', 'themestatus', 'checktheme'], cmdThemeCheck]] };
};
Object.assign(module.exports, { argb, patchProto, patchServerFile, COLORS, BUBBLES, state: () => ({ server, needsRestart }) });
