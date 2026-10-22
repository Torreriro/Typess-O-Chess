// Small, dependency-free chess engine.
// Squares are 0..63, index = rank * 8 + file, rank 0 is White's back rank.
// Every piece carries a stable id so the UI can animate it across moves.

export const FILES = 'abcdefgh';
export const sqName = (i) => FILES[i & 7] + ((i >> 3) + 1);
export const sqIndex = (n) => (n.charCodeAt(1) - 49) * 8 + (n.charCodeAt(0) - 97);
export const fileOf = (i) => i & 7;
export const rankOf = (i) => i >> 3;
export const other = (c) => (c === 'w' ? 'b' : 'w');

const KNIGHT = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
const KING = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
const ROOK_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const BISHOP_DIRS = [[1, 1], [1, -1], [-1, 1], [-1, -1]];

export const VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

export function initialState() {
  const board = new Array(64).fill(null);
  const back = ['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r'];
  let id = 1;
  for (let f = 0; f < 8; f++) {
    board[f] = { t: back[f], c: 'w', id: id++, m: false };
    board[8 + f] = { t: 'p', c: 'w', id: id++, m: false };
    board[48 + f] = { t: 'p', c: 'b', id: id++, m: false };
    board[56 + f] = { t: back[f], c: 'b', id: id++, m: false };
  }
  return { board, turn: 'w', ep: null, half: 0, full: 1, nextId: id };
}

export function cloneState(s) {
  return { ...s, board: s.board.map((p) => (p ? { ...p } : null)) };
}

function step(i, df, dr) {
  const f = fileOf(i) + df;
  const r = rankOf(i) + dr;
  if (f < 0 || f > 7 || r < 0 || r > 7) return -1;
  return r * 8 + f;
}

export function isAttacked(board, sq, by) {
  // Pawns
  const pr = by === 'w' ? -1 : 1;
  for (const df of [-1, 1]) {
    const s = step(sq, df, pr);
    if (s >= 0 && board[s] && board[s].c === by && board[s].t === 'p') return true;
  }
  for (const [df, dr] of KNIGHT) {
    const s = step(sq, df, dr);
    if (s >= 0 && board[s] && board[s].c === by && board[s].t === 'n') return true;
  }
  for (const [df, dr] of KING) {
    const s = step(sq, df, dr);
    if (s >= 0 && board[s] && board[s].c === by && board[s].t === 'k') return true;
  }
  for (const [dirs, kinds] of [[ROOK_DIRS, 'rq'], [BISHOP_DIRS, 'bq']]) {
    for (const [df, dr] of dirs) {
      let s = step(sq, df, dr);
      while (s >= 0) {
        const p = board[s];
        if (p) {
          if (p.c === by && kinds.includes(p.t)) return true;
          break;
        }
        s = step(s, df, dr);
      }
    }
  }
  return false;
}

export function kingSquare(board, c) {
  for (let i = 0; i < 64; i++) if (board[i] && board[i].c === c && board[i].t === 'k') return i;
  return -1;
}

export function inCheck(s, c) {
  const k = kingSquare(s.board, c);
  return k >= 0 && isAttacked(s.board, k, other(c));
}

// Moves that follow piece movement rules, ignoring whether the own king is left in check.
export function pseudoMoves(s, c) {
  const out = [];
  const b = s.board;
  const add = (from, to, extra = {}) => {
    const p = b[from];
    if (p.t === 'p' && (rankOf(to) === 7 || rankOf(to) === 0)) {
      for (const promo of ['q', 'r', 'b', 'n']) out.push({ from, to, promo, capture: !!b[to], ...extra });
    } else out.push({ from, to, capture: !!b[to] || !!extra.ep, ...extra });
  };
  for (let i = 0; i < 64; i++) {
    const p = b[i];
    if (!p || p.c !== c) continue;
    if (p.t === 'p') {
      const dir = c === 'w' ? 1 : -1;
      const startRank = c === 'w' ? 1 : 6;
      const one = step(i, 0, dir);
      if (one >= 0 && !b[one]) {
        add(i, one);
        const two = step(i, 0, 2 * dir);
        if (rankOf(i) === startRank && two >= 0 && !b[two]) add(i, two, { double: true });
      }
      for (const df of [-1, 1]) {
        const t = step(i, df, dir);
        if (t < 0) continue;
        if (b[t] && b[t].c !== c) add(i, t);
        else if (t === s.ep && !b[t]) {
          // Only the opponent of the pawn that just double-pushed may take en passant
          const behind = b[t - dir * 8];
          if (behind && behind.t === 'p' && behind.c !== c) add(i, t, { ep: true });
        }
      }
    } else if (p.t === 'n' || p.t === 'k') {
      for (const [df, dr] of p.t === 'n' ? KNIGHT : KING) {
        const t = step(i, df, dr);
        if (t >= 0 && (!b[t] || b[t].c !== c)) add(i, t);
      }
      if (p.t === 'k' && !p.m) castleMoves(s, i, c, out);
    } else {
      const dirs = p.t === 'r' ? ROOK_DIRS : p.t === 'b' ? BISHOP_DIRS : ROOK_DIRS.concat(BISHOP_DIRS);
      for (const [df, dr] of dirs) {
        let t = step(i, df, dr);
        while (t >= 0) {
          if (b[t]) {
            if (b[t].c !== c) add(i, t);
            break;
          }
          add(i, t);
          t = step(t, df, dr);
        }
      }
    }
  }
  return out;
}

