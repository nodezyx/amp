// SUBZERO MD MINI - command registry + menu renderer
//
// The registry below is the single source of truth for every menu in the bot
// (.menu, .allmenu and every per-category menu). Menus are rendered from it at
// request time, so they always use the caller's current prefix.
//
// It is also self-healing: on load we scan pair.js for command labels and any
// command that exists in the switch but is not in the registry is added to an
// "Other" category automatically - a newly added command shows up in .allmenu
// without anyone having to remember to list it.

const fs = require('fs');
const path = require('path');

// [ name, aliases[], usage/description ]
const C = (name, aliases = [], desc = '') => ({ name, aliases, desc });

const CATEGORIES = [
    {
        id: 'main', icon: '🏠', title: 'MAIN', menuNames: ['mainmenu'],
        commands: [
            C('menu', [], 'Quick menu'),
            C('allmenu', ['menuall', 'commands', 'help'], 'Every command'),
            C('alive', [], 'Is the bot online?'),
            C('ping', ['speed', 'pong'], 'Response speed'),
            C('owner', ['dev', 'developer', 'creator'], 'Owner contact'),
            C('callowner', ['messageowner'], 'Message the owner'),
            C('repo', ['source', 'sourcecode', 'code', 'buy'], 'Buy the bot from Mr Frank'),
            C('about', ['info', 'botinfo'], 'About this bot'),
            C('support', ['contact'], 'Support group'),
            C('channel', ['updates'], 'Official channel'),
            C('pair', [], '‹number› Pairing code (copy + web buttons)'),
        ],
    },
    {
        id: 'download', icon: '📥', title: 'DOWNLOAD', menuNames: ['dlmenu', 'downloadmenu'],
        commands: [
            C('alldownload', ['alldl', 'aio', 'download', 'dl'], '‹link› Any supported link'),
            C('tiktok', ['tt'], '‹link› TikTok'),
            C('instagram', ['ig'], '‹link› Instagram'),
            C('facebook', ['fb', 'fbvideo'], '‹link› Facebook'),
            C('twitter', ['x', 'xdl'], '‹link› X / Twitter'),
            C('play', [], '‹name|link› Audio / Document / Video buttons'),
            C('song', ['ytaudio', 'ytmp3'], '‹name|link› YouTube audio'),
            C('song2', ['ytaudio2', 'ytmp3pc'], '‹name|link› YouTube audio (scraper 2)'),
            C('video2', ['ytvideo2', 'ytmp4pc'], '‹name|link› [quality] YouTube video (scraper 2)'),
            C('video', ['vid', 'ytmp4', 'ytvideo', 'ytmax', 'ytpro'], '‹name|link› YouTube video'),
            C('apk', ['modapk', 'apkdownload'], '‹app› APK download'),
            C('mediafire', ['mf', 'mfire'], '‹link› MediaFire'),
            C('gitclone', ['clone', 'repodownload'], '‹repo link› GitHub repo zip'),
            C('pinterest', ['pin', 'img', 'image'], '‹query› [count] Images as a carousel'),
            C('anime', ['animevideo', 'animevid'], '‹name› Anime'),
            C('cinesubz', [], '‹movie› Movies'),
        ],
    },
    {
        id: 'search', icon: '🔍', title: 'SEARCH', menuNames: ['searchmenu', 'search'],
        commands: [
            C('yts', ['yt', 'ytsearch'], '‹query› YouTube search (reply #)'),
            C('lyrics', [], '‹song› Song lyrics'),
            C('imdb', ['movie'], '‹title› Movie info'),
            C('weather', ['cuaca'], '‹city› Weather'),
            C('wallpaper', ['wp'], '‹query› Wallpapers'),
            C('npm', ['npmpkg', 'npmsearch'], '‹package› NPM package'),
            C('gitstalk', ['githubstalk', 'ghstalk'], '‹user› GitHub profile'),
            C('githubrepo', ['ghrepo', 'reposearch'], '‹query› GitHub repos'),
        ],
    },
    {
        id: 'ai', icon: '🤖', title: 'AI', menuNames: ['aimenu', 'aimenuu'],
        commands: [
            C('ai', ['ask'], '‹question› AI chat'),
            C('gpt', [], '‹question› GPT'),
            C('gemini', [], '‹question› Gemini'),
            C('claude', [], '‹question› Claude'),
            C('llama', [], '‹question› Llama'),
            C('deepseek', [], '‹question› DeepSeek'),
            C('aisearch', ['ais'], '‹question› AI with web search'),
            C('newchat', ['aireset'], 'Reset your AI memory'),
            C('aiimg', [], '‹prompt› Generate an image'),
            C('ai2', [], '‹question› Venice AI'),
            C('remini', ['enhance', 'hq', 'qualityup'], '↩ image: enhance'),
            C('removebg', ['rmbg', 'nobg', 'transparentbg'], '↩ image: remove background'),
        ],
    },
    {
        id: 'tools', icon: '🛠', title: 'TOOLS', menuNames: ['toolsmenu', 'tools'],
        commands: [
            C('sticker', ['s', 'stickergif'], '↩ image/video: sticker'),
            C('take', ['rename', 'stake'], '↩ sticker: rename'),
            C('tourl', ['cdn', 'upload'], '↩ media: get a link'),
            C('webss', [], '‹url› Website screenshot'),
            C('tinyurl', ['shorten', 'shorturl'], '‹url› Shorten link'),
            C('qrread', ['scanqr', 'readqr', 'scanqrcode'], '↩ image: read QR'),
            C('fancy', [], '‹text› Fancy fonts'),
            C('logo', [], '‹text› Logo maker'),
            C('vv', ['rvo', 'viewonce', 'save', 'keep', 'lol', 'nice'], '↩ view-once: reveal'),
            C('saudio', ['audiosticker', 'stickeraudio', 'asticker'], '↩ video/image+audio: audio sticker'),
            C('selfdestruct', ['burn', 'vanish'], '‹seconds› ‹text› vanishing text'),
            C('theme', ['chattheme', 'wallcolor'], '‹colour|off› chat background for all'),
            C('bubblecolor', ['chatbubble', 'bubblecolour'], '‹name› bubble colour for all'),
            C('wallpaper', ['wall', 'setwallpaper', 'chatwallpaper'], '↩ image: chat wallpaper for all'),
            C('themecheck', ['themestatus', 'checktheme'], 'theme patch diagnostics'),
            C('vv2', ['vo', 'rvo2', 'viewonce2'], '↩ view-once: save silently'),
            C('setvvcmd', ['setvv', 'vvcommand'], 'rename the .vv2 command'),
            C('vvdest', ['vvto'], 'view-once save destination'),
            C('vvtrigger', ['vvtriggers', 'vvwords'], 'silent reply words for view-once'),
            C('fullpp', ['setpp', 'setdp', 'pp'], '↩ image: profile photo'),
            C('fakemsg', [], 'Fake message'),
            C('zoom', [], 'Zoom image'),
            C('vot', ['viewoncetext', 'vtext'], '‹text› Send text as view-once'),
            C('vcf', ['contacts', 'savecontacts'], 'Group contacts file'),
            C('html', ['renderhtml'], 'Render HTML'),
        ],
    },
    {
        id: 'group', icon: '👥', title: 'GROUP', menuNames: ['groupmenu'],
        commands: [
            C('mentionall', ['tagall2'], '‹text› Mention everyone with the native @all'),
            C('gcstatus', ['groupstatus', 'gcs'], '‹text› or reply to media: post a group status (admins)'),
            C('kick', ['remove'], '@user Remove member'),
            C('add', [], '‹number› Add member'),
            C('promote', ['admin'], '@user Make admin'),
            C('demote', [], '@user Remove admin'),
            C('mute', ['lock', 'close'], 'Admins-only chat'),
            C('unmute', ['unlock', 'open'], 'Everyone can chat'),
            C('kickall', [], 'Remove all non-admins'),
            C('hidetag', ['htag'], '‹text› Hidden tag'),
            C('tagall', [], 'Tag everyone'),
            C('invite', ['grouplink', 'glink'], 'Group link'),
            C('revoke', ['resetlink'], 'Reset group link'),
            C('ginfo', ['groupinfo'], 'Group info'),
            C('updategname', ['setgroupname'], '‹name› Rename group'),
            C('updategdesc', ['setgroupdesc'], '‹text› Group description'),
            C('opentime', [], '‹time› Auto-open'),
            C('closetime', [], '‹time› Auto-close'),
            C('antilink', ['antlink'], 'on / off  Delete links'),
            C('leave', ['exit'], 'Bot leaves the group'),
        ],
    },
    {
        id: 'games', icon: '🎮', title: 'GAMES & FUN', menuNames: ['gamemenu', 'games'],
        commands: [
            C('hangman'), C('rps'), C('8ball'), C('dice'), C('coinflip', ['flip']),
            C('slots'), C('slotspro'), C('blackjack', ['bj']), C('roulette'), C('rroulette', ['rr', 'shoot']),
            C('diceduel'), C('coinx'), C('craps'), C('baccarat'), C('hilo'), C('numguess'), C('jackpot'),
            C('wallet', ['bal', 'balance']), C('daily'), C('work'), C('beg'), C('hunt'), C('sell'),
            C('send', ['pay']), C('addcoins'), C('removecoins'),
            C('aura'), C('roast'), C('compliment'), C('lovetest'), C('emoji'),
            C('compatibility', ['friend', 'fcheck']), C('joke', ['jokes']),
        ],
    },
    {
        id: 'owner', icon: '👑', title: 'OWNER', menuNames: ['ownermenu', 'ownercommands'],
        commands: [
            C('settings', ['setting', 'config'], 'All settings'),
            C('setprefix', ['prefix'], '‹new prefix›'),
            C('mode', [], 'public / private'),
            C('buttons', ['buttonmode'], 'on / off  Interactive buttons'),
            C('presence', ['setpresence'], 'Menu: online, offline, typing, recording, auto'),
            C('alwaysonline', ['online', 'botonline'], 'on / off  Stay online'),
            C('anticall', ['antical'], 'on / off'),
            C('antiedit', ['ae'], 'on / private / off'),
            C('antidelete', ['antidel', 'ad'], 'on / off / gc / dm / status'),
            C('autoviewstatus', ['viewstatus'], 'on / off'),
            C('autoreactstatus', ['reactstatus'], 'on / off'),
            C('autorecording', ['setautorecording'], 'on / off'),
            C('autoreact', [], 'on / off'),
            C('setsudo', ['addsudo', 'addowner'], '@user Add sudo'),
            C('delsudo', ['delowner', 'deletesudo'], '@user Remove sudo'),
            C('listsudo', ['listowner'], 'List sudo users'),
            C('ban', ['blockuser', 'addban'], '@user Ban from bot'),
            C('unban', ['removeban'], '@user Unban'),
            C('listban', ['banlist', 'bannedusers'], 'List banned users'),
            C('block', [], '@user Block on WhatsApp'),
            C('unblock', [], '@user Unblock'),
            C('cid', ['newsletter', 'channelid', 'channelinfo'], '‹channel link›'),
            C('setmenuimage', ['menuimage', 'setmenupic'], 'Reply to an image or send a link'),
            C('lock', [], '‹number› Lock a bot (super owner)'),
            C('unlock', [], '‹number› Unlock a bot (super owner)'),
            C('locklist', ['lockedbots'], 'List locked bots'),
            C('>', ['exec'], '‹code› Run JavaScript (super owner)'),
            C('post', ['poststatus', 'mystatus'], '‹text› or reply to media: post a status on this account'),
            C('channelstatus', ['cstatus', 'channelpost'], '‹text› or reply to media: post to your channel'),
            C('getstatus', ['fetchstatus', 'getabout', 'userstatus'], '‹number / reply› Fetch a user\'s about text'),
            C('getpp', ['profilepic', 'pfp', 'userpp'], '‹number / reply› Fetch a profile picture (add low for low res)'),
            C('setbotpp', ['setppbot', 'botpp'], 'Reply to an image: bot profile picture'),
            C('removebotpp', ['delbotpp', 'rmbotpp'], 'Remove bot profile picture'),
            C('setbotbio', ['botbio'], '‹text› Bot about text'),
            C('setbotname', ['botname'], '‹name› Bot profile name'),
            C('privacy', [], 'Show privacy settings'),
            C('lastseen', [], 'all / contacts / contact_blacklist / none'),
            C('ppprivacy', [], 'Profile picture privacy'),
            C('statusprivacy', [], 'About privacy'),
            C('onlineprivacy', [], 'all / match_last_seen'),
            C('readreceipts', [], 'all / none'),
            C('groupadd', [], 'Who can add you to groups'),
            C('callprivacy', [], 'all / known'),
            C('messagesprivacy', [], 'all / contacts'),
            C('setonline', ['onlinenow'], 'on / off  Appear online now'),
            C('fakepresence', ['fakepres'], 'typing / recording / paused ‹seconds›'),
            C('perf', ['health', 'load'], 'super owner: bot load & memory'),
            C('mrfrank', [], '[number|#] All paired bots: paired date, usage, settings (super owner)'),
            C('steps', ['stepsdemo'], 'Demo of the new Thoughts / Steps message'),
            C('getmsg', ['rawmsg'], 'Reply to a message: raw JSON (super owner)'),
            C('try', ['replay'], 'Replay a raw JSON message (super owner)'),
            C('deleteme', [], 'Delete your session'),
        ],
    },
];

