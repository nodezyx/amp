const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const mongoose = require('mongoose');
const config = require('./config');

const bot = new TelegramBot(config.TELEGRAM_BOT_TOKEN, { polling: true });
const pairingProcesses = new Map();
const botStartTime = Date.now();

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const userSchema = new mongoose.Schema({
    userId: { type: String, required: true, unique: true },
    username: String,
    firstName: String,
    lastName: String,
    firstSeen: { type: Date, default: Date.now },
    lastSeen: { type: Date, default: Date.now },
    commandCount: { type: Number, default: 0 }
});

const User = mongoose.models.User || mongoose.model('User', userSchema);

async function trackUser(msg) {
    try {
        if (mongoose.connection.readyState !== 1) {
            await mongoose.connect(config.MONGODB_URI);
        }

        const userId = msg.from.id.toString();
        const userData = {
            userId,
            username: msg.from.username || 'N/A',
            firstName: msg.from.first_name || 'Unknown',
            lastName: msg.from.last_name || '',
            lastSeen: new Date()
        };

        await User.findOneAndUpdate(
            { userId },
            { 
                ...userData,
                $inc: { commandCount: 1 }
            },
            { upsert: true, new: true }
        );
    } catch (error) {
        console.error('Error tracking user:', error.message);
    }
}

bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const userName = msg.from.first_name || 'there';
    
    await trackUser(msg);

    const welcomeMessage = `🎀 *SUBZERO MD MINI*
━━━━━━━━━━━━━━━━━

Hey *${userName}!* 👋
Welcome to Subzero Bot Mini

┏━━ ≪ °❈° ≫ ━━┓
   *QUICK COMMANDS*
┗━━ ≪ °❈° ≫ ━━┛

⚡ Command : /pair
⚡ Use : Get pairing code

⚡ Command : /cancel
⚡ Use : Cancel request

⚡ Command : /uptime
⚡ Use : Bot status

⚡ Command : /help
⚡ Use : Get support

⚡ Command : /developer
⚡ Use : Developer info

${chatId.toString() === config.TELEGRAM_OWNER_ID ? '┏━━ ≪ °❈° ≫ ━━┓\n   *OWNER COMMANDS*\n┗━━ ≪ °❈° ≫ ━━┛\n\n⚡ Command : /listsessions\n⚡ Command : /deletesessions\n⚡ Command : /users\n⚡ Command : /post <message>\n\n' : ''}┏━━ ≪ °❈° ≫ ━━┓
   *GETTING STARTED*
┗━━ ≪ °❈° ≫ ━━┛

📱 Send: \`/pair +your_number\`
💡 Example: \`/pair +263719647303\`

© 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ`;

    const keyboard = {
        inline_keyboard: [
            [{ text: '📱 Get Pairing Code', callback_data: 'get_code' }],
            [{ text: '❓ Help', callback_data: 'help' }],
            [{ text: '📢 Channel', url: 'https://whatsapp.com/' }]
        ]
    };

    await bot.sendPhoto(chatId, 'https://mrfrankk-cdn.hf.space/media/minixx.jpg', {
        caption: welcomeMessage,
        parse_mode: 'Markdown',
        reply_markup: keyboard
    });
});

bot.onText(/\/help/, async (msg) => {
    const chatId = msg.chat.id;
    
    await trackUser(msg);
    
    const helpMessage = `📚 *HELP & GUIDE*
━━━━━━━━━━━━━━━━━

┏━━ ≪ °❈° ≫ ━━┓
   *USER COMMANDS* 👤
┗━━ ≪ °❈° ≫ ━━┛

⚡ Command : /start
⚡ Command : /pair <number>
⚡ Command : /cancel
⚡ Command : /uptime
⚡ Command : /help
⚡ Command : /developer

${chatId.toString() === config.TELEGRAM_OWNER_ID ? '┏━━ ≪ °❈° ≫ ━━┓\n   *OWNER COMMANDS* 👑\n┗━━ ≪ °❈° ≫ ━━┛\n\n⚡ Command : /listsessions\n⚡ Command : /deletesessions\n⚡ Command : /users\n⚡ Command : /post <message>\n\n' : ''}┏━━ ≪ °❈° ≫ ━━┓
   *CONNECTION GUIDE* 🔗
┗━━ ≪ °❈° ≫ ━━┛

✦ Step 1 → Send /pair <number>
✦ Step 2 → Copy pairing code
✦ Step 3 → WhatsApp Settings
✦ Step 4 → Linked Devices
✦ Step 5 → Link a Device
✦ Step 6 → Link with phone number
✦ Step 7 → Enter code ✅

┏━━ ≪ °❈° ≫ ━━┓
   *EXAMPLE USAGE* 💡
┗━━ ≪ °❈° ≫ ━━┛

\`/pair +263719647303\`

© 𝙈𝙞𝙣𝙞 𝘽𝙤𝙩 𝘽𝙮 𝙈𝙧 𝙁𝙧𝙖𝙣𝙠 𝙊𝙁𝘾 ッ`;

    const keyboard = {
        inline_keyboard: [
            [{ text: '🔙 Back to Menu', callback_data: 'back_to_menu' }],
            [{ text: '📱 Get Code Now', callback_data: 'get_code' }]
        ]
    };

    await bot.sendPhoto(chatId, 'https://mrfrankk-cdn.hf.space/media/minixx.jpg', {
        caption: helpMessage,
        parse_mode: 'Markdown',
        reply_markup: keyboard
    });
});

