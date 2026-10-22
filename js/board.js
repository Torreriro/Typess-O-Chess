// Interactive board. Pieces are absolutely positioned and keyed by id,
// so any change of square is animated by a CSS transform transition.
import { fileOf, rankOf, FILES } from './chess.js';

export const pieceUrl = (c, t) => `assets/pieces/${c}${t.toUpperCase()}.svg`;

export class BoardView {
  constructor(root, { onMove, onSquare } = {}) {
    this.onMove = onMove;
    this.onSquare = onSquare;
    this.orientation = 'w';
    this.pieces = new Map();
    this.opts = {};
    this.selected = null;
    this.first = true;

    this.el = document.createElement('div');
    this.el.className = 'board';
    this.squaresEl = document.createElement('div');
    this.squaresEl.className = 'squares';
    this.piecesEl = document.createElement('div');
    this.piecesEl.className = 'pieces';
    this.el.append(this.squaresEl, this.piecesEl);
    this.sq = [];
    for (let i = 0; i < 64; i++) {
      const d = document.createElement('div');
      d.className = 'sq';
      this.sq.push(d);
    }
    this.layoutSquares();
    root.append(this.el);

    this.el.addEventListener('pointerdown', (e) => this.down(e));
    window.addEventListener('pointermove', (this._mv = (e) => this.move(e)));
    window.addEventListener('pointerup', (this._up = (e) => this.up(e)));
    window.addEventListener('pointercancel', (this._cancel = () => this.cancelDrag()));
  }

  destroy() {
    window.removeEventListener('pointermove', this._mv);
    window.removeEventListener('pointerup', this._up);
    window.removeEventListener('pointercancel', this._cancel);
    this.el.remove();
  }

  pos(i) {
    const f = fileOf(i), r = rankOf(i);
    return this.orientation === 'w' ? [f, 7 - r] : [7 - f, r];
  }

  layoutSquares() {
    this.squaresEl.textContent = '';
    const order = [];
    for (let i = 0; i < 64; i++) order.push(i);
    order.sort((a, b) => {
      const [ax, ay] = this.pos(a), [bx, by] = this.pos(b);
      return ay - by || ax - bx;
    });
    for (const i of order) {
      const d = this.sq[i];
      d.dataset.sq = i;
      d.classList.toggle('light', (fileOf(i) + rankOf(i)) % 2 === 1);
      d.classList.toggle('dark', (fileOf(i) + rankOf(i)) % 2 === 0);
      d.querySelectorAll('.coord').forEach((c) => c.remove());
      const [x, y] = this.pos(i);
      if (y === 7) d.insertAdjacentHTML('beforeend', `<span class="coord file">${FILES[fileOf(i)]}</span>`);
      if (x === 0) d.insertAdjacentHTML('beforeend', `<span class="coord rank">${rankOf(i) + 1}</span>`);
      this.squaresEl.append(d);
    }
  }

  place(el, i) {
    const [x, y] = this.pos(i);
    el.style.translate = `${x * 100}% ${y * 100}%`;
  }

  // opts: { board, orientation, lastMove, checks:[sq], movable:'w'|'b'|null, moves:[...], dropTargets:[sq]|null }
  set(opts) {
    const prev = this.opts;
    this.opts = opts;
    if (opts.orientation !== this.orientation) {
      if (this.first) { this.orientation = opts.orientation; this.layoutSquares(); }
      else return this.flipTo(opts);
    }
    const seen = new Set();
    opts.board.forEach((p, i) => {
      if (!p) return;
      seen.add(p.id);
      let el = this.pieces.get(p.id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'pc';
        el.dataset.id = p.id;
        this.place(el, i);
        if (!this.first) el.classList.add(p.revived ? 'spawn' : 'fade-in');
        this.piecesEl.append(el);
        this.pieces.set(p.id, el);
      } else if (!el.classList.contains('dragging')) {
        this.place(el, i);
      }
      el.dataset.sq = i;
      el.classList.remove('ghost');
      const key = p.c + p.t;
      if (el.dataset.key !== key) {
        el.dataset.key = key;
        el.style.backgroundImage = `url(${pieceUrl(p.c, p.t)})`;
      }
    });
    for (const [id, el] of this.pieces) {
      if (seen.has(id)) continue;
      this.pieces.delete(id);
      el.classList.add('out');
      setTimeout(() => el.remove(), 260);
    }
    this.first = false;
    if (this.selected != null && !this.targetsFrom(this.selected).length) this.selected = null;
    if (prev.board && prev.board !== opts.board) this.selected = null;
    this.paint();
  }

  flipTo(opts) {
    if (this.flipping) { this.pending = opts; return; }
    this.flipping = true;
    this.el.classList.add('flip');
    setTimeout(() => {
      this.el.classList.remove('flip');
      this.orientation = opts.orientation;
      this.layoutSquares();
      this.piecesEl.classList.add('instant');
      for (const el of this.pieces.values()) this.place(el, +el.dataset.sq);
      void this.piecesEl.offsetWidth;
      this.piecesEl.classList.remove('instant');
      this.flipping = false;
      const next = this.pending || opts;
      this.pending = null;
      this.set(next);
    }, 720);
  }

  targetsFrom(from) {
    return (this.opts.moves || []).filter((m) => m.from === from);
  }

