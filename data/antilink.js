// Per-group antilink switch, persisted in data/antilink.json.
// Groups without an explicit choice fall back to config.ANTI_LINK.
const fs = require('fs');
const path = require('path');
const config = require('../config');

const FILE = path.join(__dirname, 'antilink.json');
let state = null;

const load = () => {
    if (state) return state;
    try {
        state = JSON.parse(fs.readFileSync(FILE, 'utf-8')) || {};
    } catch {
        state = {};
    }
    return state;
};

const getAntiLink = async (groupJid) => {
    const s = load();
    if (Object.prototype.hasOwnProperty.call(s, groupJid)) return !!s[groupJid];
    return String(config.ANTI_LINK).toLowerCase() === 'true';
};

const setAntiLink = async (groupJid, enabled) => {
    load()[groupJid] = !!enabled;
    try {
        fs.writeFileSync(FILE, JSON.stringify(state, null, 2));
    } catch (err) {
        console.error('antilink: could not persist state:', err.message);
    }
};

module.exports = { getAntiLink, setAntiLink };