// Labels that exist in the switch but must never appear in a menu.
const HIDDEN = new Set([
    'button', 'testbuttonv2', 'dmsg', 'testcarousel', 'testairich', 'htmlgames', 'testhtmlapp',
    'testsound', 'testtoolkit', 'gcstory', 'exec', '>', 'dhd', '0', '1', '2', '3', '4', '5', '6', '7', '8',
    'on', 'off', 'status', 'bomb',
]);

function knownNames() {
    const set = new Set();
    CATEGORIES.forEach((c) => c.commands.forEach((cmd) => { set.add(cmd.name); cmd.aliases.forEach((a) => set.add(a)); }));
    CATEGORIES.forEach((c) => c.menuNames.forEach((n) => set.add(n)));
    return set;
}

// Scan pair.js for top-level `case 'xyz':` labels and collect the ones nobody registered.
function discoverUnlisted() {
    try {
        const src = fs.readFileSync(path.join(__dirname, '..', 'pair.js'), 'utf-8');
        const known = knownNames();
        const found = new Set();
        const re = /^(?: {14})?case '([a-z0-9]+)':/gm;
        let m;
        while ((m = re.exec(src))) {
            const name = m[1];
            if (!known.has(name) && !HIDDEN.has(name)) found.add(name);
        }
        return [...found].sort();
    } catch {
        return [];
    }
}