bot.onText(/\/uptime/, async (msg) => {
    const chatId = msg.chat.id;
    
    await trackUser(msg);

    const uptime = Date.now() - botStartTime;
    const seconds = Math.floor(uptime / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    const uptimeStr = days > 0 
        ? `${days}d ${hours % 24}h ${minutes % 60}m`
        : hours > 0
        ? `${hours}h ${minutes % 60}m ${seconds % 60}s`
        : `${minutes}m ${seconds % 60}s`;

    const uptimeMsg = `⏱️ *Bot Uptime*

🕐 Running for: *${uptimeStr}*
📅 Started: ${new Date(botStartTime).toLocaleString()}

✅ Status: Online and running smoothly!`;

    await bot.sendMessage(chatId, uptimeMsg, { parse_mode: 'Markdown' });
});

bot.onText(/\/cancel/, async (msg) => {
    const chatId = msg.chat.id;
    
    await trackUser(msg);

    if (pairingProcesses.has(chatId)) {
        pairingProcesses.delete(chatId);
        const cancelMsg = await bot.sendMessage(chatId, '✅ Request cancelled successfully!');
        
        setTimeout(async () => {
            try {
                await bot.deleteMessage(chatId, cancelMsg.message_id);
            } catch (e) {}
        }, 3000);
    } else {
        const noProcessMsg = await bot.sendMessage(chatId, '❌ No active request to cancel.');
        
        setTimeout(async () => {
            try {
                await bot.deleteMessage(chatId, noProcessMsg.message_id);
            } catch (e) {}
        }, 3000);
    }
});

bot.onText(/\/pair(?:\s+(\d+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const number = match[1];
    
    await trackUser(msg);

    if (!number) {
        const errorMsg = await bot.sendMessage(chatId, '❌ *Please provide your number*\n\nUsage: `/pair <number>`\nExample: `/pair 263719647303`', { parse_mode: 'Markdown' });
        
        setTimeout(async () => {
            try {
                await bot.deleteMessage(chatId, errorMsg.message_id);
            } catch (e) {}
        }, 5000);
        return;
    }

    if (pairingProcesses.has(chatId)) {
        const busyMsg = await bot.sendMessage(chatId, '⏳ *Processing previous request...*\n\nUse /cancel to start over.', { parse_mode: 'Markdown' });
        
        setTimeout(async () => {
            try {
                await bot.deleteMessage(chatId, busyMsg.message_id);
            } catch (e) {}
        }, 4000);
        return;
    }

    const sanitizedNumber = number.replace(/[^0-9]/g, '');

    if (sanitizedNumber.length < 10) {
        const invalidMsg = await bot.sendMessage(chatId, '❌ *Invalid phone number*\n\nProvide a valid number with country code.\n\nExample: `/pair 263719647303`', { parse_mode: 'Markdown' });
        
        setTimeout(async () => {
            try {
                await bot.deleteMessage(chatId, invalidMsg.message_id);
            } catch (e) {}
        }, 5000);
        return;
    }

    pairingProcesses.set(chatId, true);

    // Enhanced animated loading with multiple frames
    const loadingFrames = [
        { emoji: '🕐', dots: '.' },
        { emoji: '🕑', dots: '..' },
        { emoji: '🕒', dots: '...' },
        { emoji: '🕓', dots: '....' },
        { emoji: '🕔', dots: '.....' },
        { emoji: '🕕', dots: '......' },
        { emoji: '🕖', dots: '.....' },
        { emoji: '🕗', dots: '....' },
        { emoji: '🕘', dots: '...' },
        { emoji: '🕙', dots: '..' },
        { emoji: '🕚', dots: '.' },
        { emoji: '🕛', dots: '' }
    ];
    
    let loadingIndex = 0;
    
    const loadingMsg = await bot.sendMessage(chatId, `${loadingFrames[0].emoji} *Connecting to WhatsApp*${loadingFrames[0].dots}\n\n📱 Number: +${sanitizedNumber}\n⚙️ Initializing session...`, { parse_mode: 'Markdown' });

    const loadingInterval = setInterval(async () => {
        loadingIndex = (loadingIndex + 1) % loadingFrames.length;
        const frame = loadingFrames[loadingIndex];
        
        const messages = [
            `${frame.emoji} *Connecting to WhatsApp*${frame.dots}\n\n📱 Number: +${sanitizedNumber}\n⚙️ Initializing session...`,
            `${frame.emoji} *Establishing secure connection*${frame.dots}\n\n📱 Number: +${sanitizedNumber}\n🔐 Securing channel...`,
            `${frame.emoji} *Generating pairing code*${frame.dots}\n\n📱 Number: +${sanitizedNumber}\n⏱️ This may take 30-60 seconds...`,
            `${frame.emoji} *Processing request*${frame.dots}\n\n📱 Number: +${sanitizedNumber}\n🔄 Please wait...`
        ];
        
        const messageIndex = Math.floor(loadingIndex / 3) % messages.length;
        
        try {
            await bot.editMessageText(
                messages[messageIndex],
                {
                    chat_id: chatId,
                    message_id: loadingMsg.message_id,
                    parse_mode: 'Markdown'
                }
            );
        } catch (e) {}
    }, 800);

    try {
        const response = await axios.get(`http://localhost:5000/code?number=${sanitizedNumber}`, {
            timeout: 90000
        });

        clearInterval(loadingInterval);

        if (response.data && response.data.code) {
            const code = response.data.code;
            const formattedCode = code.match(/.{1,4}/g).join('-');
            
            try {
                await bot.deleteMessage(chatId, loadingMsg.message_id);
            } catch (e) {}

            await sleep(300);

            const successMessage = `✅ *Pairing Code Generated!*

🔢 *Your Code:* \`${formattedCode}\`

📋 *Steps to Connect:*
1️⃣ Open WhatsApp
2️⃣ Settings → Linked Devices
3️⃣ Link a Device
4️⃣ "Link with phone number"
5️⃣ Enter code: \`${formattedCode}\`

⏰ Expires in few minutes
🤖 Mini bot activates automatically!`;

            const keyboard = {
                inline_keyboard: [
                    [{ text: '📋 Copy Code', callback_data: `copy_${code}` }],
                    [{ text: '✅ Done', callback_data: 'done' }, { text: '🔄 New Code', callback_data: 'new_code' }]
                ]
            };

            await bot.sendMessage(chatId, successMessage, { 
                parse_mode: 'Markdown',
                reply_markup: keyboard
            });

        } else {
            clearInterval(loadingInterval);
            try {
                await bot.deleteMessage(chatId, loadingMsg.message_id);
            } catch (e) {}
            
            const failMsg = await bot.sendMessage(chatId, '❌ *Failed to generate code*\n\nPlease try again in a moment.', { parse_mode: 'Markdown' });
            
            setTimeout(async () => {
                try {
                    await bot.deleteMessage(chatId, failMsg.message_id);
                } catch (e) {}
            }, 5000);
        }
    } catch (error) {
        clearInterval(loadingInterval);
        console.error('Pairing error:', error.message);
        
        try {
            await bot.deleteMessage(chatId, loadingMsg.message_id);
        } catch (e) {}

        let errorMsg = '❌ *Error Generating Code*\n\n';
        if (error.code === 'ECONNREFUSED') {
            errorMsg += '🔴 Service unavailable\nContact bot owner.';
        } else if (error.code === 'ETIMEDOUT') {
            errorMsg += '⏱️ Request timed out\nTry again.';
        } else {
            errorMsg += `⚠️ ${error.message}`;
        }
        
        const errMsg = await bot.sendMessage(chatId, errorMsg, { parse_mode: 'Markdown' });
        
        setTimeout(async () => {
            try {
                await bot.deleteMessage(chatId, errMsg.message_id);
            } catch (e) {}
        }, 7000);
    } finally {
        pairingProcesses.delete(chatId);
    }
});

bot.onText(/\/listsessions/, async (msg) => {
    const chatId = msg.chat.id;
    
    await trackUser(msg);

    if (chatId.toString() !== config.TELEGRAM_OWNER_ID) {
        const denyMsg = await bot.sendMessage(chatId, '❌ *Owner Only Command*', { parse_mode: 'Markdown' });
        
        setTimeout(async () => {
            try {
                await bot.deleteMessage(chatId, denyMsg.message_id);
            } catch (e) {}
        }, 3000);
        return;
    }

    const loadingMsg = await bot.sendMessage(chatId, '📊 *Loading sessions...*', { parse_mode: 'Markdown' });

    try {
        if (mongoose.connection.readyState !== 1) {
            await mongoose.connect(config.MONGODB_URI);
        }

        const sessionSchema = new mongoose.Schema({
            number: String,
            creds: mongoose.Schema.Types.Mixed,
            lastActive: Date,
            createdAt: Date
        });

        const Session = mongoose.models.Session || mongoose.model('Session', sessionSchema);
        const sessions = await Session.find({});

        try {
            await bot.deleteMessage(chatId, loadingMsg.message_id);
        } catch (e) {}

        if (sessions.length === 0) {
            await bot.sendMessage(chatId, '📊 *No Active Sessions*\n\nNo users connected yet.', { parse_mode: 'Markdown' });
            return;
        }

        let message = `📊 *Active Sessions* (${sessions.length})\n\n`;

        for (let i = 0; i < sessions.length; i++) {
            const session = sessions[i];
            message += `${i + 1}. 📱 \`+${session.number}\`\n`;
            message += `   📅 ${new Date(session.createdAt).toLocaleDateString()}\n`;
            message += `   🕐 ${new Date(session.lastActive).toLocaleDateString()}\n\n`;
        }

        const keyboard = {
            inline_keyboard: [
                [{ text: '🗑️ Delete Sessions', callback_data: 'delete_sessions_menu' }]
            ]
        };

        await bot.sendMessage(chatId, message, { 
            parse_mode: 'Markdown',
            reply_markup: keyboard
        });
    } catch (error) {
        console.error('List sessions error:', error);
        
        try {
            await bot.deleteMessage(chatId, loadingMsg.message_id);
        } catch (e) {}
        
        await bot.sendMessage(chatId, '❌ *Error Loading Sessions*', { parse_mode: 'Markdown' });
    }
});

bot.onText(/\/deletesessions/, async (msg) => {
    const chatId = msg.chat.id;
    
    await trackUser(msg);

    if (chatId.toString() !== config.TELEGRAM_OWNER_ID) {
        const denyMsg = await bot.sendMessage(chatId, '❌ *Owner Only Command*', { parse_mode: 'Markdown' });
        
        setTimeout(async () => {
            try {
                await bot.deleteMessage(chatId, denyMsg.message_id);
            } catch (e) {}
        }, 3000);
        return;
    }

    const keyboard = {
        inline_keyboard: [
            [{ text: '🗑️ Delete All Sessions', callback_data: 'delete_all_confirm' }],
            [{ text: '🔢 Delete by Index', callback_data: 'delete_by_index' }],
            [{ text: '❌ Cancel', callback_data: 'cancel_delete' }]
        ]
    };

    await bot.sendMessage(chatId, '🗑️ *Delete Sessions*\n\nChoose an option:', { 
        parse_mode: 'Markdown',
        reply_markup: keyboard
    });
});

bot.onText(/\/users/, async (msg) => {
    const chatId = msg.chat.id;
    
    await trackUser(msg);

    if (chatId.toString() !== config.TELEGRAM_OWNER_ID) {
        const denyMsg = await bot.sendMessage(chatId, '❌ *Owner Only Command*', { parse_mode: 'Markdown' });
        
        setTimeout(async () => {
            try {
                await bot.deleteMessage(chatId, denyMsg.message_id);
            } catch (e) {}
        }, 3000);
        return;
    }

    const loadingMsg = await bot.sendMessage(chatId, '👥 *Loading users...*', { parse_mode: 'Markdown' });

    try {
        if (mongoose.connection.readyState !== 1) {
            await mongoose.connect(config.MONGODB_URI);
        }

        const users = await User.find({}).sort({ lastSeen: -1 });

        try {
            await bot.deleteMessage(chatId, loadingMsg.message_id);
        } catch (e) {}

        if (users.length === 0) {
            await bot.sendMessage(chatId, '👥 *No Users Found*\n\nNo one has used the bot yet.', { parse_mode: 'Markdown' });
            return;
        }

        let message = `👥 *Bot Users* (${users.length} total)\n\n`;

        for (let i = 0; i < users.length; i++) {
            const user = users[i];
            const name = user.firstName + (user.lastName ? ' ' + user.lastName : '');
            message += `${i + 1}. 👤 *${name}*\n`;
            message += `   🆔 @${user.username}\n`;
            message += `   📅 First: ${new Date(user.firstSeen).toLocaleDateString()}\n`;
            message += `   🕐 Last: ${new Date(user.lastSeen).toLocaleDateString()}\n`;
            message += `   📊 Commands: ${user.commandCount}\n\n`;
        }

        await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } catch (error) {
        console.error('List users error:', error);
        
        try {
            await bot.deleteMessage(chatId, loadingMsg.message_id);
        } catch (e) {}
        
        await bot.sendMessage(chatId, '❌ *Error Loading Users*', { parse_mode: 'Markdown' });
    }
});

bot.onText(/\/post(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const message = match[1];
    
    await trackUser(msg);

    if (chatId.toString() !== config.TELEGRAM_OWNER_ID) {
        const denyMsg = await bot.sendMessage(chatId, '❌ *Owner Only Command*', { parse_mode: 'Markdown' });
        
        setTimeout(async () => {
            try {
                await bot.deleteMessage(chatId, denyMsg.message_id);
            } catch (e) {}
        }, 3000);
        return;
    }

    if (!message) {
        const helpMsg = await bot.sendMessage(chatId, '📢 *Broadcast Message to All Users*\n\nUsage: `/post <your message>`\n\nExample:\n`/post Thank you for using Subzero MD!`', { parse_mode: 'Markdown' });
        
        setTimeout(async () => {
            try {
                await bot.deleteMessage(chatId, helpMsg.message_id);
            } catch (e) {}
        }, 10000);
        return;
    }

    const confirmMsg = await bot.sendMessage(chatId, `📢 *Confirm Broadcast*\n\nMessage:\n${message}\n\n⚠️ This will be sent to all bot users. Continue?`, { 
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '✅ Send Broadcast', callback_data: `broadcast_confirm_${Date.now()}` },
                    { text: '❌ Cancel', callback_data: 'broadcast_cancel' }
                ]
            ]
        }
    });

    // Store the broadcast message temporarily
    if (!global.pendingBroadcasts) global.pendingBroadcasts = new Map();
    global.pendingBroadcasts.set(chatId, message);
});

