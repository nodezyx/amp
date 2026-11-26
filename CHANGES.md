# SUBZERO MD MINI – v2 changes

## New files
| File | What it does |
|---|---|
| `lib/api.js` | Every external API in one place (kyio downloader, YouTube, X, Facebook, omegatech AI + lyrics). Returns one normalised shape for all platforms. |
| `lib/commands.js` | Command registry. `.menu`, `.allmenu` and every `<category>menu` are rendered from it. Commands found in `pair.js` but missing from the registry are added to "Other" automatically. |
| `lib/newcmds.js` | v2 command handlers. Runs **before** the legacy `switch` in `pair.js`, so these win over old duplicates. |
| `data/antidel.js` | Real anti-delete store (was a stub → `.settings` crashed). |
| `data/antilink.js` | Per-group antilink store (file was missing → antilink never worked). |

## How the new APIs are used
| Command | Endpoint |
|---|---|
| `.alldownload` (`.alldl`, `.aio`), `.ig` | `GET api.kyio.web.id/api/v2/downloader/aio-v2?url=` (falls back to `aiodl`) |
| `.tiktok` | `GET api.kyio.web.id/api/v2/aiodl?url=` (falls back to `aio-v2`) |
| `.song` / `.play` / `.ytmp3`, `.video` / `.ytmp4` | `GET api.kyio.web.id/api/v2/ytdl?q=` (falls back to `yt-fast` if it errors; names are resolved with `yt-search`) |
| `.x` / `.twitter` | `GET api.kyio.web.id/api/v2/twitter-v2?q=` |
| `.fb` | `GET api.kyio.web.id/api/v2/downloader/fb-v3?q=` |
| `.lyrics` | `GET api.omegatech.app/api/tools/lyrics?query=` |
| `.ai .gpt .gemini .claude .llama .deepseek .aisearch` | `GET api.omegatech.app/api/ai/Chatbot?action=chat&message=&sessionId=&needSearch=` |

Base URLs can be overridden with `KYIO_API_BASE` / `OMEGA_API_BASE` env vars if a provider moves.
Each AI command keeps its own conversation per user (sessionId = `<model>-<user>`); `.newchat` resets it.

