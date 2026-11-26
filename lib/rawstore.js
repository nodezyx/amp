// SUBZERO MD MINI - raw message capture
//
// Baileys decodes every message into a protobuf object, and protobuf decoding silently DROPS fields its bundled
// WAProto does not know about (any new WhatsApp feature). So a decoded object can never be a complete copy.
// This module keeps the exact bytes instead:
//   * proto.Message.decode is wrapped so a top-level decode also remembers the raw bytes (hidden __raw property)
//   * proto.Message.encode is wrapped so a message flagged __replayRaw is re-sent with those exact bytes
//   * the stanza (without the encrypted payload) is kept too, like the CRM bot does (CB:message)
// Everything is best effort: a self test runs at load and the wrappers are removed if it fails, so the bot
// itself is never affected.

const fs = require('fs');
const path = require('path');
const { proto } = require('baileys');

const MAX_ENTRIES = 4000;
const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_RAW = 96 * 1024;
const PAYLOAD_DIR = path.join(__dirname, '..', 'data', 'rawmsgs');
const MAX_PAYLOAD_FILES = 60;

const entries = new Map();   // message id -> { raw: base64|null, node: object|null, ts }
const payloads = new Map();  // exported envelope id -> envelope (memory copy of the disk files)
let active = false;
let originals = null;

function install() {
    if (active) return true;
    try {
        const M = proto.Message;
        const od = M.decode, oe = M.encode;
        if (typeof od !== 'function' || typeof oe !== 'function') return false;
        originals = { od, oe };
        M.decode = function (reader, length, ...rest) {
            const out = od.call(this, reader, length, ...rest);
            try {
                // top level calls get bytes; nested calls get a Reader (which has .pos)
                if (out && reader && typeof reader === 'object' && typeof reader.pos !== 'number' && reader.length && reader.length <= MAX_RAW) {
                    Object.defineProperty(out, '__raw', { value: Buffer.from(reader), enumerable: false, configurable: true, writable: true });
                }
            } catch { /* never break decoding */ }
            return out;
        };
        M.encode = function (m, writer) {
            if (!writer && m && m.__replayRaw) {
                const raw = m.__replayRaw;
                return { finish: () => raw, ldelim() { return this; } };
            }
            return oe.call(this, m, writer);
        };
        // self test: decode keeps the bytes, encode of a flagged message returns exactly those bytes
        const bytes = Buffer.from(oe.call(M, M.fromObject({ conversation: 'selftest' })).finish());
        const d = M.decode(bytes);
        if (!d.__raw || !d.__raw.equals(bytes) || d.conversation !== 'selftest') throw new Error('decode check failed');
        Object.defineProperty(d, '__replayRaw', { value: d.__raw, enumerable: false, configurable: true });
        if (!Buffer.from(M.encode(d).finish()).equals(bytes)) throw new Error('encode check failed');
        active = true;
    } catch (err) {
        console.warn('[rawstore] raw capture disabled:', err.message);
        uninstall();
    }
    return active;
}

function uninstall() {
    try { if (originals) { proto.Message.decode = originals.od; proto.Message.encode = originals.oe; } } catch { /* ignore */ }
    originals = null; active = false;
}

const rep = (_k, v) => (v instanceof Uint8Array ? { __buf: Buffer.from(v).toString('base64') } : v?.type === 'Buffer' && Array.isArray(v.data) ? { __buf: Buffer.from(v.data).toString('base64') } : v);

const MAX_BYTES = 24 * 1024 * 1024; // hard ceiling for everything kept in memory here
const sizeOf = (e) => (e?.raw ? e.raw.length : 0) + (e?.node ? 600 : 0);
function prune() {
    const cutoff = Date.now() - TTL_MS;
    let bytes = 0;
    for (const e of entries.values()) bytes += sizeOf(e);
    for (const [id, e] of entries) {
        if (e.ts < cutoff || entries.size > MAX_ENTRIES || bytes > MAX_BYTES) { bytes -= sizeOf(e); entries.delete(id); } else break;
    }
}
function put(id, patch) {
    if (!id) return;
    const prev = entries.get(id) || {};
    entries.delete(id);
    entries.set(id, { ...prev, ...patch, ts: Date.now() });
    prune();
}

function rememberMessage(msg) {
    try {
        const id = msg?.key?.id;
        const raw = msg?.message?.__raw;
        if (id && raw) put(id, { raw: Buffer.from(raw).toString('base64') });
    } catch { /* ignore */ }
}
function rememberNode(node) {
    try {
        const id = node?.attrs?.id;
        if (!id) return;
        const slim = { tag: node.tag, attrs: node.attrs, content: Array.isArray(node.content) ? node.content.filter((c) => c?.tag !== 'enc') : undefined };
        put(id, { node: JSON.parse(JSON.stringify(slim, rep)) });
    } catch { /* ignore */ }
}

const bound = new WeakSet();
function bind(sock) {
    if (!sock || bound.has(sock)) return;
    bound.add(sock);
    install();
    try { sock.ev.on('messages.upsert', ({ messages }) => (messages || []).forEach(rememberMessage)); } catch { /* ignore */ }
    try { sock.ws.on('CB:message', rememberNode); } catch { /* ignore */ }
}

const get = (id) => entries.get(id) || null;

// ---- exported envelopes: so .try works when the user replies to ANY message of a .getmsg answer
function savePayload(id, envelope) {
    if (!id) return;
    payloads.set(id, envelope);
    if (payloads.size > 200) payloads.delete(payloads.keys().next().value);
    try {
        fs.mkdirSync(PAYLOAD_DIR, { recursive: true });
        fs.writeFileSync(path.join(PAYLOAD_DIR, `${String(id).replace(/[^\w-]/g, '_')}.json`), JSON.stringify(envelope));
        const files = fs.readdirSync(PAYLOAD_DIR).map((f) => ({ f, t: fs.statSync(path.join(PAYLOAD_DIR, f)).mtimeMs })).sort((a, b) => b.t - a.t);
        files.slice(MAX_PAYLOAD_FILES).forEach((x) => fs.unlink(path.join(PAYLOAD_DIR, x.f), () => {}));
    } catch { /* memory copy still works */ }
}
function loadPayload(id) {
    if (!id) return null;
    if (payloads.has(id)) return payloads.get(id);
    try { return JSON.parse(fs.readFileSync(path.join(PAYLOAD_DIR, `${String(id).replace(/[^\w-]/g, '_')}.json`), 'utf8')); } catch { return null; }
}

module.exports = { install, uninstall, bind, get, savePayload, loadPayload, isActive: () => active, rememberMessage, rememberNode };
