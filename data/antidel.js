// Persistent anti-delete switches (gc = groups, dm = direct messages, status = status updates).
// Stored in data/antidel.json so the choice survives restarts. Defaults come from config.ANTIDELETE.
const fs = require('fs');
const path = require('path');
const config = require('../config');

const FILE = path.join(__dirname, 'antidel.json');
const KEYS = ['gc', 'dm', 'status'];

const defaults = () => {
    const on = String(config.ANTIDELETE).toLowerCase() === 'true';
    return { gc: on, dm: on, status: on };
};

let state = null;

const load = () => {
    if (state) return state;
    try {
        state = { ...defaults(), ...JSON.parse(fs.readFileSync(FILE, 'utf-8')) };
    } catch {
        state = defaults();
    }
    return state;
};

const save = () => {
    try {
        fs.writeFileSync(FILE, JSON.stringify(state, null, 2));
    } catch (err) {
        console.error('antidel: could not persist state:', err.message);
    }
};

const getAnti = async (key) => !!load()[key];

const setAnti = async (key, value) => {
    if (!KEYS.includes(key)) return;
    load()[key] = !!value;
    save();
};

const getAllAnti = async () => ({ ...load() });

const setAllAnti = async (value) => {
    const s = load();
    KEYS.forEach((k) => { s[k] = !!value; });
    save();
};

module.exports = { getAnti, setAnti, getAllAnti, setAllAnti };
