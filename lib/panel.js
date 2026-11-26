// SUBZERO MD MINI - round 10 commands (loaded by lib/newcmds.js, same helpers as lib/extras.js)
//
//   .pair <number>          pairing code made inside the bot (no HTTP / port) with COPY CODE + VISIT WEB buttons
//   .pin / .img <query> [n] Pinterest images as a swipeable carousel (default 5 cards)
//   .steps                  demo of the new AIRich "Thoughts / Steps" screen (text, sources, images)
//   .mrfrank [number|#]     super owner: every paired bot - paired date, usage, settings
//
// The message builder classes (Button, Carousel, AIRich) are in lib/messageBuilder.js.

const { prepareWAMessageMedia } = require('baileys');
const axios = require('axios');
const { AIRich, Button, Carousel } = require('./messageBuilder');
const config = require('../config');
const usage = require('./usage');
const webUrl = require('./webUrl');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const MAX_CARDS = 10;

module.exports = function build(h) {
    const { box, say, react, fail, withFooter, clip, ctxSuper, registry, digits, pickMenu, isLocked } = h;
    const sc = registry.smallcaps;
    const row = (k, v) => `▨ ${sc(k)} ⟜ ${v}`;
    const buttonsOn = (ctx) => { try { return !!ctx.helpers.isButtonsEnabled(); } catch { return false; } };

    // ------------------------------------------------------------------ .pair

    // .pair <number>: the pairing code is made inside the bot (no HTTP call, so the host's port never matters)
    // and sent here with COPY CODE + VISIT WEB buttons. The web link is auto-detected (lib/webUrl.js) and is
    // also what the user is pointed to if the code cannot be made.
    const pairBusy = new Map(); // sender -> last request time (stops code spam)
    async function cmdPair(ctx) {
        const number = digits(ctx.args.join(''));
        const web = await webUrl.get().then((w) => w.url).catch(() => '');
        const webButtons = (b) => (web ? b.addUrl('VISIT WEB TO CONNECT', web) : b);
        const sendCard = async (title, lines, extra) => {
            const body = box(title, lines);
            if (buttonsOn(ctx)) {
                try {
                    const b = new Button(ctx.socket).setTitle('PAIR').setBody(body).setFooter('subzero.mrfrankofc.com');
                    if (extra) extra(b);
                    return await webButtons(b).send(ctx.sender, { quoted: ctx.msg });
                } catch (err) { console.warn('[pair] buttons failed, sending text:', err.message); }
            }
            return say(ctx, withFooter(body));
        };

        if (number.length < 7 || number.length > 15) {
            return sendCard('PAIR YOUR NUMBER', [`Use: ${ctx.prefix}pair <number>`, `Example: ${ctx.prefix}pair 263719647303`, 'Country code, digits only.', '', ...(web ? [row('Web', web)] : [])]);
        }
        if (ctx.helpers.activeSockets && ctx.helpers.activeSockets.has(number)) {
            return sendCard('PAIR YOUR NUMBER', [`+${number} is already connected.`]);
        }
        const last = pairBusy.get(ctx.sender) || 0;
        if (Date.now() - last < 30000) return sendCard('PAIR YOUR NUMBER', ['Please wait a few seconds before', 'asking for another code.']);
        pairBusy.set(ctx.sender, Date.now());
        if (pairBusy.size > 500) pairBusy.delete(pairBusy.keys().next().value);

        await react(ctx, '⏳');
        let result;
        try {
            result = await ctx.helpers.pairNumber(number);
        } catch (err) {
            pairBusy.delete(ctx.sender);
            return sendCard('PAIR FAILED', [clip(err.message || 'Could not make a code', 120), '', 'Try again, or connect on the web:', ...(web ? [row('Web', web)] : [])]);
        }
        if (result && result.status === 'already_connected') return sendCard('PAIR YOUR NUMBER', [`+${number} is already connected.`]);
        const code = result && result.code;
        if (!code) {
            pairBusy.delete(ctx.sender);
            return sendCard('PAIR FAILED', [clip((result && (result.error || result.message)) || 'No code was returned', 120), '', 'Try again, or connect on the web:', ...(web ? [row('Web', web)] : [])]);
        }
        await react(ctx, '✅');
        const steps = ['1. WhatsApp → Settings → Linked devices', '2. Link a device → Link with phone number', '3. Enter the code above'];
        if (buttonsOn(ctx)) {
            return sendCard('PAIRING CODE', [row('Number', '+' + number), row('Code', code), '', ...steps], (b) => b.addCopy('COPY CODE', code));
        }
        // plain text: the code alone in its own message so it can be copied with one tap
        await say(ctx, withFooter(box('PAIRING CODE', [row('Number', '+' + number), '', ...steps, ...(web ? ['', row('Web', web)] : [])])));
        return say(ctx, code);
    }

    // ------------------------------------------------------------------ .pin / .img (carousel)

    async function pinterestUrls(query) {
        const res = await axios.get(`https://supun-md-api-xmjh.vercel.app/api/pinterest-search?q=${encodeURIComponent(query)}`, { timeout: 25000, headers: { 'User-Agent': UA } });
        const d = res.data || {};
        const list = d.results?.data || d.result || d.data || d.results || [];
        const urls = (Array.isArray(list) ? list : [])
            .map((x) => (typeof x === 'string' ? x : x?.image || x?.url || x?.src || ''))
            .filter((u) => /^https?:\/\//i.test(u));
        return [...new Set(urls)];
    }

    async function cmdPin(ctx) {
        let args = [...ctx.args];
        let count = 5;
        if (args.length > 1 && /^\d{1,2}$/.test(args[args.length - 1])) count = parseInt(args.pop(), 10);
        count = Math.min(Math.max(count, 1), MAX_CARDS);
        const query = args.join(' ').trim();
        if (!query) {
            return say(ctx, withFooter(box('IMAGE SEARCH', [row('Usage', `${ctx.prefix}pin <search> [count]`), row('Example', `${ctx.prefix}pin scooby doo 5`), row('Shows', `${count} images as a swipeable carousel`)])));
        }
        await react(ctx, '⏳');
        try {
            const urls = await pinterestUrls(query);
            if (!urls.length) throw new Error('No images found for that search');

            // the "thoughts / steps" bubble: what the bot did, with the source link and the first pictures
            if (config.PIN_STEPS !== false) await sendPinSteps(ctx, query, urls, count).catch((e) => console.warn('[pin] steps bubble skipped:', e.message));

            let sent = false;
            if (buttonsOn(ctx)) {
                try { sent = await sendCarousel(ctx, query, urls, count); } catch (err) { console.warn('[pin] carousel failed, sending images instead:', err.message); }
            }
            if (!sent) await sendAlbum(ctx, query, urls, count);
            await react(ctx, '✅');
        } catch (err) {
            console.error('[pin]', err.message);
            await react(ctx, '❌');
            await say(ctx, fail(err.message));
        }
    }

    async function sendPinSteps(ctx, query, urls, count) {
        const found = Math.min(urls.length, count);
        const rich = new AIRich(ctx.socket)
            .addProgress(`Found ${urls.length} images for “${clip(query, 40)}”`, { inProgress: false })
            .addSteps([
                { header: 'Searching Pinterest', body: `Query: ${query}`, sources: [{ url: `https://www.pinterest.com/search/pins/?q=${encodeURIComponent(query)}`, title: `Pinterest · ${query}`, favicon: 'https://www.pinterest.com/favicon.ico' }] },
                { header: `Picked ${found} of ${urls.length} images`, body: 'Preparing them as cards you can swipe through', images: urls.slice(0, Math.min(3, found)) },
                { header: 'Sending the carousel' },
            ]);
        await rich.send(ctx.sender, { quoted: ctx.msg });
    }

    async function sendCarousel(ctx, query, urls, count) {
        const { socket } = ctx;
        // upload a few spare images: any that fail to load are skipped and the next one takes their place
        const pool = urls.slice(0, Math.min(urls.length, count + 4));
        const prepared = await Promise.all(pool.map(async (u) => {
            try { const m = await prepareWAMessageMedia({ image: { url: u } }, { upload: socket.waUploadToServer }); return m.imageMessage ? { u, imageMessage: m.imageMessage } : null; } catch { return null; }
        }));
        const cards = prepared.filter(Boolean).slice(0, count);
        if (!cards.length) return false;

        const carousel = new Carousel(socket)
            .setBody(`${sc('Pinterest')} ⟜ ${clip(query, 50)}\n${cards.length} image${cards.length === 1 ? '' : 's'} · swipe →`)
            .setFooter('subzero.mrfrankofc.com');
        cards.forEach((c, i) => carousel.addCard({
            header: { title: `${i + 1} / ${cards.length}`, hasMediaAttachment: true, imageMessage: c.imageMessage },
            body: { text: clip(query, 60) },
            footer: { text: 'subzero.mrfrankofc.com' },
            nativeFlowMessage: { buttons: [{ name: 'cta_url', buttonParamsJson: JSON.stringify({ display_text: 'Open image', url: c.u, merchant_url: c.u }) }] },
        }));
        await carousel.send(ctx.sender, { quoted: ctx.msg });
        return true;
    }

    // buttons off (or the carousel was refused): plain images, one after the other
    async function sendAlbum(ctx, query, urls, count) {
        let sent = 0;
        for (const u of urls) {
            if (sent >= count) break;
            try {
                await ctx.socket.sendMessage(ctx.sender, { image: { url: u }, caption: sent === 0 ? withFooter(box('IMAGE SEARCH', [row('Search', clip(query, 50)), row('Images', `${Math.min(count, urls.length)}`)])) : undefined }, { quoted: ctx.msg });
                sent++;
            } catch { /* skip a dead link */ }
        }
        if (!sent) throw new Error('None of the images could be sent');
    }

    // ------------------------------------------------------------------ .steps (demo of the new AIRich screen)

    async function cmdSteps(ctx) {
        const IMG = 'https://mrfranko-cdn.hf.space/dm/smultra.png';
        try {
            const rich = new AIRich(ctx.socket)
                .addText('Tap **Thoughts** under this message to open the steps screen.')
                .addProgress('Full step demo', { inProgress: true })
                .addSteps([
                    { header: 'Title only' },
                    { header: 'Title + description', body: 'A step with a short explanation.' },
                    { header: 'With sources', body: 'Steps can link the pages that were used.', sources: [
                        { url: 'https://en.wikipedia.org/wiki/Coffee', title: 'Coffee — Wikipedia', favicon: 'https://en.wikipedia.org/static/images/icons/wikipedia.png' },
                        { url: 'https://github.com', title: 'GitHub', favicon: 'https://github.githubassets.com/favicons/favicon.png' },
                    ] },
                    { header: 'With an image', images: [IMG] },
                    { header: 'Description + image', body: 'Text and a picture together.', images: [IMG] },
                    { header: 'Everything', body: 'Description, image and sources.', images: [IMG], sources: [{ url: 'https://www.healthline.com/nutrition/coffee-benefits', title: 'Coffee: Health Benefits — Healthline', favicon: 'https://www.healthline.com/favicon.ico' }] },
                ]);
            await rich.send(ctx.sender, { quoted: ctx.msg });
        } catch (err) {
            console.error('[steps]', err);
            await say(ctx, fail(`The steps screen could not be sent: ${err.message}`));
        }
    }

    // ------------------------------------------------------------------ .mrfrank (super owner)

    const when = (t) => (t ? new Date(t).toLocaleString('en-GB', { timeZone: 'Africa/Harare', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'unknown');
    const ago = (t) => {
        if (!t) return '';
        const s = Math.max(0, Math.floor((Date.now() - new Date(t).getTime()) / 1000));
        if (s < 60) return 'just now';
        const d = Math.floor(s / 86400), hh = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
        return d ? `${d}d ${hh}h ago` : hh ? `${hh}h ${m}m ago` : `${m}m ago`;
    };
    const span = (ms) => { const d = Math.floor(ms / 86400000), hh = Math.floor((ms % 86400000) / 3600000), m = Math.floor((ms % 3600000) / 60000); return `${d ? d + 'd ' : ''}${hh}h ${m}m`; };
    const onoff = (v) => (String(v) === 'true' || v === true ? 'ON' : String(v) === 'false' || v === false ? 'OFF' : String(v));

    async function allBots(ctx) {
        const active = ctx.helpers.activeSockets;
        let sessions = [];
        try { sessions = await ctx.helpers.listSessions(); } catch (err) { console.warn('[mrfrank] session list unavailable:', err.message); }
        const byNumber = new Map(sessions.map((s) => [String(s.number), s]));
        for (const n of active.keys()) if (!byNumber.has(String(n))) byNumber.set(String(n), { number: String(n), config: {}, createdAt: null });
        return [...byNumber.values()].map((s) => {
            const n = String(s.number);
            const cfg = { ...config, ...(s.config || {}) };
            return { number: n, online: active.has(n), since: ctx.helpers.socketCreationTime.get(n) || null, paired: s.createdAt || usage.summary(n).first || null, lastActive: s.lastActive || s.updatedAt || null, cfg, saved: s.config || {}, use: usage.summary(n) };
        }).sort((a, b) => Number(b.online) - Number(a.online) || (b.use.commands - a.use.commands));
    }

    const SHOW = ['MODE', 'PREFIX', 'BUTTON_MODE', 'AUTO_VIEW_STATUS', 'AUTO_LIKE_STATUS', 'AUTO_RECORDING', 'ANTICALL', 'ANTIEDIT', 'ANTIDELETE', 'ANTI_LINK'];

    function settingsRows(b) {
        const rows = SHOW.filter((k) => b.cfg[k] !== undefined).map((k) => [k.replace(/_/g, ' ').toLowerCase(), k === 'MODE' ? String(b.cfg[k]).toUpperCase() : k === 'PREFIX' ? `${b.cfg[k]}` : onoff(b.cfg[k])]);
        // anything else this user changed away from the defaults
        const extra = Object.entries(b.saved || {}).filter(([k, v]) => !SHOW.includes(k) && ['string', 'number', 'boolean'].includes(typeof v) && config[k] !== undefined && String(config[k]) !== String(v)).slice(0, 10);
        extra.forEach(([k, v]) => rows.push([k.replace(/_/g, ' ').toLowerCase(), clip(String(v), 40)]));
        return rows;
    }

    async function cmdMrFrank(ctx) {
        if (!ctxSuper(ctx)) {
            return say(ctx, withFooter(box('ACCESS DENIED', [row('Only', 'the super owner')])));
        }
        await react(ctx, '⏳');
        let bots;
        try { bots = await allBots(ctx); } catch (err) { await react(ctx, '❌'); return say(ctx, fail(err.message)); }
        if (!bots.length) { await react(ctx, '❌'); return say(ctx, fail('No paired bots found.')); }

        const want = ctx.args[0] ? ctx.args[0].replace(/^\+/, '') : '';
        if (want) {
            const idx = /^\d{1,3}$/.test(want) ? parseInt(want, 10) - 1 : -1;
            const bot = idx >= 0 && idx < bots.length ? bots[idx] : bots.find((b) => b.number === digits(want) || b.number.endsWith(digits(want)));
            if (!bot) { await react(ctx, '❌'); return say(ctx, fail(`No paired bot matches “${want}”. Use ${ctx.prefix}mrfrank to see the list.`)); }
            await react(ctx, '✅');
            return sendDetails(ctx, bot, bots.length);
        }
        await react(ctx, '✅');
        return sendOverview(ctx, bots);
    }

    async function sendOverview(ctx, bots) {
        const online = bots.filter((b) => b.online).length;
        const totals = usage.totals();
        const shown = bots.slice(0, 25);
        try {
            const rich = new AIRich(ctx.socket)
                .addText(`**MR FRANK CONTROL**\n${bots.length} paired · ${online} online · ${totals.commands} commands run · ${totals.messages} messages seen`)
                .addTable([
                    ['#', 'Number', 'Status', 'Mode', 'Prefix', 'Paired', 'Cmds'],
                    ...shown.map((b, i) => [String(i + 1), `+${b.number}`, b.online ? 'online' : 'offline', String(b.cfg.MODE || '').toLowerCase(), String(b.cfg.PREFIX || ''), when(b.paired).split(',')[0], String(b.use.commands)]),
                ])
                .addTip(`${ctx.prefix}mrfrank <number or #> opens one bot`);
            await rich.send(ctx.sender, { quoted: ctx.msg });
        } catch (err) {
            console.warn('[mrfrank] rich overview failed, using text:', err.message);
            await say(ctx, withFooter(box('MR FRANK CONTROL', [
                row('Paired', bots.length), row('Online', online), row('Commands', totals.commands), '',
                ...shown.map((b, i) => `${i + 1}. +${b.number} ${b.online ? '🟢' : '⚪'} ${String(b.cfg.MODE || '')} ${b.use.commands} cmds`),
            ])));
        }
        // pick one to open
        const options = shown.slice(0, 20).map((b, i) => ({ label: `+${b.number}  ⟜ ${b.online ? 'online' : 'offline'} · ${b.use.commands} cmds`, value: String(i + 1) }));
        try {
            await pickMenu(ctx, { caption: withFooter(box('OPEN A BOT', [row('Paired', bots.length), row('Online', online)])), options }, async (value, messageData) => {
                const bot = shown[parseInt(value, 10) - 1];
                if (bot) await sendDetails({ ...ctx, msg: messageData }, bot, bots.length);
            });
        } catch (err) { console.warn('[mrfrank] picker failed:', err.message); }
    }

    async function sendDetails(ctx, b, total) {
        const u = b.use;
        const settings = settingsRows(b);
        const profile = [
            ['Number', `+${b.number}`],
            ['Status', b.online ? 'online' : 'offline'],
            ['Paired', when(b.paired) + (b.paired ? ` (${ago(b.paired)})` : '')],
            ['Connected for', b.online && b.since ? span(Date.now() - b.since) : '-'],
            ['Last active', b.lastActive ? `${when(b.lastActive)} (${ago(b.lastActive)})` : '-'],
            ['Locked', safeLocked(ctx, b.number) ? 'yes' : 'no'],
        ];
        const traffic = [
            ['Commands (total)', String(u.commands)],
            ['Commands (today / 7 days)', `${u.today} / ${u.week}`],
            ['Messages seen', String(u.messages)],
            ['Unique users', String(u.unique)],
            ['Last command', u.lastCommandAt ? ago(u.lastCommandAt) : '-'],
            ['Top commands', u.top.length ? u.top.map(([c, n]) => `${c} ${n}`).join(', ') : '-'],
        ];
        const note = u.tracked ? '' : '\nUsage counting started with this version, so older activity is not included.';
        try {
            const rich = new AIRich(ctx.socket)
                .addText(`**BOT +${b.number}**${note}`)
                .addTable([['Bot', 'Value'], ...profile])
                .addTable([['Traffic', 'Value'], ...traffic])
                .addTable([['Setting', 'Value'], ...(settings.length ? settings : [['-', 'defaults']])]);
            await rich.send(ctx.sender, { quoted: ctx.msg });
        } catch (err) {
            console.warn('[mrfrank] rich details failed, using text:', err.message);
            await say(ctx, withFooter(box(`BOT +${b.number}`, [...profile, ...traffic, ...settings].map(([k, v]) => row(k, v)))));
        }
        // quick actions
        if (buttonsOn(ctx)) {
            try {
                await new Button(ctx.socket).setTitle('MR FRANK').setBody(box('ACTIONS', [row('Bot', `+${b.number}`), row('List', `${ctx.prefix}mrfrank`)])).setFooter('subzero.mrfrankofc.com')
                    .addCopy('COPY NUMBER', b.number).addUrl('OPEN CHAT', `https://wa.me/${b.number}`).addReply('BACK TO LIST', `${ctx.prefix}mrfrank`)
                    .send(ctx.sender, { quoted: ctx.msg });
            } catch (err) { console.warn('[mrfrank] action buttons skipped:', err.message); }
        }
    }
    const safeLocked = (ctx, n) => { try { return typeof isLocked === 'function' ? !!isLocked(n) : false; } catch { return false; } };

    return {
        routes: [
            [['pair'], cmdPair],
            [['pinterest', 'pin', 'img', 'image'], cmdPin],
            [['steps', 'stepsdemo'], cmdSteps],
            [['mrfrank'], cmdMrFrank],
        ],
    };
};
