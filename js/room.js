// The room "server". It lives in the room manager's browser tab and is the single
// source of truth: guests send it intents, it broadcasts full snapshots back.
import { Match } from './game.js';

const FORFEIT_AFTER = 60_000;
const MAX_FINISHED = 12;

const uid = () => Math.random().toString(36).slice(2, 9);

export class RoomServer {
  constructor({ code, hostId, hostName, onBroadcast, saved }) {
    this.code = code;
    this.hostId = hostId;
    this.onBroadcast = onBroadcast;
    this.members = new Map();
    this.matches = new Map();
    this.chat = [];
    this.queued = false;
    if (saved) this.load(saved);
    this.join(hostId, hostName);
    this.timer = setInterval(() => this.tick(), 250);
  }

  destroy() { clearInterval(this.timer); }

  // ---- membership -----------------------------------------------------------

  join(clientId, rawName) {
    let name = String(rawName || 'Oyuncu').trim().slice(0, 20) || 'Oyuncu';
    const existing = this.members.get(clientId);
    if (existing) {
      existing.online = true;
      existing.offlineSince = null;
    } else if (this.reclaim(clientId, name)) {
      this.system(`${name} geri döndü`);
    } else {
      const taken = new Set([...this.members.values()].map((m) => m.name.toLowerCase()));
      let n = 2;
      const base = name;
      while (taken.has(name.toLowerCase())) name = `${base} ${n++}`;
      this.members.set(clientId, { id: clientId, name, online: true, offlineSince: null, joinedAt: Date.now() });
      if (clientId !== this.hostId) this.system(`${name} odaya katıldı`);
    }
    this.changed();
  }

  // Someone rejoining from a new tab with the name of an offline member takes over that seat.
  reclaim(clientId, name) {
    const ghost = [...this.members.values()].find((m) =>
      !m.online && m.id !== this.hostId && m.name.toLowerCase() === name.toLowerCase());
    if (!ghost) return false;
    const old = ghost.id;
    this.members.delete(old);
    this.members.set(clientId, { ...ghost, id: clientId, online: true, offlineSince: null });
    for (const m of this.matches.values()) {
      for (const c of ['w', 'b']) if (m.players[c] === old) m.players[c] = clientId;
      if (m.result && m.result.winnerId === old) m.result.winnerId = clientId;
      m.seq++;
    }
    for (const msg of this.chat) if (msg.from === old) msg.from = clientId;
    return true;
  }

  leave(clientId) {
    const m = this.members.get(clientId);
    if (!m || clientId === this.hostId) return;
    m.online = false;
    m.offlineSince = Date.now();
    this.changed();
  }

  kick(clientId) {
    const m = this.members.get(clientId);
    if (!m || clientId === this.hostId) return;
    for (const match of this.activeMatchesOf(clientId)) {
      match.finish(match.colorOf(clientId) === 'w' ? 'b' : 'w', 'Oyuncu odadan çıkarıldı');
      match.seq++;
    }
    this.members.delete(clientId);
    this.system(`${m.name} odadan çıkarıldı`);
    this.changed();
  }

  activeMatchesOf(clientId) {
    return [...this.matches.values()].filter((m) => m.status === 'playing' && m.colorOf(clientId));
  }

  system(text) {
    this.chat.push({ id: uid(), system: true, text, at: Date.now() });
    if (this.chat.length > 80) this.chat.shift();
  }

  // ---- messages -------------------------------------------------------------