## Bugs fixed
* **`.setprefix` not responding** – the dispatcher re-declared `prefix`/`command` from the *default* prefix inside the `try` block, so after a change every command resolved to nothing. It also read `m.body`, which is empty for button taps. Both now come from the user's saved prefix.
* **`.settings` crashed** – `getAllAnti` didn't exist.
* **`.ig` / `.fb` / `.tiktok` sent the whole message (`.ig https://…`) to the API** instead of just the link.
* **`.setsudo` / `.ban` took up to 5 minutes to apply** (cached lists) – now read live.
* Sudo/ban matching now works for phone-number and `@lid` senders.
* `isOwner` used substring matching (`"263…".includes("")` is true) – now exact.
* View-once messages made `body` an object and crashed `body.startsWith`.
* Old raw `buttons:[…]` messages in owner commands (don't render on current WhatsApp) replaced by native-flow `Button` messages.
* `.unblock` required a reply even in a DM.

## Uniformity
* One reply style (boxed panel + footer) for every new command; same `on/off` handling, aliases, and permission messages for every owner command.
* Footer everywhere: `© 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ` + `subzero.mrfrankofc.com`.

## Round 2
* `.repo` / `.source` / `.code` / `.buy` – all repo info removed (also deleted the old case from `pair.js`). Now a "for sale" message with a button that opens Mr Frank's inbox (`wa.me/<OWNER_NUMBER>` with a pre-filled message).
* `.menu` – classic interactive menu again: category picker list (generated from the registry), Join Channel + Owner buttons, `limited_time_offer` banner (**Expires on…**) and bottom-sheet styling.
* `.allmenu` – a single image message. Designed header (dev, runtime, server, ping, date, time, users, prefix, mode, RAM, command count) followed by every category, all in the caption. Only if it ever exceeds WhatsApp's caption limit does the overflow continue as text.
* `.lyrics` – lyrics text + a native-flow message with a **Copy Lyrics** (`cta_copy`) button and a source link.
* `.pair` – pairing code arrives in a native-flow message with a **Copy Code** button (plain-text fallback when buttons are off).
* `.song/.play/.ytmp3`, `.video/.ytmp4` – use `/api/v2/ytdl?q=`.
* `.ig` / `.alldownload` – use `aio-v2`; each downloader automatically falls back to the other endpoint, and the preferred endpoint's error message is the one shown.
* **Anti-delete fixed** – WhatsApp delivers "delete for everyone" as a `REVOKE` in `messages.upsert`; the old code only listened to `messages.delete`, which doesn't fire for it. The store also destroyed media keys (so deleted images/videos could never be re-downloaded) and statuses were never stored.
* **Anti-edit fixed** – the default `ANTIEDIT="true"` fell into an "invalid mode" branch; newer WhatsApp wraps edits in `editedMessage`; private mode used a device-suffixed JID.
* `.vot <text>` (`.viewoncetext`, `.vtext`) – sends text as a **view-once** card (WhatsApp has no native view-once text, so it is rendered to an image).
* `.presence online|offline|typing|recording|paused` and `.alwaysonline on|off` (`.online`) – the latter keeps the account online and is restored on every reconnect.

## Round 3
* **sharp install failure** – `sharp` 0.32 downloaded libvips from GitHub (504). Bumped to `^0.33.5` (ships as npm packages) + `overrides`; CI install retries once.
* **Anti-delete / anti-edit hardening** (`pair.js`, `handleAntiDelete`): self-contained listeners on `messages.upsert` **and** `messages.update`; every message of every batch is stored (the old pipeline only looked at the first message of a batch); lookups fall back to the message id so `@lid` vs phone-JID DMs match; edits/deletes reported once even if both events fire; Long-typed timestamps no longer break anti-edit. Console now logs `[ANTIDELETE] revoke seen…` / `…not in the store…` so problems are diagnosable.

## Round 4 – Downloader fix (`aio: status true`, `yt-fast: status true`, `facebook: status true`)
- Root cause: the live kyio API replies with `status: true`; the client only accepted `200` and treated anything else as an error.
- `lib/api.js`: tolerant envelope handling (`true`/200/"success"/missing = OK; only explicit failures throw, with the provider's own message).
- `lib/api.js`: generic media discovery fallback, so renamed fields (`data.formats`, `links.mp4`, etc.) still produce downloads. The raw response shape is logged to the console if nothing is found.
- Covers .ig, .alldl, .tiktok, .fb, .x, .play/.song, .video, .ytmp3, .ytmp4.
- Only `lib/api.js` and `CHANGES.md` changed.

## Round 5 – Menu redesign + presence menu
- Menus no longer use emojis. New symbols: ◈ titles, ▣ commands, ▨ info rows, ⟜ separators.
- Category titles, info labels and button rows use the bold font (𝗠𝗥 𝗙𝗥𝗔𝗡𝗞 𝗢𝗙𝗖 style). Helper: `bold()` in `lib/commands.js`.
- Redesigned `.menu`, `.allmenu` header, every category block and `<category>menu` pages. Footer globe emoji replaced with ◈.
- `.presence` now opens a menu (online, offline, typing, recording, paused, auto online on/off) and shows the current state. `.presence auto on|off` toggles always-online.
- Files changed: `lib/commands.js`, `lib/newcmds.js`, `pair.js` (footer symbol only), `CHANGES.md`.
- New plugins from the API docs: skipped, the docs site is not reachable from the sandbox.

## Round 6
- `.menu` top info labels use small caps (ᴜsᴇʀ, ᴘʀᴇғɪx ...).
- Downloaders: every platform has several providers. They are ranked by measured speed, the fastest is tried first, and the next one starts in parallel if it is slow (`API_HEDGE_MS`) or fails. First good answer wins. Added fallbacks: tikwm (TikTok), community extras (`EXTRA_PROVIDERS`, unverified), and the aio endpoints for X and Facebook.
- Media is streamed to a temp file on disk and sent from the path (no RAM buffering), then the temp file is deleted. Cap: `MAX_MEDIA_MB`. Videos above `VIDEO_DOC_MB` go as documents.
- `.play`: no search result, three buttons AUDIO MP3 DOC / AUDIO / VIDEO. `.video`: shows qualities when the API has several. `.song`/`.video`/`.yts` with a name: numbered results, reply with a number.
- Connection notice goes to `CONNECT_NOTIFY_NUMBERS` (once per number per run).
- Settings moved into `config.js`: SUPER_OWNERS, CONNECT_NOTIFY_NUMBERS, MENU_IMAGE, LOCK_MESSAGE, KYIO/OMEGA/EXTRA bases, API_HEDGE_MS, MAX_MEDIA_MB, VIDEO_DOC_MB, NODE_ENV, PM2_NAME.
- The paired number owns its own bot: private anti-delete forwards go to that number's inbox.
- `.>` / `.exec` rebuilt (super owner only; multi-line, await, console.log, works without prefix). Super owners are never banned or locked.
- New: `.lock <number>`, `.unlock <number>`, `.locklist` (super owner). A locked bot ignores all commands and tells its owner to contact Mr Frank.
- New: `.setmenuimage` (reply to an image, or a link; `reset` for default).

## Round 7
- Real providers from Mr Frank's samples replace my guessed ones: nexray (`/downloader/aio`, `/downloader/ytmp3`), azbry (`/api/download/ytmp3|ytmp4|instagram|allinonev2|tiktok`), faa (`/faa/ytplayvid`). tikwm kept. siputzx removed. Bases are in `config.js` (`NEXRAY_API_BASE`, `AZBRY_API_BASE`, `FAA_API_BASE`).
- YouTube now knows what it needs: audio races every provider; video/both try the quality-capable kyio providers first and use the single-quality ones as the safety net.
- Menus: small caps for labels and hints, shorter lines that fit a phone screen, hints under each command.
- `.menu`: numbered categories (1. 2. 3. ...). Reply with a number (quoting the menu) to open that category; it also works with buttons on.
- `.allmenu`: only the header shows until "Read more"; the full command list is behind it.
- Downloaders and `.play` show the cover image of the item (fetched by the bot so hot-link protected images still work).
- `.owner` and `.settings` rebuilt with the message builder: URL / copy / reply buttons, tap-to-switch settings list, contact card.
- Owner checks unified: super owner, the paired number (phone JID, fromMe or @lid) and the config owner all pass the same checks. Removed the per-command re-checks in `pair.js` that compared against `config.OWNER_NUMBER` only (they refused the paired owner and LID senders).

## Round 8 – button / reply fix
- Why `.ig`, `.fb`, `.play` buttons did nothing: the reply listener only accepted a tap if WhatsApp attached the quoted message id, which button replies often do not carry. It also ignored wrapped messages (disappearing chats), legacy button replies, only looked at the first message of a batch, and stopped after the first tap. Rewrote `awaitInteractiveReply` in `pair.js`: matches the unique session id, unwraps messages, handles native-flow / legacy / list replies, number replies, and checks the whole batch.
- Prompts stay live for 2 minutes (pick audio, then video; retry after a failure). Double taps on the same message are ignored.
- Non-button mode crashed when a prompt had a cover image (Buffer passed as a URL). Fixed in `sendInteractiveOptions` / `sendInteractiveList`.
- `.menu`: no numbers when buttons are on (clean list); numbered list + reply-a-number only when buttons are off.
- `.play` re-fetches if the first lookup failed.

## Round 9 – getmsg/try, group status, bot profile, privacy, faster `.play`
| File | Change |
|---|---|
| `lib/extras.js` (new) | `.getmsg` / `.try` (super owner; JSON shown with the AIRich **code block** builder + full JSON file; `.try` replays via `relayMessage`), `.gcstatus` wrapper, bot profile + privacy + presence commands. |
| `lib/gcstatus.js` (new) | Your gcstatus module, ported: `-list`, numbers / ranges / `all` / raw JIDs, `-color`, `-audience`, channel-reshare relay, text/image/video/sticker/audio. Uses the bot prefix + footer. Needs `fluent-ffmpeg` + ffmpeg only for audio statuses (loaded lazily). |
| `lib/newcmds.js` | Routes for the above. `.play` rebuilt (see below). Download choices (ig/fb/tiktok/video quality) are now ALL CAPS with no emoji. |
| `lib/api.js` | YouTube video/both: the fallback tier now starts after 3.5 s (or at once if the primary fails) and the first success wins, instead of waiting for the primary to fail. |
| `lib/commands.js` | New commands listed in the owner / group menus. |
| `pair.js` | Numbered-reply hint is now small caps, no emoji. |

**Permissions**
- `.getmsg`, `.try`: super owner only.
- `.gcstatus`: group admins in their own group (text/media, `-color`, `-audience` for that group). Owner / super owner also get `-list`, numbers, ranges, `all`, raw JIDs and DM mode.
- `.setbotpp .removebotpp .setbotbio .setbotname .privacy .lastseen .ppprivacy .statusprivacy .onlineprivacy .readreceipts .groupadd .callprivacy .messagesprivacy .setonline .fakepresence`: bot owner (paired number) / super owner.

**Bot profile + privacy** (Baileys `updateProfilePicture`, `removeProfilePicture`, `updateProfileStatus`, `updateProfileName`, `update*Privacy`, `fetchPrivacySettings`, `sendPresenceUpdate`)
- `.setbotpp` (reply to an image or give a link), `.removebotpp`, `.setbotbio <text>` (max 139), `.setbotname <name>` (max 25).
- `.privacy` shows every setting; each setter takes the values Baileys accepts (`all|contacts|contact_blacklist|none`, `all|match_last_seen`, `all|none`, `all|known`, `all|contacts`). Friendly aliases: everyone, nobody, contact, known.
- `.setonline on|off` (appear online/offline now), `.fakepresence typing|recording|paused [seconds]` in the current chat. Auto presence stays in `.presence`.

**`.play`**
- Heading **SUBZERO YT DOWNLOADER** with title, channel, duration, views, published, video ID, link and description.
- Faster: one cached search (links use a direct id lookup), cover fetched in parallel, and the audio **and** video download links are requested the moment the menu is built, so a tap only has to stream the file.
- Buttons: AUDIO MP3 DOC / AUDIO / VIDEO (all caps).

## Round 9b – anti-delete / anti-edit rebuild, user status + profile picture, `.play` send fix
- **Phone numbers, not LIDs** (`pair.js` `resolvePhone`): `participantAlt` / `remoteJidAlt`, then WhatsApp's LID→number mapping, then the group participant list. Only if none knows the number does it say "hidden by WhatsApp".
- **Send-to mode** for both features: `chat` (same chat), `private` (the bot's own inbox) or `owner` (the owner number from `config.OWNER_NUMBER`).
  - `.antidelete chat|private|owner` (plus the buttons), `.antiedit on|private|owner|off`, and the same cycle in `.settings`.
- **Anti-edit rewritten** from your reference: unwraps ephemeral / view-once / captions (image, video, document, audio), skips unchanged text, reports every edit (v1→v2, then v2→v3), still reports when the original was not stored (and remembers it for later edits), shows sent / edited times, and no longer depends on mention-only names.
- **`.getstatus <number|reply|@mention>`** (`sock.fetchStatus`) and **`.getpp <number|reply|@mention> [low]`** (`sock.profilePictureUrl`, high res by default).
- **`.play` fix**: audio and video now come from one lookup through the same providers `.video` uses, retried with a fresh provider lookup if the send fails; inline audio that WhatsApp refuses is re-sent as a file.

## Round 9c – primaries, broken-file guard, video menu, lyrics, CDN
- **`.play` audio**: `https://api.azbry.com/api/download/ytplay?q=` is now the first provider (checked against the picked video id); nexray ytmp3, azbry ytmp3, kyio ytdl and yt-fast are fallbacks.
- **`.video` / VIDEO button**: `https://api-faa.my.id/faa/ytmp4?url=` is the first provider; azbry ytmp4, kyio ytdl, yt-fast and faa ytplayvid are fallbacks.
- **The "52 KB file" problem**: every download is now checked before it is sent: cut-off transfers, HTML/JSON error pages, and files far smaller than the song/video length allows (audio < 20% of the 128 kbps size, video < 10% of ~240 kbps, min 30 KB / 120 KB) are rejected, and the next provider is tried automatically. In strict mode WhatsApp is never asked to pull the URL itself, so a broken link can no longer produce a tiny file.
- **`.video` menu**: when kyio also lists several qualities, a button list (or numbered reply with buttons off) appears: VIDEO DEFAULT (the faa download), then 1080P, 720P... Search results for `.song` / `.video` / `.yts` are also button lists now.
- **`.lyrics`**: `https://api-faa.my.id/faa/lyrics?q=` first (time stamps like `[00:15.15]` are stripped), omegatech as fallback.
- **`.cdn` / `.upload` / `.tourl`**: new domain `https://mrfranko-cdn.hf.space` (`CDN_BASE_URL`, `CDN_API_KEY`, `CDN_PATH` in `config.js`). The `.dat` bug is fixed: the old code compared WhatsApp's message type ("imageMessage") with mime types, so nothing ever matched. The extension now comes from the file name, then the mime type, then the mime subtype. Files stream to disk instead of RAM, and the result has COPY LINK and VISIT LINK buttons.

## Round 9d – `.getmsg` / `.try` rebuilt, `.play` prefetch + racing
Learned from the bot-crm zip (protobuf round trip, full original instead of the reply stub):
- **`.getmsg`** exports with `proto.Message.toObject({ bytes: String, longs: Number, enums: Number })`, so mediaKey / hashes / thumbnails are base64 and survive. It uses the full original from the bot's own message store when it has it (`source: store`), otherwise WhatsApp's reply stub (`source: quoted`). The chat code block summarises long base64 values (`<base64 N chars>`); the attached JSON file holds everything.
- **`.try`** order: JSON typed after the command → quoted `.json` file → quoted text that is JSON (code fences are stripped) → the quoted message itself → the last `.getmsg`. It rebuilds with `proto.Message.fromObject`, wraps with `generateWAMessageFromContent` and relays with a fresh message id (`generateMessageIDV2`). Wrappers are handled with Baileys' `normalizeMessageContent`.
- **`.play` speed**: as soon as the menu appears the song is looked up AND downloaded to a temp file in the background, so AUDIO / AUDIO MP3 DOC send immediately. Providers now race (the next starts when one fails or after 7 s of nothing) and the first valid file wins; late files are deleted. An untouched file is deleted after 4 minutes.
- `pair.js` passes `getStoredMessage` to the command layer.

## Round 9e

- **.getmsg / .try now keep everything.** New `lib/rawstore.js` keeps the exact protobuf bytes of every incoming message (and the stanza node), so features Baileys does not know about yet are not lost. `.getmsg` sends the FULL JSON in several code blocks plus a `.json` file, and remembers it by message id, so `.try` works when you reply to any of them. `.try` replays the exact bytes; flags: `plain` (rebuild from decoded JSON), `nodes` (also resend extra stanza nodes). If the raw patch fails its self-test it switches itself off and the old behaviour is used.
- **.gcstatus** checked: reads wrapped messages (ephemeral/view-once/caption), finds reply info on any message type, and media attached to the command itself is posted.
- **.post** (owner): normal status from the connected account. Text (`-color name|#hex|random`, `-font 0-5`), image, video, voice note (reply or attach, optional caption), `-me` = only you. Audience = people from your groups + you, capped by `STATUS_MAX_AUDIENCE`.
- **.channelstatus / .cstatus** (owner): post text/image/video/audio/document to a WhatsApp channel. `.cstatus -set <link|id@newsletter>` saves the default; `.cstatus <link|id> <text>` posts elsewhere.
- **.mentionall** (group admins/owner): native `mentionAll:true`, quoted, `@all` added if missing.
- **Secure Meta label**: `secureMetaServiceLabel:true` on menu, allmenu, category menus and owner info. Turn off with `SECURE_LABEL` in config.js.

## Round 9f

- **Auto channel follow + react.** `config.js` has `NEWSLETTER_JIDS` (your `NEWSLETTER_JID` plus any ids in the `NEWSLETTER_JIDS` env var, comma separated). Every time a number connects it follows all of them (plus the remote list that was already used). Every new post in those channels gets a random reaction from `CHANNEL_REACT_EMOJIS`; if the channel only allows basic reactions it falls back to `CHANNEL_REACT_BASIC`. Switches: `AUTO_FOLLOW_CHANNELS`, `AUTO_REACT_CHANNELS`. The post id is read from `key.server_id` (as in your example), falling back to `newsletterServerId`.

## Round 9g

- **.fb** now uses `api.nexray.eu.cc/downloader/facebook` first (the old providers stay as fallbacks). A single video is sent straight away, with no choice menu; the author, duration and thumbnail come from the API.
- **.song / .play audio** now start with `nexray/fast`: nexray `ytplay` (by title, checked to be the same video) and nexray `ytmp3` (by link) run at the same time and the first answer wins. If the file turns out broken or 404s, the old chain (azbry ytplay, azbry ytmp3, kyio) takes over automatically.
- **main.html** redesigned: Replit-style boxes loader on page load and while the code is generated, glass card with step tracker, code shown as boxes, timer bar, feature boxes, mobile layout, reduced-motion support. Same element ids and `/code?number=` call as before.

## Round 9h

- **.song2 / .video2** (new): use the ytmp3pc scraper you sent (`lib/ytmp3pc.js`, your code plus a request timeout). A name is searched with the scraper first (yt-search as backup), a link is used directly. `.song2` takes the first mp3 quality; `.video2` takes the highest quality up to `YT2_VIDEO_MAX` (default 720) and `.video2 <name|link> 480` picks a quality. The file is downloaded with the Origin/Referer the scraper needs and sent through the same checked pipeline as the other downloaders.
- **.play / .song unplayable audio fixed.** The audio type used to be guessed from the server's content-type header, which is usually generic, so webm / ogg / fragmented-mp4 files were sent labelled "mp3" and would not play. New `lib/audiofix.js` reads the real bytes: mp3 and opus are sent as they are, mp4 is remuxed, anything else is converted to mp3 with ffmpeg when the host has it, and if it cannot be converted it is sent as a file instead of a broken voice bubble. Audio also no longer falls back to "let WhatsApp fetch the URL" (which produced the same unplayable result).
- **core.38 (1.18 GB crash dump) fixed.** It is a Linux core dump written when Node died hard (out of memory). New `lib/guard.js`, started from `bot.js` and `index.js`: runs the bot with `ulimit -c 0` (no dumps), a heap cap (`SZ_HEAP_MB`, default 450), restarts it if it crashes (brake after 5 crashes a minute), deletes any `core*` / heap dump files at start and every 5 minutes, deletes temp files older than 15 minutes, and logs the app folder size and memory once an hour.
- **Memory:** the in-memory message store (anti-delete / .getmsg) is now capped (`STORE_MAX_MESSAGES` default 4000, `STORE_TTL_HOURS` default 12) instead of keeping every message for 24 h; the raw-byte store has a 24 MB ceiling. Default `MAX_MEDIA_MB` lowered from 500 to 100 so a download can never fill the disk.

## Round 10

- **Channels.** Follow now starts the moment a number connects, on its own, so a failure in the join-group / admin-message steps can no longer skip it. The bot also keeps a live-updates subscription going for every channel (re-done every 4 minutes) - WhatsApp only pushes new channel posts to subscribed clients, which is why reacting could stay silent. Every channel post in EVERY channel the number follows now gets a reaction (`AUTO_REACT_ALL_CHANNELS=false` limits it to `NEWSLETTER_JIDS`); one reaction per post, big emoji pool with the basic set as fallback.
- **.pair** rebuilt: the code is made inside the bot (`pairNumber` helper), so the hosting port no longer matters. Buttons: COPY CODE and VISIT WEB TO CONNECT (`PAIR_WEB_URL` in config.js, default https://subzero.mrfrankofc.com - set it to your deployed site). If the code cannot be made it still offers the web button. 20 s cooldown per sender.
- **.pin / .img / .pinterest <search> [count]**: images from the API as a swipeable carousel (default 5, max 10). Dead images are skipped and replaced. With buttons off it sends plain images. Before the carousel it sends the new "Thoughts / Steps" bubble (`PIN_STEPS=false` turns that off).
- **AIRich** (lib/messageBuilder.js): new `addProgress()`, `addSteps()` and `AIRich.stepEntry()` from the code you sent (text, sources, images per step). `.steps` shows all six entry kinds.
- **.mrfrank [number|#]** (super owner): overview table of every paired bot with a picker, then details: paired date, connected time, last active, lock state, commands (total / today / 7 days), messages, unique users, top commands, and settings (mode, prefix, button mode, auto status, anti-delete/edit/call/link, anything else changed from the defaults). Built with AIRich tables and Button actions. Reads sessions without loading creds. New `lib/usage.js` counts usage in `data/usage.json` (counting starts with this version).

## Round 11

### .pair
- `.pair <number>` makes the pairing code on WhatsApp again (in-process, no HTTP, so the host's port never matters) and sends it with COPY CODE + VISIT WEB TO CONNECT buttons. Plain text mode sends the code alone for one-tap copy.
- The web link is auto-detected (`lib/webUrl.js`): PAIR_WEB_URL, Render/Railway/Heroku/Koyeb/Fly/Replit/Codespaces vars, panel SERVER_IP:SERVER_PORT, or public IP + the port the server really bound to; falls back to `PAIR_WEB_FALLBACK`. If a code cannot be made, the reply shows the error and the web link.

### View-once saver (`lib/vv.js`)
- `.vv2` (aliases `.vo .rvo2 .viewonce2`): reply to a view-once, it is saved to the destination DM. Uses the stored original first, then the quoted copy; `downloadMediaMessage` with re-upload, then `downloadContentFromMessage`; failures are explained in the destination DM only.
- Silent triggers: reply `lol`, `keep` or `wtf` (or your own text/emoji) to a view-once - nothing is sent to the chat. Owner only; ignored when the reply is not to a view-once.
- `.vvtrigger list|add <w>|remove <w>|on|off|reset`, `.vvdest bot|owner|<number>`, `.setvvcmd <name>|reset`. Defaults in config.js (`VV_*`).
- Socket now has `getMessage` and uses the Android identity once a session is registered (`ANDROID_IDENTITY=false` to disable; needs Baileys >= 7.0.0-rc14; web identity while pairing).
- `.vv` (legacy, reveals in chat) is unchanged.

### Scale: 50-100 bots (`lib/perf.js`)
- Group metadata cached per bot (was a network call on every group message).
- creds saved to disk at once but to MongoDB at most every 10 s per bot.
- Startup reconnect: 4 at a time with a short stagger (was one by one); reconnect after a drop: random spread, max 5 at once.
- A stray error no longer restarts every bot: restart only after 8 errors in 60 s.
- Logger is `fatal` unless `LOG_LEVEL` is set (debug logging of every frame was a CPU/disk hog); history sync off.
- ffmpeg limited to a few at a time; lock check and usage saving no longer block on disk.
- Heap cap scales with the host's memory (55%, 450 MB to 3 GB); `SZ_HEAP_MB` overrides.
- `.perf` (super owner): bots online, memory per bot, event-loop lag, cache hits, queues.

### Honest notes
- Nothing was run against live WhatsApp; logic is covered by offline tests (run.js 119, anti.js 28, chan.js 6, perf.js 5).
- 100 bots in one process realistically needs 2 GB+ RAM; under 1 GB expect roughly 20-30.

### Round 11 fix (core.NN file + slow pairing)
- Heap cap no longer scales from the host's total RAM (that let the bot grow past the panel limit and crash with a 1 GB+ core file). Default is 450 MB, up to 900 MB only if a container memory limit is visible; `SZ_HEAP_MB` overrides.
- Credentials reach MongoDB immediately on the first change and when the connection opens/closes (then at most every 10 s). The 10 s delay could let a restart after pairing restore stale creds and make pairing hang. Stale database creds can no longer overwrite a fresher local registered session; unfinished pairings are not saved as sessions.

### Round 11 fix 2 (some bots slow to respond after connecting)
- Cause: on EVERY connect/reconnect each bot sent two image messages, waited 3 s and retried joining the support group, one bot after another in the same flow, and only then was marked active. With many bots that flooded the connection and some answered late.
- Now: the bot is active the moment the socket opens; welcome/settings/admin messages and the group join run in the background, 2 bots at a time, and the welcome + group join happen only once per number (`WELCOMED` flag in its settings). `WELCOME_ON_RECONNECT=true` restores the old behaviour.
- Channel follow/subscribe runs in the background, 3 bots at a time.
- Settings lookup now fetches only the config (not the whole credentials document) and concurrent lookups share one query.

## Round 12

### .vv2 hardening
- The command now shows progress on the command message: ⏳ then ✅ saved / ❌ failed (silent triggers stay fully silent). Not replying to anything gives a usage card in the chat instead of a hidden DM note.
- Downloads time out after 90 s (a stuck download no longer hangs); `owner` destination falls back to the bot DM when no owner number is set; trigger words tolerate trailing `.` `!` `?`.
- Reminder: WhatsApp only gives view-once media to a phone-type session, so the bot must have been online when it arrived, and you must reply BEFORE opening it on the phone. A failure explains itself in the destination DM (what the bot had, mediaKey yes/no).

### Audio stickers: `.saudio` (aliases .audiosticker .stickeraudio .asticker) - `lib/saudio.js`
- Reply a VIDEO: one step, its picture + sound become an audio sticker (tap = sound). Picture kept moving as long as the size limit allows.
- Two steps: reply an image/sticker (saved 5 min, per sender; video as picture: `.saudio visual`), then reply an audio/voice note (or a video: its sound is used). An audio replied to with nothing saved uses the default image (`AUDIO_STICKER_IMAGE`, else the menu image).
- Also: send an image/video with the caption `.saudio` while replying to an audio; `.saudio <audio url>`; `.saudio 3-9` (seconds, max 30); `.saudio cancel`; `.saudio video` = normal looping video instead.
- Encoded by hand (Message field 134 -> sticker with audio), appended by a permanent idempotent patch of `proto.Message.encode` (safe with many bots sending at once). ffmpeg jobs go through the shared limiter. Needs ffmpeg (`FFMPEG_PATH`, the host's ffmpeg, or the new `@ffmpeg-installer/ffmpeg` dependency).
- `.selfdestruct [seconds] <text>` (aliases .burn .vanish): text that vanishes N seconds after it is read.

### Chat themes (owner only) - `lib/chattheme.js`
- `.theme <colour>|off|list`, `.bubblecolor <name>`, `.wallpaper` (reply an image or give a URL), `.themecheck`.
- Patches Baileys' `messages-send.js` on disk at load, BEFORE Baileys is required (top of pair.js), so no restart is normally needed (one restart only if Baileys was already loaded). In groups the bot must be admin (or "Edit group info" = all participants) - WhatsApp's own rule.

### Tests
- New `test/sa.js` (12) with real ffmpeg conversions; run.js 119, anti 28, chan 6, perf 5.
- Honest note: audio stickers and chat themes use undocumented WhatsApp message formats taken from the reference code you supplied; they were NOT tested on a real phone here, and WhatsApp can change them.

### Round 12 fix (.saudio / .vanish)
- .saudio: audio length is passed up front (Baileys no longer needs the optional music-metadata package); every failure now names its stage ([sticker upload] / [audio upload] / [send]).
- .vanish: a failed send now shows the real error instead of a generic one.
