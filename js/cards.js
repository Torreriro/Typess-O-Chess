// Card faces drawn with HTML/SVG — no image assets.

const SKIP = '<svg viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="13" fill="none" stroke="currentColor" stroke-width="5"/><path d="M11 29 29 11" stroke="currentColor" stroke-width="5" stroke-linecap="round"/></svg>';
const REV = '<svg viewBox="0 0 40 40" aria-hidden="true"><path d="M9 17c1-6 6-9 12-9h5V3l8 8-8 8v-5h-5c-3 0-6 2-6 6" fill="none" stroke="currentColor" stroke-width="4.2" stroke-linejoin="round" stroke-linecap="round" transform="rotate(-8 20 20)"/><path d="M31 23c-1 6-6 9-12 9h-5v5l-8-8 8-8v5h5c3 0 6-2 6-6" fill="none" stroke="currentColor" stroke-width="4.2" stroke-linejoin="round" stroke-linecap="round" transform="rotate(-8 20 20)"/></svg>';

export function cardGlyph(card) {
  switch (card.kind) {
    case 'num': return String(card.n);
    case 'skip': return SKIP;
    case 'rev': return REV;
    case 'd2': return '+2';
    case 'd4': return '+4';
    default: return '?';
  }
}

export function cardLabel(card) {
  switch (card.kind) {
    case 'num': return card.n === 0 ? 'Sıfır' : `${card.n} hamle`;
    case 'skip': return 'Engel';
    case 'rev': return 'Yön değiştir';
    case 'd2': return '+2 canlandır';
    case 'd4': return '+4 canlandır';
    default: return '';
  }
}

export function cardHTML(card, extra = '') {
  const g = cardGlyph(card);
  return `<div class="ucard face ${card.color} k-${card.kind} ${extra}">
    <span class="corner tl">${g}</span>
    <span class="oval">${card.kind === 'd4' ? '<i></i><i></i><i></i><i></i>' : ''}<b>${g}</b></span>
    <span class="corner br">${g}</span>
  </div>`;
}

export function cardBackHTML(extra = '') {
  return `<div class="ucard back ${extra}"><span class="oval"><b>rok</b></span></div>`;
}