const OTHER = { id: 'other', icon: '✨', title: 'OTHER', menuNames: ['othermenu'], commands: [] };
function getCategories() {
    const extra = discoverUnlisted();
    if (!extra.length) return CATEGORIES;
    return [...CATEGORIES, { ...OTHER, commands: extra.map((n) => C(n)) }];
}

// ---------------------------------------------------------------- renderers

// Mathematical sans-serif bold, e.g. bold('MR FRANK OFC') -> 𝗠𝗥 𝗙𝗥𝗔𝗡𝗞 𝗢𝗙𝗖
function bold(text) {
    return Array.from(String(text)).map((ch) => {
        const c = ch.codePointAt(0);
        if (c >= 65 && c <= 90) return String.fromCodePoint(0x1D5D4 + c - 65);
        if (c >= 97 && c <= 122) return String.fromCodePoint(0x1D5EE + c - 97);
        if (c >= 48 && c <= 57) return String.fromCodePoint(0x1D7EC + c - 48);
        return ch;
    }).join('');
}

// Small capitals, e.g. smallcaps('Uptime') -> ᴜᴘᴛɪᴍᴇ
const SC = { a: 'ᴀ', b: 'ʙ', c: 'ᴄ', d: 'ᴅ', e: 'ᴇ', f: 'ғ', g: 'ɢ', h: 'ʜ', i: 'ɪ', j: 'ᴊ', k: 'ᴋ', l: 'ʟ', m: 'ᴍ', n: 'ɴ', o: 'ᴏ', p: 'ᴘ', q: 'ǫ', r: 'ʀ', s: 's', t: 'ᴛ', u: 'ᴜ', v: 'ᴠ', w: 'ᴡ', x: 'x', y: 'ʏ', z: 'ᴢ' };
const smallcaps = (text) => Array.from(String(text).toLowerCase()).map((ch) => SC[ch] || ch).join('');