  paint() {
    const o = this.opts;
    const targets = this.selected != null ? this.targetsFrom(this.selected) : [];
    const tset = new Set(targets.map((m) => m.to));
    const drops = new Set(o.dropTargets || []);
    for (let i = 0; i < 64; i++) {
      const c = this.sq[i].classList;
      c.toggle('last', !!o.lastMove && (o.lastMove.from === i || o.lastMove.to === i));
      c.toggle('sel', this.selected === i);
      c.toggle('target', tset.has(i) && !o.board[i]);
      c.toggle('capture', tset.has(i) && !!o.board[i]);
      c.toggle('check', (o.checks || []).includes(i));
      c.toggle('drop', drops.has(i));
      c.toggle('movable', !!o.movable && !!o.board[i] && o.board[i].c === o.movable && this.targetsFrom(i).length > 0);
    }
  }

  squareAt(x, y) {
    const r = this.el.getBoundingClientRect();
    const cx = Math.floor(((x - r.left) / r.width) * 8);
    const cy = Math.floor(((y - r.top) / r.height) * 8);
    if (cx < 0 || cx > 7 || cy < 0 || cy > 7) return null;
    const f = this.orientation === 'w' ? cx : 7 - cx;
    const rk = this.orientation === 'w' ? 7 - cy : cy;
    return rk * 8 + f;
  }

  cancelDrag() {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    this.sq.forEach((s) => s.classList.remove('hover'));
    d.el.classList.remove('dragging');
    this.place(d.el, d.from);
  }

  down(e) {
    if (e.button !== 0 || this.flipping) return;
    this.cancelDrag();
    const i = this.squareAt(e.clientX, e.clientY);
    if (i == null) return;
    const o = this.opts;
    if (o.dropTargets) {
      if (o.dropTargets.includes(i)) this.onSquare?.(i);
      return;
    }
    if (this.selected != null && this.targetsFrom(this.selected).some((m) => m.to === i)) {
      this.commit(this.selected, i, false);
      return;
    }
    const p = o.board[i];
    if (p && p.c === o.movable && this.targetsFrom(i).length) {
      e.preventDefault();
      this.selected = i;
      this.paint();
      const el = this.pieces.get(p.id);
      const r = this.el.getBoundingClientRect();
      this.drag = { from: i, el, startX: e.clientX, startY: e.clientY, size: r.width / 8, rect: r, moved: false };
    } else {
      this.selected = null;
      this.paint();
    }
  }

  move(e) {
    const d = this.drag;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 4) return;
    d.moved = true;
    d.el.classList.add('dragging');
    const x = e.clientX - d.rect.left - d.size / 2;
    const y = e.clientY - d.rect.top - d.size / 2;
    d.el.style.translate = `${x}px ${y}px`;
    const over = this.squareAt(e.clientX, e.clientY);
    this.sq.forEach((s, i) => s.classList.toggle('hover', i === over && this.targetsFrom(d.from).some((m) => m.to === i)));
  }

  up(e) {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    this.sq.forEach((s) => s.classList.remove('hover'));
    if (!d.moved) return;
    const to = this.squareAt(e.clientX, e.clientY);
    d.el.classList.remove('dragging');
    if (to != null && this.targetsFrom(d.from).some((m) => m.to === to)) {
      this.commit(d.from, to, true);
    } else {
      this.place(d.el, d.from);
    }
  }

  commit(from, to, dropped) {
    const options = this.targetsFrom(from).filter((m) => m.to === to);
    const p = this.opts.board[from];
    const el = this.pieces.get(p.id);
    if (dropped) el.classList.add('no-anim');
    this.place(el, to);
    if (dropped) requestAnimationFrame(() => el.classList.remove('no-anim'));
    // Optimistically hide a captured piece
    const victim = this.opts.board[to];
    if (victim) this.pieces.get(victim.id)?.classList.add('ghost');
    this.selected = null;
    this.paint();
    if (options.some((m) => m.promo)) {
      this.askPromotion(to, p.c).then((promo) => {
        if (promo) this.onMove?.({ from, to, promo });
        else this.set({ ...this.opts, board: this.opts.board.slice() });
      });
    } else this.onMove?.({ from, to });
  }

  askPromotion(to, color) {
    return new Promise((resolve) => {
      const [x, y] = this.pos(to);
      const box = document.createElement('div');
      box.className = 'promo';
      box.style.left = `${x * 12.5}%`;
      const down = y === 0;
      box.style[down ? 'top' : 'bottom'] = '0';
      for (const t of ['q', 'n', 'r', 'b']) {
        const b = document.createElement('button');
        b.style.backgroundImage = `url(${pieceUrl(color, t)})`;
        b.title = { q: 'Vezir', n: 'At', r: 'Kale', b: 'Fil' }[t];
        b.onpointerdown = (ev) => { ev.stopPropagation(); finish(t); };
        box.append(b);
      }
      const shade = document.createElement('div');
      shade.className = 'promo-shade';
      shade.onpointerdown = (ev) => { ev.stopPropagation(); finish(null); };
      const finish = (t) => { box.remove(); shade.remove(); resolve(t); };
      this.el.append(shade, box);
    });
  }
}

// Static thumbnail used on lobby match cards.
export function miniBoard(board, orientation = 'w') {
  const wrap = document.createElement('div');
  wrap.className = 'mini';
  let html = '';
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const f = orientation === 'w' ? x : 7 - x;
      const r = orientation === 'w' ? 7 - y : y;
      const p = board[r * 8 + f];
      const cls = (f + r) % 2 ? 'light' : 'dark';
      html += `<i class="${cls}"${p ? ` style="background-image:url(${pieceUrl(p.c, p.t)})"` : ''}></i>`;
    }
  }
  wrap.innerHTML = html;
  return wrap;
}
