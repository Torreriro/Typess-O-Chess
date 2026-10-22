// Peer-to-peer transport (PeerJS / WebRTC). The room manager's tab acts as the server,
// so the whole site can be hosted statically (GitHub Pages) with no backend.
import { RoomServer } from './room.js';

const PREFIX = 'sahuno-v1-';
const SAVE_KEY = 'sahuno.hostRoom';
const SAVE_TTL = 15 * 60_000;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const PEER_OPTS = {
  debug: 0,
  config: {
    iceServers: [
      { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
      { urls: 'stun:stun.cloudflare.com:3478' },
      { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
    ],
  },
};

export function makeCode() {
  let s = '';
  const buf = crypto.getRandomValues(new Uint8Array(5));
  for (const b of buf) s += ALPHABET[b % ALPHABET.length];
  return s;
}

export const normalizeCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);

export function savedHostRoom(clientId) {
  try {
    const d = JSON.parse(localStorage.getItem(SAVE_KEY));
    if (d && d.hostId === clientId && Date.now() - d.savedAt < SAVE_TTL) return d;
  } catch { /* ignore */ }
  return null;
}

export function forgetHostRoom() {
  try { localStorage.removeItem(SAVE_KEY); } catch { /* ignore */ }
}

class Emitter {
  constructor() { this.handlers = {}; }
  on(ev, fn) { (this.handlers[ev] ||= []).push(fn); return this; }
  emit(ev, ...args) { for (const fn of this.handlers[ev] || []) fn(...args); }
}

// ---- Host -------------------------------------------------------------------

export class HostConnection extends Emitter {
  constructor({ clientId, name, resume }) {
    super();
    this.clientId = clientId;
    this.name = name;
    this.isHost = true;
    this.conns = new Set();
    this.saved = resume || null;
    this.code = resume ? resume.code : makeCode();
    this.attempts = 0;
    this.lastSave = 0;
    queueMicrotask(() => this.open());
  }

  open() {
    this.emit('status', 'connecting');
    const peer = new window.Peer(PREFIX + this.code, PEER_OPTS);
    this.peer = peer;
    peer.on('open', () => {
      this.attempts = 0;
      if (!this.server) {
        this.server = new RoomServer({
          code: this.code, hostId: this.clientId, hostName: this.name, saved: this.saved,
          onBroadcast: (s) => this.broadcast(s),
        });
      }
      this.emit('status', 'online');
      clearInterval(this.dog);
      this.dog = setInterval(() => this.watchdog(), 5000);
    });
    peer.on('connection', (conn) => this.accept(conn));
    peer.on('disconnected', () => {
      if (this.closed) return;
      this.emit('status', 'reconnecting');
      setTimeout(() => !this.closed && !peer.destroyed && peer.reconnect(), 1500);
    });
    peer.on('error', (err) => {
      if (this.closed) return;
      if (err.type === 'unavailable-id') {
        peer.destroy();
        // Reloading host: the old session may still hold the id for a moment.
        if (this.saved && this.attempts++ < 6) setTimeout(() => this.open(), 2500);
        else { this.saved = null; this.code = makeCode(); this.open(); }
      } else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
        this.emit('status', 'reconnecting');
      } else if (err.type === 'browser-incompatible') {
        this.emit('fatal', 'Tarayıcın WebRTC desteklemiyor.');
      }
    });
  }

  accept(conn) {
    conn.on('open', () => { conn.lastSeen = Date.now(); this.conns.add(conn); });
    conn.on('data', (msg) => {
      if (!this.server || !msg) return;
      conn.lastSeen = Date.now();
      if (msg.type === 'ping') conn.send({ type: 'pong' });
      if (msg.type === 'hello') {
        if (typeof msg.clientId !== 'string' || msg.clientId === this.clientId) return conn.close();
        for (const c of this.conns) if (c !== conn && c.clientId === msg.clientId) c.close();
        conn.clientId = msg.clientId;
        conn.send({ type: 'welcome', code: this.code });
      }
      if (!conn.clientId) return;
      const err = this.server.handle(conn.clientId, msg);
      if (err) conn.send({ type: 'error', text: err });
      else if (msg.type === 'hello') conn.send({ type: 'state', state: this.server.snapshot() });
    });
    conn.on('close', () => this.drop(conn));
    conn.on('error', () => !conn.open && this.drop(conn));
  }

  drop(conn) {
    if (!this.conns.delete(conn)) return;
    if (!this.server || !conn.clientId) return;
    const still = [...this.conns].some((c) => c.clientId === conn.clientId);
    if (!still) this.server.leave(conn.clientId);
  }

  // Data channels can die silently; guests ping every few seconds.
  watchdog() {
    const now = Date.now();
    for (const c of this.conns) {
      if (now - (c.lastSeen || 0) > 25_000) {
        try { c.close(); } catch { /* ignore */ }
        this.drop(c);
      }
    }
  }

  broadcast(state) {
    for (const c of this.conns) {
      if (c.open && c.clientId) {
        if (!this.server.members.has(c.clientId)) { c.send({ type: 'kicked' }); setTimeout(() => c.close(), 300); continue; }
        c.send({ type: 'state', state });
      }
    }
    this.emit('state', state, Date.now());
    const now = Date.now();
    if (now - this.lastSave > 800) {
      this.lastSave = now;
      try { localStorage.setItem(SAVE_KEY, JSON.stringify(this.server.dump())); } catch { /* quota */ }
    }
  }

  send(msg) {
    if (!this.server) return;
    const err = this.server.handle(this.clientId, msg);
    if (err) this.emit('error', err);
  }

  close() {
    this.closed = true;
    for (const c of this.conns) { try { c.send({ type: 'closed' }); } catch { /* ignore */ } }
    forgetHostRoom();
    clearInterval(this.dog);
    setTimeout(() => {
      this.server?.destroy();
      this.peer?.destroy();
    }, 300);
  }
}

