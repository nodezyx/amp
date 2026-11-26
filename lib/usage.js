'use strict';
// Per paired number usage counters for the super-owner .mrfrank command.
// Kept in data/usage.json (small, saved at most every 30 s). Nothing about message CONTENT is stored, and
// other people's numbers are only kept as a short one-way hash so "unique users" can be counted.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = path.join(__dirname, '..', 'data', 'usage.json');
const MAX_COMMAND_KINDS = 80;
const MAX_UNIQUE = 2000;

let db = {};
let loaded = false;
let timer = null;

function load() {
    if (loaded) return;
    loaded = true;
    try { db = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; } catch { db = {}; }
}

function save() {
    timer = null;
    // async write: JSON.stringify of the whole table is the only sync part; the disk work no longer blocks the loop
    const data = JSON.stringify(db);
    fs.promises.mkdir(path.dirname(FILE), { recursive: true })
        .then(() => fs.promises.writeFile(FILE + '.tmp', data))
        .then(() => fs.promises.rename(FILE + '.tmp', FILE))
        .catch((err) => console.warn('[usage] could not save:', err.message));
}
function dirty() { if (!timer) { timer = setTimeout(save, 30 * 1000); timer.unref(); } }

const dayKey = (d = new Date()) => d.toISOString().slice(0, 10);

function entry(number) {
    load();
    const n = String(number || '').replace(/\D/g, '');
    if (!n) return null;
    if (!db[n]) db[n] = { first: Date.now(), messages: 0, commands: 0, byCommand: {}, byDay: {}, users: [], lastCommandAt: 0, lastMessageAt: 0, connects: 0 };
    return db[n];
}

const hashId = (id) => crypto.createHash('sha1').update(String(id)).digest('hex').slice(0, 8);

function message(number, senderId) {
    const e = entry(number); if (!e) return;
    e.messages++; e.lastMessageAt = Date.now();
    if (senderId) {
        const h = hashId(senderId);
        if (!e.users.includes(h) && e.users.length < MAX_UNIQUE) e.users.push(h);
    }
    dirty();
}

function command(number, name, senderId) {
    const e = entry(number); if (!e || !name) return;
    e.commands++; e.lastCommandAt = Date.now();
    if (e.byCommand[name] !== undefined || Object.keys(e.byCommand).length < MAX_COMMAND_KINDS) e.byCommand[name] = (e.byCommand[name] || 0) + 1;
    const k = dayKey();
    e.byDay[k] = (e.byDay[k] || 0) + 1;
    const days = Object.keys(e.byDay).sort();
    while (days.length > 14) delete e.byDay[days.shift()]; // keep two weeks
    if (senderId) {
        const h = hashId(senderId);
        if (!e.users.includes(h) && e.users.length < MAX_UNIQUE) e.users.push(h);
    }
    dirty();
}

function connected(number) { const e = entry(number); if (e) { e.connects++; e.lastConnect = Date.now(); dirty(); } }

// -> plain summary used by the command
function summary(number) {
    load();
    const n = String(number || '').replace(/\D/g, '');
    const e = db[n];
    if (!e) return { tracked: false, messages: 0, commands: 0, today: 0, week: 0, unique: 0, top: [], first: null, lastCommandAt: 0, lastMessageAt: 0, connects: 0 };
    const today = dayKey();
    const week = Object.entries(e.byDay).filter(([d]) => Date.now() - Date.parse(d) < 7 * 86400000).reduce((a, [, v]) => a + v, 0);
    const top = Object.entries(e.byCommand).sort((a, b) => b[1] - a[1]).slice(0, 5);
    return { tracked: true, messages: e.messages, commands: e.commands, today: e.byDay[today] || 0, week, unique: e.users.length, top, first: e.first, lastCommandAt: e.lastCommandAt, lastMessageAt: e.lastMessageAt, connects: e.connects || 0 };
}

function totals() {
    load();
    return Object.values(db).reduce((t, e) => ({ messages: t.messages + (e.messages || 0), commands: t.commands + (e.commands || 0) }), { messages: 0, commands: 0 });
}

function flush() { if (timer) clearTimeout(timer); save(); }
process.once('beforeExit', flush);

module.exports = { message, command, connected, summary, totals, flush, _reset: () => { db = {}; loaded = true; } };
