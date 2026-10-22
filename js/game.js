// Authoritative match logic. Runs only on the room host; clients receive `toJSON()` snapshots.
import {
  initialState, legalMoves, pseudoMoves, applyMove, inCheck, insufficientMaterial,
  positionKey, toSan, other, rankOf, sqName,
} from './chess.js';

export const MODES = {
  normal: { name: 'Klasik', tag: 'Normal satranç' },
  uno: { name: 'Unolu', tag: 'Kart çek, kaderine oyna' },
};

export const UNO_COLORS = ['red', 'yellow', 'green', 'blue'];

export function buildDeck(max) {
  const deck = [];
  for (const color of UNO_COLORS) {
    deck.push({ kind: 'num', n: 0, color });
    for (let n = 1; n <= max; n++) deck.push({ kind: 'num', n, color }, { kind: 'num', n, color });
    deck.push({ kind: 'skip', color }, { kind: 'rev', color }, { kind: 'd2', n: 2, color });
  }
  deck.push({ kind: 'd4', n: 4, color: 'wild' }, { kind: 'd4', n: 4, color: 'wild' });
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

// Squares where `color` may drop a revived piece of type `t`.
export function reviveSquares(board, color, t) {
  const out = [];
  for (let i = 0; i < 64; i++) {
    if (board[i]) continue;
    const r = rankOf(i);
    const ownHalf = color === 'w' ? r <= 3 : r >= 4;
    if (!ownHalf) continue;
    if (t === 'p' && (r === 0 || r === 7)) continue;
    out.push(i);
  }
  return out;
}

export class Match {
  constructor({ id, mode, white, black, time, unoMax = 5 }) {
    this.id = id;
    this.mode = mode;
    this.players = { w: white, b: black };
    this.time = time || null; // { base: ms, inc: ms }
    this.unoMax = unoMax;
    this.chess = initialState();
    this.status = 'playing';
    this.result = null;
    this.history = [];
    this.lastMove = null;
    this.captured = { w: [], b: [] }; // pieces of that colour taken off the board
    this.drawOffer = null;
    this.rematch = { w: false, b: false };
    this.rematchId = null;
    this.seq = 0;
    this.createdAt = Date.now();
    this.reps = new Map();
    this.bumpRep();
    this.clock = this.time
      ? { w: this.time.base, b: this.time.base, running: 'w', since: Date.now() }
      : null;
    if (mode === 'uno') {
      this.deck = buildDeck(unoMax);
      this.uno = { phase: 'draw', card: null, cardSeq: 0, movesLeft: 0, reviveLeft: 0, swaps: 0 };
    }
  }

  get turn() { return this.chess.turn; }

  colorOf(clientId) {
    if (this.players.w === clientId) return 'w';
    if (this.players.b === clientId) return 'b';
    return null;
  }

  bumpRep() {
    const k = positionKey(this.chess);
    this.reps.set(k, (this.reps.get(k) || 0) + 1);
    return this.reps.get(k);
  }

  finish(winner, reason) {
    if (this.status === 'over') return;
    this.stopClock();
    this.status = 'over';
    this.result = { winner, reason, winnerId: winner ? this.players[winner] : null };
    this.drawOffer = null;
  }

  stopClock(now = Date.now()) {
    if (!this.clock || !this.clock.running) return;
    this.clock[this.clock.running] -= now - this.clock.since;
    this.clock.running = null;
  }

  switchClock(to, now = Date.now()) {
    if (!this.clock) return;
    const from = this.clock.running;
    if (from) {
      this.clock[from] -= now - this.clock.since;
      if (from !== to) this.clock[from] += this.time.inc;
    }
    this.clock.running = to;
    this.clock.since = now;
  }

  // Returns true when the state changed (timeout).
  tick(now = Date.now()) {
    if (this.status !== 'playing' || !this.clock || !this.clock.running) return false;
    const c = this.clock.running;
    if (this.clock[c] - (now - this.clock.since) <= 0) {
      this.stopClock(now);
      this.clock[c] = 0;
      const winner = other(c);
      if (insufficientMaterial(this.chess.board.map((p) => (p && p.c === winner ? p : p && p.t === 'k' ? p : null)))) {
        this.finish(null, 'Süre bitti, yetersiz materyal');
      } else this.finish(winner, 'Süre bitti');
      this.seq++;
      return true;
    }
    return false;
  }

  // Applies an action from a player. Returns an error string or null.
  act(clientId, a) {
    const color = this.colorOf(clientId);
    if (!color) return 'Bu maçta oyuncu değilsin.';
    if (a.kind === 'rematch') return this.requestRematch(color);
    if (this.status !== 'playing') return 'Maç bitti.';
    let err;
    switch (a.kind) {
      case 'resign': this.finish(other(color), 'Terk etti'); break;
      case 'offerDraw':
        if (this.drawOffer && this.drawOffer !== color) this.finish(null, 'Anlaşmalı beraberlik');
        else this.drawOffer = color;
        break;
      case 'declineDraw': if (this.drawOffer === other(color)) this.drawOffer = null; break;
      case 'move': err = this.mode === 'uno' ? this.unoMove(color, a) : this.normalMove(color, a); break;
      case 'draw': err = this.unoDraw(color); break;
      case 'revive': err = this.unoRevive(color, a); break;
      default: err = 'Bilinmeyen hamle.';
    }
    if (!err) this.seq++;
    return err || null;
  }

  requestRematch(color) {
    if (this.status !== 'over' || this.rematchId) return 'Rövanş şu an mümkün değil.';
    this.rematch[color] = true;
    this.seq++;
    return null;
  }

  findMove(list, a) {
    return list.find((m) => m.from === a.from && m.to === a.to && (!m.promo || m.promo === (a.promo || 'q')));
  }

  recordCapture(captured) {
    if (captured) this.captured[captured.c].push(captured.t);
  }

  normalMove(color, a) {
    if (color !== this.turn) return 'Sıra sende değil.';
    const list = legalMoves(this.chess, color);
    const mv = this.findMove(list, a);
    if (!mv) return 'Geçersiz hamle.';
    const san = toSan(this.chess, mv, list, true);
    const { state, captured } = applyMove(this.chess, mv);
    state.turn = other(color);
    this.chess = state;
    this.recordCapture(captured);
    this.lastMove = { from: mv.from, to: mv.to };
    this.history.push({ type: 'move', color, san });
    if (this.drawOffer === color) this.drawOffer = null;
    this.switchClock(state.turn);
    const opp = state.turn;
    if (!legalMoves(state, opp).length) {
      if (inCheck(state, opp)) this.finish(color, 'Şah mat');
      else this.finish(null, 'Pat');
    } else if (insufficientMaterial(state.board)) this.finish(null, 'Yetersiz materyal');
    else if (this.bumpRep() >= 3) this.finish(null, 'Üç kez tekrar');
    else if (state.half >= 100) this.finish(null, '50 hamle kuralı');
    return null;
  }

  // ---- Uno mode -------------------------------------------------------------

  unoDraw(color) {
    if (color !== this.turn || this.uno.phase !== 'draw') return 'Şu an kart çekemezsin.';
    if (!this.deck.length) this.deck = buildDeck(this.unoMax);
    const card = this.deck.pop();
    const u = this.uno;
    u.card = { ...card, by: color };
    u.cardSeq++;
    this.history.push({ type: 'card', color, card });
    this.drawOffer = null;
    if (card.kind === 'num' && card.n > 0) {
      u.movesLeft = card.n;
      u.phase = 'move';
      if (!pseudoMoves(this.chess, color).length) this.unoEndTurn();
    } else if (card.kind === 'num' || card.kind === 'skip') {
      this.unoEndTurn();
    } else if (card.kind === 'rev') {
      // Players swap sides; the colour to move stays, now in the other player's hands.
      this.players = { w: this.players.b, b: this.players.w };
      u.swaps++;
      this.history.push({ type: 'swap' });
      u.phase = 'draw';
    } else {
      u.reviveLeft = Math.min(card.n, this.captured[color].length);
      u.phase = 'revive';
      if (!this.canRevive(color)) this.unoEndTurn();
    }
    return null;
  }

  canRevive(color) {
    return this.uno.reviveLeft > 0 &&
      this.captured[color].some((t) => reviveSquares(this.chess.board, color, t).length);
  }

  unoMove(color, a) {
    if (color !== this.turn || this.uno.phase !== 'move') return 'Şu an hamle yapamazsın.';
    const list = pseudoMoves(this.chess, color);
    const mv = this.findMove(list, a);
    if (!mv) return 'Geçersiz hamle.';
    const san = toSan(this.chess, mv, list, false);
    const { state, captured } = applyMove(this.chess, mv);
    state.turn = color;
    this.chess = state;
    this.recordCapture(captured);
    this.lastMove = { from: mv.from, to: mv.to };
    this.history.push({ type: 'move', color, san });
    if (captured && captured.t === 'k') {
      this.finish(color, 'Şah alındı');
      return null;
    }
    this.uno.movesLeft--;
    if (this.uno.movesLeft <= 0 || !pseudoMoves(this.chess, color).length) this.unoEndTurn();
    return null;
  }

  unoRevive(color, a) {
    if (color !== this.turn || this.uno.phase !== 'revive') return 'Şu an taş canlandıramazsın.';
    const pool = this.captured[color];
    const idx = pool.indexOf(a.t);
    if (idx < 0) return 'Bu taş canlandırılamaz.';
    if (!reviveSquares(this.chess.board, color, a.t).includes(a.sq)) return 'Bu kareye koyamazsın.';
    pool.splice(idx, 1);
    const s = this.chess;
    s.board = s.board.slice();
    s.board[a.sq] = { t: a.t, c: color, id: s.nextId++, m: true, revived: true };
    this.history.push({ type: 'revive', color, t: a.t, sq: sqName(a.sq) });
    this.lastMove = { from: a.sq, to: a.sq };
    this.uno.reviveLeft--;
    if (!this.canRevive(color)) this.unoEndTurn();
    return null;
  }

  unoEndTurn() {
    const next = other(this.turn);
    this.chess.turn = next;
    this.uno.phase = 'draw';
    this.uno.movesLeft = 0;
    this.uno.reviveLeft = 0;
    this.switchClock(next);
  }

  toJSON(now = Date.now()) {
    let clock = null;
    if (this.clock) {
      clock = { w: this.clock.w, b: this.clock.b, running: this.clock.running };
      if (this.clock.running) clock[this.clock.running] -= now - this.clock.since;
    }
    const checks = this.status === 'playing'
      ? ['w', 'b'].filter((c) => inCheck(this.chess, c))
      : [];
    return {
      id: this.id,
      mode: this.mode,
      players: this.players,
      time: this.time,
      unoMax: this.unoMax,
      chess: this.chess,
      status: this.status,
      result: this.result,
      history: this.history,
      lastMove: this.lastMove,
      captured: this.captured,
      drawOffer: this.drawOffer,
      rematch: this.rematch,
      rematchId: this.rematchId,
      seq: this.seq,
      createdAt: this.createdAt,
      checks,
      clock,
      uno: this.uno ? { ...this.uno, deckCount: this.deck.length } : null,
    };
  }

  // Persistence for host reloads
  dump() {
    return { ...this.toJSON(), deck: this.deck, reps: [...this.reps], rawClock: this.clock };
  }

  static restore(d) {
    const m = Object.create(Match.prototype);
    Object.assign(m, {
      id: d.id, mode: d.mode, players: d.players, time: d.time, unoMax: d.unoMax, chess: d.chess,
      status: d.status, result: d.result, history: d.history, lastMove: d.lastMove,
      captured: d.captured, drawOffer: d.drawOffer, rematch: d.rematch, rematchId: d.rematchId,
      seq: d.seq + 1, createdAt: d.createdAt, reps: new Map(d.reps), deck: d.deck,
      uno: d.uno ? { ...d.uno } : undefined, clock: d.rawClock,
    });
    if (m.uno) delete m.uno.deckCount;
    // Do not charge the time the host was away
    if (m.clock && m.clock.running) m.clock.since = Date.now();
    return m;
  }
}