// ---- Guest ------------------------------------------------------------------

export class GuestConnection extends Emitter {
  constructor({ clientId, name, code }) {
    super();
    this.clientId = clientId;
    this.name = name;
    this.code = code;
    this.isHost = false;
    this.everConnected = false;
    this.retries = 0;
    queueMicrotask(() => this.open());
  }

  open() {
    this.emit('status', this.everConnected ? 'reconnecting' : 'connecting');
    const peer = new window.Peer(PEER_OPTS);
    this.peer = peer;
    peer.on('open', () => this.dial());
    peer.on('error', (err) => {
      if (this.closed) return;
      if (err.type === 'peer-unavailable') {
        if (!this.everConnected) { this.emit('fatal', 'Bu kodla açık bir oda bulunamadı.'); this.close(); }
        else this.retryLater();
      } else if (err.type === 'browser-incompatible') {
        this.emit('fatal', 'Tarayıcın WebRTC desteklemiyor.');
      } else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
        this.retryLater();
      }
    });
    peer.on('disconnected', () => {
      if (!this.closed && !peer.destroyed) setTimeout(() => !this.closed && !peer.destroyed && peer.reconnect(), 1500);
    });
  }

  dial() {
    if (this.closed) return;
    // Default (binary) serialization chunks large snapshots; the JSON channel caps messages at ~16 KB.
    const conn = this.peer.connect(PREFIX + this.code, { reliable: true });
    this.conn = conn;
    const timeout = setTimeout(() => {
      if (!conn.open && !this.closed) {
        conn.close();
        if (!this.everConnected) {
          this.emit('fatal', 'Odaya bağlanılamadı. Ağın P2P bağlantıyı engelliyor olabilir.');
          this.close();
        } else this.retryLater();
      }
    }, 15000);
    conn.on('open', () => {
      clearTimeout(timeout);
      this.retries = 0;
      this.everConnected = true;
      conn.send({ type: 'hello', clientId: this.clientId, name: this.name });
      this.emit('status', 'online');
      this.lastMsg = Date.now();
      clearInterval(this.ping);
      this.ping = setInterval(() => {
        if (this.conn !== conn) return;
        if (Date.now() - this.lastMsg > 20_000) {
          clearInterval(this.ping);
          try { conn.close(); } catch { /* ignore */ }
          this.retryLater();
        } else if (conn.open) conn.send({ type: 'ping' });
      }, 5000);
    });
    conn.on('data', (msg) => {
      if (!msg) return;
      this.lastMsg = Date.now();
      if (msg.type === 'state') this.emit('state', msg.state, Date.now());
      else if (msg.type === 'error') this.emit('error', msg.text);
      else if (msg.type === 'closed') { this.emit('fatal', 'Oda yöneticisi odayı kapattı.'); this.close(); }
      else if (msg.type === 'kicked') { this.emit('fatal', 'Oda yöneticisi seni odadan çıkardı.'); this.close(); }
    });
    conn.on('close', () => {
      clearTimeout(timeout);
      if (!this.closed && this.conn === conn && this.everConnected) this.retryLater();
    });
  }

  retryLater() {
    if (this.closed || this.retryTimer) return;
    if (this.retries++ > 40) { this.emit('fatal', 'Oda ile bağlantı kurulamıyor.'); this.close(); return; }
    this.emit('status', 'reconnecting');
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.closed) return;
      if (this.peer.destroyed || this.peer.disconnected) { this.peer.destroy(); this.open(); }
      else this.dial();
    }, 3000);
  }

  send(msg) {
    if (this.conn && this.conn.open) this.conn.send(msg);
    else this.emit('error', 'Bağlantı yok, tekrar bağlanılıyor…');
  }

  close() {
    this.closed = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.ping);
    try { this.conn?.close(); } catch { /* ignore */ }
    setTimeout(() => this.peer?.destroy(), 200);
  }
}