function castleMoves(s, k, c, out) {
  const b = s.board;
  const home = c === 'w' ? 0 : 56;
  if (k !== home + 4) return;
  const opp = other(c);
  if (isAttacked(b, k, opp)) return;
  // King side
  const rk = b[home + 7];
  if (rk && rk.t === 'r' && rk.c === c && !rk.m && !b[home + 5] && !b[home + 6] &&
      !isAttacked(b, home + 5, opp) && !isAttacked(b, home + 6, opp)) {
    out.push({ from: k, to: home + 6, castle: 'k', capture: false });
  }
  const rq = b[home];
  if (rq && rq.t === 'r' && rq.c === c && !rq.m && !b[home + 1] && !b[home + 2] && !b[home + 3] &&
      !isAttacked(b, home + 3, opp) && !isAttacked(b, home + 2, opp)) {
    out.push({ from: k, to: home + 2, castle: 'q', capture: false });
  }
}

// Applies a move and returns { state, captured }. Does not validate.
export function applyMove(s, mv) {
  const n = cloneState(s);
  const b = n.board;
  const p = b[mv.from];
  let captured = b[mv.to];
  if (mv.ep) {
    const capSq = mv.to + (p.c === 'w' ? -8 : 8);
    captured = b[capSq];
    b[capSq] = null;
  }
  b[mv.to] = p;
  b[mv.from] = null;
  p.m = true;
  if (mv.promo) p.t = mv.promo;
  if (mv.castle) {
    const home = p.c === 'w' ? 0 : 56;
    const [rf, rt] = mv.castle === 'k' ? [home + 7, home + 5] : [home, home + 3];
    b[rt] = b[rf];
    b[rf] = null;
    b[rt].m = true;
  }
  n.ep = mv.double ? (mv.from + mv.to) / 2 : null;
  n.half = p.t === 'p' || captured ? 0 : n.half + 1;
  if (p.c === 'b') n.full += 1;
  return { state: n, captured: captured || null };
}

export function legalMoves(s, c = s.turn) {
  return pseudoMoves(s, c).filter((mv) => !inCheck(applyMove(s, mv).state, c));
}

export function insufficientMaterial(board) {
  const rest = [];
  for (let i = 0; i < 64; i++) {
    const p = board[i];
    if (!p || p.t === 'k') continue;
    if (p.t === 'p' || p.t === 'r' || p.t === 'q') return false;
    rest.push({ t: p.t, c: p.c, color: (fileOf(i) + rankOf(i)) & 1 });
  }
  if (rest.length <= 1) return true;
  // Only bishops, all on the same square colour
  return rest.every((p) => p.t === 'b') && rest.every((p) => p.color === rest[0].color);
}

export function positionKey(s) {
  let k = '';
  for (let i = 0; i < 64; i++) {
    const p = s.board[i];
    k += p ? (p.c === 'w' ? p.t.toUpperCase() : p.t) + (p.t === 'k' || p.t === 'r' ? (p.m ? '' : '*') : '') : '.';
  }
  return k + s.turn + (s.ep ?? '-');
}

const LETTER = { n: 'N', b: 'B', r: 'R', q: 'Q', k: 'K' };

// Standard algebraic notation. `all` is the move list the move was chosen from (for disambiguation).
export function toSan(s, mv, all, withCheck = true) {
  const p = s.board[mv.from];
  let san;
  if (mv.castle) san = mv.castle === 'k' ? 'O-O' : 'O-O-O';
  else if (p.t === 'p') {
    san = mv.capture ? FILES[fileOf(mv.from)] + 'x' + sqName(mv.to) : sqName(mv.to);
    if (mv.promo) san += '=' + LETTER[mv.promo];
  } else {
    san = LETTER[p.t];
    const rivals = all.filter((m) => m.to === mv.to && m.from !== mv.from && s.board[m.from].t === p.t);
    if (rivals.length) {
      const sameFile = rivals.some((m) => fileOf(m.from) === fileOf(mv.from));
      const sameRank = rivals.some((m) => rankOf(m.from) === rankOf(mv.from));
      if (!sameFile) san += FILES[fileOf(mv.from)];
      else if (!sameRank) san += rankOf(mv.from) + 1;
      else san += sqName(mv.from);
    }
    if (mv.capture) san += 'x';
    san += sqName(mv.to);
  }
  if (withCheck) {
    const next = applyMove(s, mv).state;
    next.turn = other(p.c);
    if (inCheck(next, next.turn)) san += legalMoves(next).length ? '+' : '#';
  }
  return san;
}