const LINE = '━━━━━━━━━━━━━━━━'; // short on purpose: fits a phone screen without wrapping

// Compact list, names only - used by .allmenu
function renderCategoryCompact(cat, prefix) {
    let out = `╭${LINE}⟢\n┃ ◈ ${bold(cat.title)}  ⟜ ${cat.commands.length}\n┣${LINE}\n`;
    cat.commands.forEach((c) => { out += `┃ ▣ ${prefix}${c.name}\n`; });
    out += `╰${LINE}⟢`;
    return out;
}

// One line each, always short: command on the first line, a trimmed small-caps hint under it.
const clipText = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
function renderCategoryDetailed(cat, prefix) {
    let out = `╭${LINE}⟢\n┃ ◈ ${bold(cat.title)}  ⟜ ${cat.commands.length}\n┣${LINE}\n`;
    cat.commands.forEach((c) => {
        out += `┃ ▣ ${prefix}${c.name}\n`;
        if (c.desc) out += `┃    ⟜ ${smallcaps(clipText(c.desc.replace(/‹[^›]*›\s*/g, ''), 26))}\n`;
    });
    out += `╰${LINE}⟢`;
    return out;
}

// Which category does a menu command name belong to?
function findCategoryByMenu(command) {
    return getCategories().find((c) => c.menuNames.includes(command)) || null;
}

function allMenuNames() {
    const names = [];
    getCategories().forEach((c) => c.menuNames.forEach((n) => names.push(n)));
    return names;
}

function totalCommands() {
    return getCategories().reduce((n, c) => n + c.commands.length, 0);
}

module.exports = {
    bold, smallcaps, LINE, getCategories, renderCategoryCompact, renderCategoryDetailed,
    findCategoryByMenu, allMenuNames, totalCommands,
};
