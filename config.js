require("dotenv").config();

const parseList = (envVar, fallback) => {
  if (!envVar) return fallback;
  try {
    return JSON.parse(envVar);
  } catch {
    return envVar
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
};

module.exports = {
  // MongoDB configuration for storing sessions
  MONGODB_URI:
    process.env.MONGODB_URI ||
    "mongodb+srv://darexmucheri:cMd7EoTwGglJGXwR@cluster0.uwf6z.mongodb.net/holid?retryWrites=true&w=majority&appName=Cluster0",

  // Bot behavior (these are defaults, can be overridden per-user in DB)
  AUTO_VIEW_STATUS: process.env.AUTO_VIEW_STATUS || "true",
  AUTO_LIKE_STATUS: process.env.AUTO_LIKE_STATUS || "true",
  AUTO_RECORDING: process.env.AUTO_RECORDING || "false",
  ANTICALL: process.env.ANTICALL || "true",
  ANTIEDIT: process.env.ANTIEDIT || "true",
  ANTIDELETE: process.env.ANTIDELETE || "true",
  ANTI_LINK: process.env.ANTI_LINK || "true",
  BUTTON_MODE: process.env.BUTTON_MODE || "true", // Enable/disable interactive buttons
  AUTO_LIKE_EMOJI: parseList(process.env.AUTO_LIKE_EMOJI, [
    "💋",
    "🍬",
    "🫆",
    "💗",
    "🎈",
    "🎉",
    "🥳",
    "❤️",
    "🧫",
    "🐭",
  ]),
  PREFIX: process.env.PREFIX || ".",
  MODE: process.env.MODE || "public", // public or private
  MAX_RETRIES: parseInt(process.env.MAX_RETRIES || "3", 10),

  // Paths
  ADMIN_LIST_PATH: process.env.ADMIN_LIST_PATH || "./admin.json",
  SESSION_BASE_PATH: process.env.SESSION_BASE_PATH || "./session",
  NUMBER_LIST_PATH: process.env.NUMBER_LIST_PATH || "./numbers.json",

  // Images / UI
  RCD_IMAGE_PATH:
    process.env.RCD_IMAGE_PATH ||
  //  "https://mrfranko-cdn.hf.space/dm/smultra.png",
    "https://mrfranko-cdn.hf.space/media/xerox_connected.png",
  CAPTION: process.env.CAPTION || "𝐒𝐔𝐁𝐙𝐄𝐑𝐎 𝐌𝐃 𝐌𝐈𝐍𝐈 🎀",

   // Newsletter / channels
  NEWSLETTER_JID: (
    process.env.NEWSLETTER_JID || "120363402507750390@newsletter"
  ).trim(),
  // Every channel listed here is followed each time a number connects, and every new post in it
  // gets an automatic reaction. Add more ids: NEWSLETTER_JIDS=1203...@newsletter,1203...@newsletter
  NEWSLETTER_JIDS: [
    ...new Set(
      [
        process.env.NEWSLETTER_JID || "120363402507750390@newsletter",
        ...String(process.env.NEWSLETTER_JIDS || "").split(","),
      ]
        .map((x) => x.trim())
        .filter((x) => x.endsWith("@newsletter"))
    ),
  ],
  AUTO_FOLLOW_CHANNELS: (process.env.AUTO_FOLLOW_CHANNELS || "true") !== "false",
  AUTO_REACT_CHANNELS: (process.env.AUTO_REACT_CHANNELS || "true") !== "false",
  // true = react in EVERY channel the number follows; false = only the ids in NEWSLETTER_JIDS
  AUTO_REACT_ALL_CHANNELS: (process.env.AUTO_REACT_ALL_CHANNELS || "true") !== "false",
  CHANNEL_REACT_EMOJIS: [
    "🔥","❤️","😍","🥰","💯","👏","🎉","✨","💥","🤩","😎","🙌","💪","🏆","🎊","🥳","😂","🫶","💜","💚","💛","🧡","🫡","🤝","👑",
  ],
  CHANNEL_REACT_BASIC: ["👍", "❤️", "😯", "😢", "🙏"],
  CHANNEL_LINK:
    process.env.CHANNEL_LINK ||
    "https://whatsapp.com/channel/0029Vb7D70MI7BeC0xUnKb05",

  // OTP & owner
  OTP_EXPIRY: parseInt(process.env.OTP_EXPIRY || "300000", 10), // ms
  OWNER_NUMBER: process.env.OWNER_NUMBER || "263719647303",
  DEV: process.env.DEV || "263719647303",

  // Telegram Bot Configuration
  TELEGRAM_BOT_TOKEN:
    process.env.TELEGRAM_BOT_TOKEN ||
    "8630688101:AAEW4EBM-BSWUT-5VyoT6CgxubTIGrx5Uic",
  TELEGRAM_OWNER_ID: process.env.TELEGRAM_OWNER_ID || "6959770734",

  // Misc
  GROUP_INVITE_LINK:
    process.env.GROUP_INVITE_LINK ||
    "https://chat.whatsapp.com/CNnLik1Wxp1K76fgblZxGv",
  PM2_NAME: process.env.PM2_NAME || "SUBZERO-MD",
  YT2_VIDEO_MAX: parseInt(process.env.YT2_VIDEO_MAX || "720", 10),

  // ================= ONE-FILE SETTINGS (everything below can be changed here) =================

  // Super owner(s): can run ANY command on ANY paired bot (including .lock / .unlock / .>).
  // Add the LID digits too if the number shows up as a @lid in your logs.
  SUPER_OWNERS: parseList(process.env.SUPER_OWNERS, [
    "263719647303",
    "25770239992037",
    "214302325760156",
    "227903916765325",
    "132779283087413",
  ]),

  // Who receives the "new number connected" notification (phone numbers, digits only).
  // The paired user always gets their own welcome message as well.
  CONNECT_NOTIFY_NUMBERS: parseList(process.env.CONNECT_NOTIFY_NUMBERS, ["263719647301"]),

  // Default image used by .menu / .allmenu / category menus (owners can override with .setmenuimage)
  MENU_IMAGE:
    process.env.MENU_IMAGE || "https://mrfranko-cdn.hf.space/media/gen.png",

  // Shown to the paired owner when their bot is locked with .lock
  LOCK_MESSAGE:
    process.env.LOCK_MESSAGE || "Your bot has been locked. To unlock it, contact Mr Frank: wa.me/263719647303",
   
  // ---- .cdn / .upload / .tourl (Mr Frank CDN) ----
  CDN_BASE_URL: process.env.CDN_BASE_URL || "https://mrfranko-cdn.hf.space",
  CDN_API_KEY: process.env.CDN_API_KEY || "subzero",
  CDN_PATH: process.env.CDN_PATH || "minibot_cdn/",

  // ---- labels / status ----
  // Adds WhatsApp's "secure service from Meta" label (secureMetaServiceLabel) to menus and similar replies.
  SECURE_LABEL: process.env.SECURE_LABEL ? process.env.SECURE_LABEL !== "false" : true,
  // .post: most people a status is sent to (everyone in your groups + you). Lower it if sending is slow.
  STATUS_MAX_AUDIENCE: parseInt(process.env.STATUS_MAX_AUDIENCE || "1500", 10),
  // .cstatus default channel (a ...@newsletter id). Can also be set with .cstatus -set <id|link>.
  // .pair shows a 'visit web to connect' button. The address is auto-detected (lib/webUrl.js: hosting-platform
  // variables, panel IP:port, or public IP + the port the server really bound to). Set PAIR_WEB_URL only to force one.
  PAIR_WEB_URL: process.env.PAIR_WEB_URL || process.env.WEB_URL || "",
  PAIR_WEB_FALLBACK: process.env.PAIR_WEB_FALLBACK || "https://subzero.mrfrankofc.com",
  // .pin / .img also sends the 'Thoughts / Steps' bubble (new AIRich steps screen) before the carousel
  PIN_STEPS: (process.env.PIN_STEPS || "true") !== "false",
  // ---- view-once saver (.vv2 + silent reply triggers) ----
  ANDROID_IDENTITY: process.env.ANDROID_IDENTITY || "true",   // phone-type identity once registered (needed for view-once); "false" = old web identity
  AUDIO_STICKER_IMAGE: process.env.AUDIO_STICKER_IMAGE || "",     // default picture for .saudio when none was saved (URL or file); empty = menu image
  VV_CMD: process.env.VV_CMD || "vv2",
  VV_DEST: process.env.VV_DEST || "bot",                      // bot = the bot's own DM, owner = OWNER_NUMBER, or a number
  VV_TRIGGERS: (process.env.VV_TRIGGERS || "lol,keep,wtf").split(",").map(x => x.trim()).filter(Boolean),
  VV_TRIGGERS_ON: process.env.VV_TRIGGERS_ON || "true",
  CHANNEL_JID: process.env.CHANNEL_JID || "120363402507750390@newsletter",

  // ---- Downloader / API settings ----
  KYIO_API_BASE: process.env.KYIO_API_BASE || "https://api.kyio.web.id",
  OMEGA_API_BASE: process.env.OMEGA_API_BASE || "https://api.omegatech.app",
  // Extra providers (samples supplied by Mr Frank). They run in the speed race next to kyio.
  EXTRA_PROVIDERS: process.env.EXTRA_PROVIDERS || "true",
  NEXRAY_API_BASE: process.env.NEXRAY_API_BASE || "https://api.nexray.eu.cc",
  AZBRY_API_BASE: process.env.AZBRY_API_BASE || "https://api.azbry.com",
  FAA_API_BASE: process.env.FAA_API_BASE || "https://api-faa.my.id",
  // Providers are tried fastest-first; the next one is started in parallel if the current one has not
  // answered after this many ms (so a slow API never makes the user wait).
  API_HEDGE_MS: parseInt(process.env.API_HEDGE_MS || "1500", 10),
  // Media is streamed to a temp file (never held in RAM). Hard size cap in MB:
  MAX_MEDIA_MB: parseInt(process.env.MAX_MEDIA_MB || "500", 10),
  // Videos bigger than this are sent as a document instead of inline video:
  VIDEO_DOC_MB: parseInt(process.env.VIDEO_DOC_MB || "100", 10),

  // Log level: "fatal" in production, "debug" otherwise
  NODE_ENV: process.env.NODE_ENV || "development",
};