  // Returns an error string to send back to the sender, or null.
  handle(clientId, msg) {
    if (!msg || typeof msg !== 'object') return null;
    const isHost = clientId === this.hostId;
    if (msg.type !== 'hello' && !this.members.has(clientId)) return 'Odada değilsin.';
    const sender = this.members.get(clientId);
    if (sender && !sender.online && msg.type !== 'hello') {
      // A message proves the link is alive again
      sender.online = true;
      sender.offlineSince = null;
      this.changed();
    }
    switch (msg.type) {
      case 'hello': this.join(clientId, msg.name); return null;
      case 'chat': {
        const text = String(msg.text || '').trim().slice(0, 300);
        if (!text) return null;
        this.chat.push({ id: uid(), from: clientId, text, at: Date.now() });
        if (this.chat.length > 80) this.chat.shift();
        this.changed();
        return null;
      }
      case 'act': {
        const match = this.matches.get(msg.matchId);
        if (!match) return 'Maç bulunamadı.';
        const err = match.act(clientId, msg.action || {});
        if (!err) {
          if (match.rematch.w && match.rematch.b && !match.rematchId) this.startRematch(match);
          this.changed();
        }
        return err;
      }
      case 'create': return isHost ? this.createMatch(msg) : 'Yalnızca oda yöneticisi maç kurabilir.';
      case 'abort': {
        if (!isHost) return 'Yalnızca oda yöneticisi maçı bitirebilir.';
        const match = this.matches.get(msg.matchId);
        if (match && match.status === 'playing') {
          match.finish(null, 'Yönetici maçı sonlandırdı');
          match.seq++;
          this.changed();
        }
        return null;
      }
      case 'dismiss': {
        if (!isHost) return null;
        const match = this.matches.get(msg.matchId);
        if (match && match.status === 'over') this.matches.delete(msg.matchId);
        this.changed();
        return null;
      }
      case 'kick': if (isHost) this.kick(msg.clientId); return null;
      default: return null;
    }
  }

  createMatch({ white, black, mode, time, unoMax, randomColor }) {
    if (!['normal', 'uno'].includes(mode)) return 'Geçersiz mod.';
    if (!this.members.has(white) || !this.members.has(black)) return 'Oyuncular odada değil.';
    if (white === black) return 'İki farklı oyuncu seçmelisin.';
    for (const p of [white, black]) {
      if (this.activeMatchesOf(p).length) return `${this.members.get(p).name} zaten bir maçta.`;
    }
    if (randomColor && Math.random() < 0.5) [white, black] = [black, white];
    const t = time && time.base > 0 ? { base: Math.min(time.base, 3600_000), inc: Math.min(time.inc || 0, 60_000) } : null;
    const match = new Match({ id: uid(), mode, white, black, time: t, unoMax: [3, 5, 9].includes(unoMax) ? unoMax : 5 });
    this.matches.set(match.id, match);
    const n = (id) => this.members.get(id).name;
    this.system(`${n(white)} ile ${n(black)} eşleşti · ${mode === 'uno' ? 'Unolu' : 'Klasik'}`);
    this.pruneFinished();
    this.changed();
    return null;
  }

  startRematch(old) {
    const match = new Match({
      id: uid(), mode: old.mode, white: old.players.b, black: old.players.w,
      time: old.time, unoMax: old.unoMax,
    });
    old.rematchId = match.id;
    old.seq++;
    this.matches.set(match.id, match);
  }

  pruneFinished() {
    const done = [...this.matches.values()].filter((m) => m.status === 'over').sort((a, b) => a.createdAt - b.createdAt);
    while (done.length > MAX_FINISHED) this.matches.delete(done.shift().id);
  }

  tick() {
    const now = Date.now();
    let dirty = false;
    for (const m of this.matches.values()) if (m.tick(now)) dirty = true;
    for (const mem of this.members.values()) {
      if (mem.online || !mem.offlineSince || now - mem.offlineSince < FORFEIT_AFTER) continue;
      for (const match of this.activeMatchesOf(mem.id)) {
        match.finish(match.colorOf(mem.id) === 'w' ? 'b' : 'w', 'Rakibin bağlantısı koptu');
        match.seq++;
        dirty = true;
      }
    }
    if (dirty) this.changed();
  }

  // ---- snapshots ------------------------------------------------------------

  changed() {
    if (this.queued) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      this.onBroadcast(this.snapshot());
    });
  }

  snapshot() {
    const now = Date.now();
    return {
      code: this.code,
      hostId: this.hostId,
      members: [...this.members.values()].map(({ id, name, online, joinedAt }) => ({ id, name, online, joinedAt })),
      matches: [...this.matches.values()].map((m) => m.toJSON(now)),
      chat: this.chat,
      sentAt: now,
    };
  }

  dump() {
    return {
      code: this.code,
      hostId: this.hostId,
      savedAt: Date.now(),
      members: [...this.members.values()],
      matches: [...this.matches.values()].map((m) => m.dump()),
      chat: this.chat,
    };
  }

  load(saved) {
    for (const m of saved.members) this.members.set(m.id, { ...m, online: m.id === this.hostId, offlineSince: m.id === this.hostId ? null : Date.now() });
    for (const d of saved.matches) this.matches.set(d.id, Match.restore(d));
    this.chat = saved.chat || [];
  }
}