bot.onText(/\/developer/, async (msg) => {
    const chatId = msg.chat.id;
    
    await trackUser(msg);

    const developerInfo = `👨‍💻 *DEVELOPER INFORMATION*
━━━━━━━━━━━━━━━━━

┏━━ ≪ °❈° ≫ ━━┓
   *DEVELOPER DETAILS*
┗━━ ≪ °❈° ≫ ━━┛

👤 *Name:* Darrell Mucheri
🏷️ *Alias:* Mr Frank OFC

┏━━ ≪ °❈° ≫ ━━┓
   *CONTACT INFO*
┗━━ ≪ °❈° ≫ ━━┛

📱 *WhatsApp:* +263 719 647 303
✈️ *Telegram:* @mrfrankofc
📧 *Email:* mrfrankofc@gmail.com
💻 *GitHub:* github.com/mrfr8nk

┏━━ ≪ °❈° ≫ ━━┓
   *ABOUT THE BOT*
┗━━ ≪ °❈° ≫ ━━┛

🤖 *Bot:* Subzero MD Mini
🎯 *Purpose:* WhatsApp Multi-Device Bot
⚡ *Features:* Pairing, Sessions, AI
🌍 *Status:* Active & Maintained

┏━━ ≪ °❈° ≫ ━━┓
   *SUPPORT*
┗━━ ≪ °❈° ≫ ━━┛

💡 For support, bug reports, or feature requests:
• Contact via WhatsApp or Telegram
• Open an issue on GitHub
• Send an email for business inquiries

© 𝙈𝙖𝙙𝙚 𝙗𝙮 𝘿𝙖𝙧𝙧𝙚𝙡𝙡 𝙈𝙪𝙘𝙝𝙚𝙧𝙞`;

    const keyboard = {
        inline_keyboard: [
            [{ text: '📱 WhatsApp', url: 'https://wa.me/263719647303' }],
            [{ text: '✈️ Telegram', url: 'https://t.me/mrfrankofc' }],
            [{ text: '💻 GitHub', url: 'https://github.com/mrfr8nk' }],
            [{ text: '📢 Channel', url: 'https://whatsapp.com/channel/0029VagQEmB002T7MWo3Sj1D' }]
        ]
    };

    await bot.sendPhoto(chatId, 'https://mrfrankk-cdn.hf.space/media/minixx.jpg', {
        caption: developerInfo,
        parse_mode: 'Markdown',
        reply_markup: keyboard
    });
});

bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;
    const data = query.data;

    try {
        if (data === 'get_code') {
            await bot.answerCallbackQuery(query.id, { text: 'Use /pair <number> to get code' });
            
            const msg = await bot.sendMessage(chatId, '📱 *Send your number:*\n\nFormat: `/pair 263719647303`', { parse_mode: 'Markdown' });
            
            setTimeout(async () => {
                try {
                    await bot.deleteMessage(chatId, msg.message_id);
                } catch (e) {}
            }, 10000);

        } else if (data === 'help') {
            await bot.answerCallbackQuery(query.id);
            
            const helpMsg = `📚 *Quick Help*

Send: \`/pair <number>\`
Example: \`/pair 263719647303\`

Copy the code and enter it in WhatsApp!`;

            await bot.editMessageText(helpMsg, {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[{ text: '🔙 Back', callback_data: 'back_to_menu' }]]
                }
            });

        } else if (data === 'back_to_menu') {
            await bot.answerCallbackQuery(query.id);
            
            const userName = query.from.first_name || 'there';
            const welcomeMsg = `┏━━━━━━━━━━━━━━━━━━━┓
┃  *Welcome ${userName}!* 👋
┗━━━━━━━━━━━━━━━━━━━┛

╭─────────────────────╮
│ *🤖 SUBZERO MD MINI* │
│ WhatsApp Bot Service │
╰─────────────────────╯

_Get your pairing code instantly!_

📱 Send: \`/pair <number>\``;

            try {
                await bot.deleteMessage(chatId, messageId);
            } catch (e) {}

            await bot.sendPhoto(chatId, 'https://dabby.vercel.app/tg.png', {
                caption: welcomeMsg,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '📱 Get Code', callback_data: 'get_code' }],
                        [{ text: '❓ Help', callback_data: 'help' }],
                        [{ text: '📢 Channel', url: 'https://whatsapp.com/channel/0029VagQEmB002T7MWo3Sj1D' }]
                    ]
                }
            });

        } else if (data.startsWith('copy_')) {
            const code = data.replace('copy_', '');
            const formattedCode = code.match(/.{1,4}/g).join('-');
            
            await bot.answerCallbackQuery(query.id, { 
                text: `✅ Code: ${formattedCode}`,
                show_alert: true
            });

        } else if (data === 'done') {
            await bot.answerCallbackQuery(query.id, { text: '✅ Great! Your mini bot should be active now!' });
            
            await bot.sendMessage(chatId, '✅ *Connection Complete!*\n\n🤖 Your mini bot is now active!\n\nEnjoy all the features! 🎉', { parse_mode: 'Markdown' });

        } else if (data === 'new_code') {
            await bot.answerCallbackQuery(query.id, { text: 'Use /pair <number> again' });
            
            const newMsg = await bot.sendMessage(chatId, '🔄 *Generate New Code*\n\nSend: `/pair <your_number>`', { parse_mode: 'Markdown' });
            
            setTimeout(async () => {
                try {
                    await bot.deleteMessage(chatId, newMsg.message_id);
                } catch (e) {}
            }, 8000);

        } else if (data === 'delete_sessions_menu') {
            await bot.answerCallbackQuery(query.id);
            
            const keyboard = {
                inline_keyboard: [
                    [{ text: '🗑️ Delete All', callback_data: 'delete_all_confirm' }],
                    [{ text: '🔢 Delete by Index', callback_data: 'delete_by_index' }],
                    [{ text: '❌ Cancel', callback_data: 'cancel_delete' }]
                ]
            };

            await bot.editMessageText('🗑️ *Delete Sessions*\n\nChoose an option:', {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown',
                reply_markup: keyboard
            });

        } else if (data === 'delete_all_confirm') {
            await bot.answerCallbackQuery(query.id);
            
            const keyboard = {
                inline_keyboard: [
                    [{ text: '⚠️ YES, DELETE ALL', callback_data: 'delete_all_confirmed' }],
                    [{ text: '❌ Cancel', callback_data: 'cancel_delete' }]
                ]
            };

            await bot.editMessageText('⚠️ *Confirm Delete All*\n\nThis will delete ALL WhatsApp sessions!\n\nAre you sure?', {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown',
                reply_markup: keyboard
            });

        } else if (data === 'delete_all_confirmed') {
            await bot.answerCallbackQuery(query.id, { text: 'Deleting all sessions...' });
            
            try {
                if (mongoose.connection.readyState !== 1) {
                    await mongoose.connect(config.MONGODB_URI);
                }

                const sessionSchema = new mongoose.Schema({
                    number: String,
                    creds: mongoose.Schema.Types.Mixed,
                    lastActive: Date,
                    createdAt: Date
                });

                const Session = mongoose.models.Session || mongoose.model('Session', sessionSchema);
                const result = await Session.deleteMany({});

                await bot.editMessageText(`✅ *Deleted Successfully*\n\n🗑️ Removed ${result.deletedCount} session(s)`, {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: 'Markdown'
                });
            } catch (error) {
                console.error('Delete all error:', error);
                await bot.editMessageText('❌ *Error Deleting Sessions*', {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: 'Markdown'
                });
            }

        } else if (data === 'delete_by_index') {
            await bot.answerCallbackQuery(query.id);
            
            await bot.editMessageText('🔢 *Delete by Index*\n\nReply with the session index number (e.g., 1, 2, 3)\n\nUse /listsessions to see indices.', {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown'
            });

            bot.once('message', async (msg) => {
                if (msg.chat.id !== chatId) return;
                
                const index = parseInt(msg.text);
                
                if (isNaN(index) || index < 1) {
                    await bot.sendMessage(chatId, '❌ Invalid index. Please provide a number (e.g., 1, 2, 3)');
                    return;
                }

                try {
                    if (mongoose.connection.readyState !== 1) {
                        await mongoose.connect(config.MONGODB_URI);
                    }

                    const sessionSchema = new mongoose.Schema({
                        number: String,
                        creds: mongoose.Schema.Types.Mixed,
                        lastActive: Date,
                        createdAt: Date
                    });

                    const Session = mongoose.models.Session || mongoose.model('Session', sessionSchema);
                    const sessions = await Session.find({});

                    if (index > sessions.length) {
                        await bot.sendMessage(chatId, `❌ Index ${index} not found. Only ${sessions.length} session(s) exist.`);
                        return;
                    }

                    const sessionToDelete = sessions[index - 1];
                    await Session.deleteOne({ _id: sessionToDelete._id });

                    await bot.sendMessage(chatId, `✅ *Deleted Session*\n\n📱 +${sessionToDelete.number}`, { parse_mode: 'Markdown' });
                } catch (error) {
                    console.error('Delete by index error:', error);
                    await bot.sendMessage(chatId, '❌ *Error Deleting Session*', { parse_mode: 'Markdown' });
                }
            });

        } else if (data === 'cancel_delete') {
            await bot.answerCallbackQuery(query.id, { text: 'Cancelled' });
            
            try {
                await bot.deleteMessage(chatId, messageId);
            } catch (e) {}
        } else if (data.startsWith('broadcast_confirm_')) {
            await bot.answerCallbackQuery(query.id, { text: 'Sending broadcast...' });

            if (!global.pendingBroadcasts || !global.pendingBroadcasts.has(chatId)) {
                await bot.editMessageText('❌ Broadcast message expired. Please try again.', {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: 'Markdown'
                });
                return;
            }

            const broadcastMessage = global.pendingBroadcasts.get(chatId);
            global.pendingBroadcasts.delete(chatId);

            try {
                if (mongoose.connection.readyState !== 1) {
                    await mongoose.connect(config.MONGODB_URI);
                }

                const users = await User.find({});

                if (users.length === 0) {
                    await bot.editMessageText('❌ No users to broadcast to.', {
                        chat_id: chatId,
                        message_id: messageId,
                        parse_mode: 'Markdown'
                    });
                    return;
                }

                await bot.editMessageText(`📢 *Broadcasting...*\n\n👥 Sending to ${users.length} users...`, {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: 'Markdown'
                });

                let successCount = 0;
                let failCount = 0;

                const broadcastText = `📢 *MESSAGE FROM ADMIN*\n━━━━━━━━━━━━━━━━━\n\n${broadcastMessage}\n\n━━━━━━━━━━━━━━━━━\n> © 𝙎𝙪𝙗𝙯𝙚𝙧𝙤 𝙈𝘿 𝙈𝙞𝙣𝙞`;

                for (const user of users) {
                    try {
                        await bot.sendMessage(user.userId, broadcastText, { parse_mode: 'Markdown' });
                        successCount++;
                        await sleep(100); // Small delay to avoid rate limiting
                    } catch (error) {
                        console.error(`Failed to send to ${user.userId}:`, error.message);
                        failCount++;
                    }
                }

                await bot.editMessageText(
                    `✅ *Broadcast Complete!*\n\n` +
                    `📊 *Results:*\n` +
                    `✅ Sent: ${successCount}\n` +
                    `❌ Failed: ${failCount}\n` +
                    `👥 Total: ${users.length}`,
                    {
                        chat_id: chatId,
                        message_id: messageId,
                        parse_mode: 'Markdown'
                    }
                );
            } catch (error) {
                console.error('Broadcast error:', error);
                await bot.editMessageText('❌ *Error During Broadcast*\n\nPlease try again.', {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: 'Markdown'
                });
            }

        } else if (data === 'broadcast_cancel') {
            await bot.answerCallbackQuery(query.id, { text: 'Broadcast cancelled' });
            
            if (global.pendingBroadcasts && global.pendingBroadcasts.has(chatId)) {
                global.pendingBroadcasts.delete(chatId);
            }
            
            try {
                await bot.deleteMessage(chatId, messageId);
            } catch (e) {}
        }
    } catch (error) {
        console.error('Callback error:', error);
        await bot.answerCallbackQuery(query.id, { text: '❌ Error occurred' });
    }
});

