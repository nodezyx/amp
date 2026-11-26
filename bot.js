// keeps the process small: no core dumps, heap cap, auto restart, temp cleanup (lib/guard.js)
if (require('./lib/guard').relaunch()) return;
require('./lib/guard').startJanitor();

require('dotenv').config();
const config = require('./config');
const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 5000;

if (!config.TELEGRAM_BOT_TOKEN) {
    console.error('❌ TELEGRAM_BOT_TOKEN is not set in environment variables!');
    process.exit(1);
}

console.log('🚀 Starting SUBZERO MD MINI...');

let pairRouter = require('./pair');
app.use('/code', pairRouter);

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'main.html'));
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Mini bot server running on http://0.0.0.0:${PORT}`);
    console.log(`📱 Pairing endpoint: http://0.0.0.0:${PORT}/code?number=YOUR_NUMBER`);
});

require('./telegram-bot');

console.log('✅ Telegram bot is now running!');
console.log('💡 Users can send /pair to the bot to get pairing codes.');
