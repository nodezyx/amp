'use strict';
// Works out the public address of this bot's web page (the pairing site), whatever the host is:
// your own PAIR_WEB_URL, a hosting platform's domain variable, a panel's IP:port, or - last resort - the
// server's public IP plus the port the web server really bound to. No port is ever hard-coded.

const https = require('https');
const config = require('../config');

let boundPort = null;
let cache = null; // { url, source, at }
const TTL = 10 * 60 * 1000;

const clean = (u) => String(u || '').trim().replace(/\/+$/, '');
const withProto = (d) => (/^https?:\/\//i.test(d) ? clean(d) : `https://${clean(d)}`);
const isPrivateHost = (h) => !h || /^(0\.0\.0\.0|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|localhost|::1?$)/.test(h);

function setPort(p) { boundPort = Number(p) || null; cache = null; }

function port(env = process.env) { return Number(env.SERVER_PORT) || boundPort || Number(env.PORT) || null; }

// Address that can be worked out from environment variables alone (instant, no network).
function fromEnv(env = process.env) {
    const explicit = env.PAIR_WEB_URL || env.WEB_URL || env.APP_URL || env.PUBLIC_URL || env.SITE_URL || config.PAIR_WEB_URL;
    if (explicit) return { url: withProto(explicit), source: 'configured' };

    const platform = [
        ['RENDER_EXTERNAL_URL', (v) => clean(v), 'Render'],
        ['RAILWAY_PUBLIC_DOMAIN', withProto, 'Railway'],
        ['RAILWAY_STATIC_URL', withProto, 'Railway'],
        ['KOYEB_PUBLIC_DOMAIN', withProto, 'Koyeb'],
        ['HEROKU_APP_NAME', (v) => `https://${v}.herokuapp.com`, 'Heroku'],
        ['FLY_APP_NAME', (v) => `https://${v}.fly.dev`, 'Fly.io'],
        ['VERCEL_URL', withProto, 'Vercel'],
        ['REPLIT_DEV_DOMAIN', withProto, 'Replit'],
        ['REPLIT_DOMAINS', (v) => withProto(String(v).split(',')[0]), 'Replit'],
        ['GITPOD_WORKSPACE_URL', (v) => clean(v).replace('https://', `https://${port(env) || 5000}-`), 'Gitpod'],
    ];
    for (const [key, make, source] of platform) if (env[key]) return { url: make(env[key]), source };
    if (env.REPL_SLUG && env.REPL_OWNER) return { url: `https://${env.REPL_SLUG}.${env.REPL_OWNER}.repl.co`, source: 'Replit' };
    if (env.CODESPACE_NAME && env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN) return { url: `https://${env.CODESPACE_NAME}-${port(env) || 5000}.${env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}`, source: 'Codespaces' };

    // game / bot panels (Pterodactyl and friends) tell the server its own address and allocated port
    if (env.SERVER_IP && env.SERVER_PORT && !isPrivateHost(env.SERVER_IP)) return { url: `http://${env.SERVER_IP}:${env.SERVER_PORT}`, source: 'panel' };
    return null;
}

function publicIp(timeoutMs = 4000) {
    const hosts = ['api.ipify.org', 'ifconfig.me/ip', 'icanhazip.com'];
    const one = (h) => new Promise((resolve, reject) => {
        const [host, ...p] = h.split('/');
        const req = https.get({ host, path: '/' + p.join('/'), timeout: timeoutMs, headers: { 'User-Agent': 'curl/8' } }, (res) => {
            let b = ''; res.on('data', (d) => { b += d; if (b.length > 100) req.destroy(); }); res.on('end', () => { const ip = b.trim(); /^[\d.]{7,15}$|^[0-9a-f:]{3,45}$/i.test(ip) ? resolve(ip) : reject(new Error('bad ip')); });
        });
        req.on('timeout', () => req.destroy(new Error('timeout'))); req.on('error', reject);
    });
    return Promise.any(hosts.map(one));
}

// -> { url, source }. Cached for 10 minutes.
async function get({ fresh = false, env = process.env, ipLookup = publicIp } = {}) {
    if (!fresh && cache && Date.now() - cache.at < TTL) return cache;
    let found = fromEnv(env);
    if (!found) {
        const p = port(env);
        try { const ip = await ipLookup(); if (p) found = { url: `http://${ip}${p === 80 ? '' : ':' + p}`, source: 'public IP' }; } catch { /* offline / blocked */ }
    }
    if (!found) found = { url: clean(config.PAIR_WEB_FALLBACK || 'https://subzero.mrfrankofc.com'), source: 'default' };
    cache = { ...found, at: Date.now() };
    return cache;
}

module.exports = { get, setPort, fromEnv, port, publicIp, _reset: () => { cache = null; boundPort = null; } };