bot.on('polling_error', (error) => {
    console.error('Telegram polling error:', error.message);
});

// Send startup notification to owner
async function sendStartupNotification() {
    try {
        const os = require('os');
        const memUsage = process.memoryUsage();
        const totalMemMB = (memUsage.heapTotal / 1024 / 1024).toFixed(2);
        const usedMemMB = (memUsage.heapUsed / 1024 / 1024).toFixed(2);
        const rssMB = (memUsage.rss / 1024 / 1024).toFixed(2);
        
        // System RAM
        const totalSystemRAM = (os.totalmem() / 1024 / 1024).toFixed(2);
        const freeSystemRAM = (os.freemem() / 1024 / 1024).toFixed(2);
        const usedSystemRAM = (totalSystemRAM - freeSystemRAM).toFixed(2);
        const ramPercentage = ((usedSystemRAM / totalSystemRAM) * 100).toFixed(2);
        
        const startupMessage = `🚀 *BOT STARTED SUCCESSFULLY*
━━━━━━━━━━━━━━━━━

⏰ *Time:* ${new Date().toLocaleString()}
🖥️ *Platform:* ${process.platform}
📊 *Node Version:* ${process.version}

┏━━ ≪ °❈° ≫ ━━┓
   *SYSTEM RAM*
┗━━ ≪ °❈° ≫ ━━┛

💾 *Used:* ${usedSystemRAM} MB / ${totalSystemRAM} MB
📊 *Usage:* ${ramPercentage}%
🆓 *Free:* ${freeSystemRAM} MB

┏━━ ≪ °❈° ≫ ━━┓
   *PROCESS MEMORY*
┗━━ ≪ °❈° ≫ ━━┛

🔹 *Heap Used:* ${usedMemMB} MB
📦 *Heap Total:* ${totalMemMB} MB
🔢 *RSS:* ${rssMB} MB

┏━━ ≪ °❈° ≫ ━━┓
   *BOT STATUS*
┗━━ ≪ °❈° ≫ ━━┛

✅ Telegram Bot: Active
✅ MongoDB: Connected
✅ Express Server: Running
🌐 Port: 5000

🤖 Bot is ready to accept commands!
📱 Users can now send /pair requests`;

        await bot.sendMessage(config.TELEGRAM_OWNER_ID, startupMessage, { 
            parse_mode: 'Markdown' 
        });
        
        console.log('✅ Startup notification sent to owner');
    } catch (error) {
        console.error('❌ Failed to send startup notification:', error.message);
    }
}

// Send notification after bot is ready
setTimeout(sendStartupNotification, 2000);

console.log('🤖 Telegram bot started successfully!');
console.log('📱 Bot is ready to receive /pair commands');
console.log('✨ Enhanced with animations and auto-delete');

module.exports = bot;
