import { HostConnection, GuestConnection, normalizeCode, savedHostRoom, forgetHostRoom } from './net.js';
import { BoardView, miniBoard, pieceUrl } from './board.js';
import { initialState, legalMoves, pseudoMoves, applyMove, sqIndex, other, VALUE } from './chess.js';
import { reviveSquares } from './game.js';
import { cardHTML, cardBackHTML, cardLabel } from './cards.js';
import { play, isMuted, setMuted } from './sound.js';

// ---- helpers ----------------------------------------------------------------

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const store = {
  get(area, k) { try { return window[area].getItem(k); } catch { return null; } },
  set(area, k, v) { try { v == null ? window[area].removeItem(k) : window[area].setItem(k, v); } catch { /* ignore */ } },
};

function clientId() {
  let id = store.get('sessionStorage', 'sahuno.cid');
  if (!id) {
    id = 'c' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
    store.set('sessionStorage', 'sahuno.cid', id);
  }
  return id;
}

const me = { id: clientId(), name: store.get('localStorage', 'sahuno.name') || '' };

const AVATAR = ['#c8553d', '#2f6b4f', '#3b5ba5', '#b07d2b', '#7a4a8c', '#2c7a86', '#9c4a5e', '#5d6b2f'];
function avatar(name, size = '') {
  let hsh = 0;
  for (const ch of name) hsh = (hsh * 31 + ch.charCodeAt(0)) >>> 0;
  const initials = name.trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  return `<span class="av ${size}" style="--av:${AVATAR[hsh % AVATAR.length]}">${esc(initials || '?')}</span>`;
}

function toast(text, kind = '') {
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = text;
  $('#toasts').append(t);
  setTimeout(() => t.classList.add('out'), 2600);
  setTimeout(() => t.remove(), 3000);
}

function fmtClock(ms) {
  ms = Math.max(0, ms);
  if (ms < 10_000) return `0:0${Math.floor(ms / 1000)}.${Math.floor((ms % 1000) / 100)}`;
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const TIMES = [
  { id: '0', label: 'Süresiz', base: 0, inc: 0 },
  { id: '3+2', label: '3 + 2', base: 180_000, inc: 2000 },
  { id: '5+0', label: '5 dk', base: 300_000, inc: 0 },
  { id: '10+0', label: '10 dk', base: 600_000, inc: 0 },
  { id: '15+10', label: '15 + 10', base: 900_000, inc: 10_000 },
];

// ---- app state ---------------------------------------------------------------

const S = {
  conn: null,
  room: null,
  recvAt: 0,
  view: 'home',
  matchId: null,
  status: 'connecting',
  form: { white: null, black: null, mode: 'uno', time: '0', unoMax: 5, random: true },
  known: new Set(),
  seen: {},
  reviveType: null,
  confirmResign: false,
  hideResult: false,
};

const app = $('#app');
const member = (id) => S.room?.members.find((m) => m.id === id);
const nameOf = (id) => member(id)?.name || 'Ayrıldı';
const isHost = () => S.room && S.room.hostId === me.id;
const colorOf = (m, id) => (m.players.w === id ? 'w' : m.players.b === id ? 'b' : null);
const COLOR_TR = { w: 'Beyaz', b: 'Siyah' };

function header(inRoom) {
  const code = S.room?.code || S.conn?.code || '';
  return `<header class="top">
    <a class="logo" href="./" data-act="home">rok<span>.</span></a>
    ${inRoom ? `<div class="room-chip">
        <span class="dot ${S.status}"></span>
        <span class="lbl">Oda</span><b class="mono">${esc(code)}</b>
        <button class="icon" data-act="copy" title="Davet linkini kopyala"><svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/></svg></button>
      </div>` : '<span class="tagline">satranç, arkadaşlarla</span>'}
    <nav>
      <button class="icon ${isMuted() ? 'muted' : ''}" data-act="mute" title="Ses"><svg viewBox="0 0 24 24"><path d="M4 9h4l5-4v14l-5-4H4z"/><path class="wave" d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/><path class="x" d="M16 9l6 6M22 9l-6 6"/></svg></button>
      ${inRoom ? `<button class="btn ghost sm" data-act="leave">${isHost() ? 'Odayı kapat' : 'Odadan çık'}</button>` : ''}
    </nav>
  </header>`;
}

function inviteLink() {
  const code = S.room?.code || S.conn?.code;
  return `${location.origin}${location.pathname}?oda=${code}`;
}

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  if (act === 'home') { e.preventDefault(); if (!S.conn) showHome(); else if (S.view === 'match') showLobby(); return; }
  if (act === 'mute') { setMuted(!isMuted()); el.classList.toggle('muted', isMuted()); if (!isMuted()) play('notify'); }
  if (act === 'copy') {
    try { await navigator.clipboard.writeText(inviteLink()); toast('Davet linki kopyalandı'); }
    catch { toast(inviteLink()); }
  }
  if (act === 'copy-code') {
    try { await navigator.clipboard.writeText(S.room.code); toast('Oda kodu kopyalandı'); } catch { /* ignore */ }
  }
  if (act === 'leave') leaveRoom();
});

// ---- connection ----------------------------------------------------------------

function connect(conn, host) {
  S.conn?.close();
  S.conn = conn;
  S.room = null;
  S.known = new Set();
  S.status = 'connecting';
  showConnecting();
  conn.on('status', (st) => {
    S.status = st;
    document.querySelectorAll('.room-chip .dot').forEach((d) => { d.className = `dot ${st}`; });
  });
  conn.on('state', (room, at) => onRoom(room, at));
  conn.on('error', (text) => {
    toast(text, 'err');
    if (S.view === 'match') renderMatchState(true);
  });
  conn.on('fatal', (text) => {
    S.conn = null;
    S.room = null;
    store.set('sessionStorage', 'sahuno.session', null);
    history.replaceState(null, '', location.pathname);
    showHome(text);
  });
  store.set('sessionStorage', 'sahuno.session', JSON.stringify({ code: conn.code, host }));
}

function leaveRoom() {
  if (isHost() && S.room.members.filter((m) => m.online).length > 1 &&
      !confirm('Odayı kapatırsan herkes odadan çıkar. Emin misin?')) return;
  S.conn?.close();
  if (isHost()) forgetHostRoom();
  S.conn = null;
  S.room = null;
  store.set('sessionStorage', 'sahuno.session', null);
  history.replaceState(null, '', location.pathname);
  showHome();
}

function onRoom(room, at) {
  const first = !S.room;
  S.room = room;
  S.recvAt = at;
  if (first) history.replaceState(null, '', `?oda=${room.code}`);

  // Jump into new matches that involve me (and back into a running one after a reload)
  for (const m of room.matches) {
    if (S.known.has(m.id)) continue;
    S.known.add(m.id);
    if (m.status === 'playing' && colorOf(m, me.id)) {
      play('notify');
      showMatch(m.id);
      return;
    }
  }
  if (S.view === 'match') {
    const m = room.matches.find((x) => x.id === S.matchId);
    if (!m) { showLobby(); return; }
    if (m.rematchId && colorOf(m, me.id) && room.matches.some((x) => x.id === m.rematchId)) { showMatch(m.rematchId); return; }
    renderMatchState();
  } else if (S.view === 'lobby') renderLobbyState();
  else showLobby();
}

// ---- views: transitions ----------------------------------------------------------

let teardown = null;
function mount(html, view) {
  teardown?.();
  teardown = null;
  S.view = view;
  app.innerHTML = html;
  app.firstElementChild?.classList.add('enter');
  window.scrollTo({ top: 0 });
}

function showConnecting() {
  mount(`${header(true)}<main class="connecting"><div class="spinner"><i></i><i></i><i></i><i></i></div>
    <p>${S.conn?.isHost ? 'Oda açılıyor…' : 'Odaya bağlanılıyor…'}</p>
    <button class="btn ghost sm" data-act="leave">Vazgeç</button></main>`, 'connecting');
}

// ---- home ------------------------------------------------------------------------

const DEMO = ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'f8c5', 'c2c3', 'g8f6', 'd2d4', 'e5d4', 'c3d4', 'c5b4', 'b1c3', 'f6e4', 'e1g1', 'e4c3'];
const DEMO_CARDS = [
  { kind: 'num', n: 3, color: 'red' }, { kind: 'rev', color: 'blue' }, { kind: 'd2', n: 2, color: 'green' },
  { kind: 'skip', color: 'yellow' }, { kind: 'num', n: 1, color: 'blue' }, { kind: 'd4', n: 4, color: 'wild' },
  { kind: 'num', n: 2, color: 'yellow' }, { kind: 'num', n: 0, color: 'red' },
];

function showHome(error) {
  const params = new URLSearchParams(location.search);
  const code = normalizeCode(params.get('oda'));
  mount(`${header(false)}
  <main class="home">
    <section class="hero">
      <div class="hero-copy">
        <p class="eyebrow"><span class="pill">Yeni</span> Unolu satranç: her tur bir kart, her kart bir sürpriz</p>
        <h1>Satranç oyna.<br><em>Ya da kartlara bırak.</em></h1>
        <p class="lede">Bir oda kur, kodu arkadaşına gönder. Yönetici sensin: kim kiminle, hangi modda oynayacak, sen seçersin.</p>
        <form class="entry" autocomplete="off">
          <label class="field">
            <span>Kullanıcı adın</span>
            <input id="name" maxlength="20" placeholder="ör. Kuzey" value="${esc(me.name)}" required>
          </label>
          <div class="entry-actions">
            <button type="button" class="btn primary lg" id="create">Oda kur <span class="arrow">→</span></button>
            <span class="or">ya da</span>
            <div class="join">
              <input id="code" class="mono" maxlength="5" placeholder="KOD" value="${esc(code)}" aria-label="Oda kodu">
              <button type="button" class="btn lg" id="join">Katıl</button>
            </div>
          </div>
          <p class="form-err" role="alert">${error ? esc(error) : ''}</p>
        </form>
      </div>
      <div class="hero-art" aria-hidden="true">
        <div class="demo-board"></div>
        <div class="fan">
          <div class="fan-card c1">${cardHTML(DEMO_CARDS[0])}</div>
          <div class="fan-card c2">${cardHTML(DEMO_CARDS[1])}</div>
          <div class="fan-card c3">${cardHTML(DEMO_CARDS[2])}</div>
        </div>
      </div>
    </section>

    <section class="modes">
      <article class="mode-card classic">
        <div class="mode-head"><span class="num">01</span><h2>Klasik</h2></div>
        <p>Bildiğin satranç. Şah mat, pat, rok, geçerken alma, terfi, üç tekrar ve 50 hamle kuralı. İstersen süre kontrolüyle.</p>
        <div class="mode-pieces">${['wK', 'wQ', 'wR', 'wB', 'wN', 'wP'].map((p) => `<img src="assets/pieces/${p}.svg" alt="">`).join('')}</div>
      </article>
      <article class="mode-card uno">
        <div class="mode-head"><span class="num">02</span><h2>Unolu</h2></div>
        <p>Her turdan önce bir kart çekersin. Kart ne derse o olur. Şahını korumak artık şansa da bağlı: <b>şahı alınan kaybeder.</b></p>
        <ul class="rules">
          <li>${cardHTML({ kind: 'num', n: 3, color: 'red' }, 'xs')}<span><b>Sayı</b> Kaç gelirse o kadar hamle yaparsın.</span></li>
          <li>${cardHTML({ kind: 'rev', color: 'blue' }, 'xs')}<span><b>Yön değiştir</b> Taraflar yer değiştirir; artık rakibinin taşlarıyla oynarsın.</span></li>
          <li>${cardHTML({ kind: 'skip', color: 'yellow' }, 'xs')}<span><b>0 ya da Engel</b> Tur boş geçer, sıra rakibe geçer.</span></li>
          <li>${cardHTML({ kind: 'd4', n: 4, color: 'wild' }, 'xs')}<span><b>+2 / +4</b> Yenen taşlarından 2 ya da 4 tanesini kendi yarına geri koyarsın.</span></li>
        </ul>
      </article>
    </section>

    <section class="how">
      <h3>Nasıl çalışır?</h3>
      <ol>
        <li><b>Oda kur.</b> Kullanıcı adınla gir, sana beş harfli bir oda kodu verilir.</li>
        <li><b>Kodu paylaş.</b> Arkadaşların kodu girer ya da davet linkine tıklar.</li>
        <li><b>Eşleştir.</b> Yönetici olarak kimin kiminle hangi modda oynayacağını seçersin; kendini de.</li>
      </ol>
      <p class="note">Sunucu yok: oyun doğrudan tarayıcılar arasında (WebRTC) akar. Oda, yöneticisinin sekmesi açık kaldıkça yaşar.</p>
    </section>
  </main>
  <footer class="foot"><span>rok. · açık kaynak</span><span>Taş çizimleri: Colin M.L. Burnett (CC BY-SA 3.0)</span></footer>`, 'home');

  const nameEl = $('#name'), codeEl = $('#code'), errEl = $('.form-err');
  const validName = () => {
    const n = nameEl.value.trim();
    if (n.length < 2) { errEl.textContent = 'Kullanıcı adın en az 2 karakter olmalı.'; nameEl.focus(); return null; }
    me.name = n;
    store.set('localStorage', 'sahuno.name', n);
    return n;
  };
  codeEl.addEventListener('input', () => { codeEl.value = normalizeCode(codeEl.value); });
  $('#create').onclick = () => {
    if (!validName()) return;
    connect(new HostConnection({ clientId: me.id, name: me.name }), true);
  };
  const join = () => {
    if (!validName()) return;
    const c = normalizeCode(codeEl.value);
    if (c.length !== 5) { errEl.textContent = 'Oda kodu 5 karakterden oluşur.'; codeEl.focus(); return; }
    connect(new GuestConnection({ clientId: me.id, name: me.name, code: c }), false);
  };
  $('#join').onclick = join;
  codeEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); join(); } });
  nameEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); codeEl.value.length === 5 ? join() : $('#create').click(); }
  });
  if (code && !me.name) nameEl.focus();
  else if (code) $('#join').focus();

  teardown = startDemo($('.demo-board'), $('.fan'));
}

function startDemo(root, fan) {
  const board = new BoardView(root);
  let s = initialState();
  let i = 0;
  let cardI = 0;
  board.set({ board: s.board, orientation: 'w', lastMove: null });
  const timer = setInterval(() => {
    if (i >= DEMO.length) {
      s = initialState();
      i = 0;
      board.set({ board: s.board, orientation: 'w', lastMove: null });
      return;
    }
    const u = DEMO[i++];
    const from = sqIndex(u.slice(0, 2)), to = sqIndex(u.slice(2, 4));
    const mv = legalMoves(s).find((m) => m.from === from && m.to === to);
    if (!mv) return;
    const next = applyMove(s, mv).state;
    next.turn = other(s.turn);
    s = next;
    board.set({ board: s.board, orientation: 'w', lastMove: { from, to } });
    if (i % 2 === 0) {
      cardI = (cardI + 1) % DEMO_CARDS.length;
      const top = fan.querySelector('.c3');
      top.innerHTML = cardHTML(DEMO_CARDS[cardI]);
      top.classList.remove('deal');
      void top.offsetWidth;
      top.classList.add('deal');
    }
  }, 1300);
  return () => { clearInterval(timer); board.destroy(); };
}

// ---- lobby ------------------------------------------------------------------------

function showLobby() {
  S.view = 'lobby';
  S.matchId = null;
  mount(`${header(true)}
  <main class="lobby">
    <aside class="side">
      <section class="panel members">
        <div class="panel-head"><h3>Oyuncular</h3><span class="count"></span></div>
        <ul class="member-list"></ul>
      </section>
      <section class="panel chat">
        <div class="panel-head"><h3>Sohbet</h3></div>
        <div class="msgs"></div>
        <form class="chat-form"><input maxlength="300" placeholder="Bir şey yaz…"><button class="btn sm">Gönder</button></form>
      </section>
    </aside>
    <div class="lobby-main">
      <section class="invite"></section>
      <section class="pairing"></section>
      <section class="matches">
        <div class="section-head"><h2>Maçlar</h2><span class="hint"></span></div>
        <div class="match-grid"></div>
      </section>
    </div>
  </main>`, 'lobby');

  $('.chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('.chat-form input');
    if (input.value.trim()) S.conn.send({ type: 'chat', text: input.value });
    input.value = '';
  });
  $('.lobby').addEventListener('click', onLobbyClick);
  S.lobbyCache = {};
  renderLobbyState();
}

function onLobbyClick(e) {
  const b = e.target.closest('[data-l]');
  if (!b) return;
  const f = S.form;
  const v = b.dataset.v;
  switch (b.dataset.l) {
    case 'pick':
      if (f.white === v) f.white = null;
      else if (f.black === v) f.black = null;
      else if (!f.white) f.white = v;
      else if (!f.black) f.black = v;
      else f.black = v;
      break;
    case 'seat': f[v] = null; break;
    case 'swap': [f.white, f.black] = [f.black, f.white]; break;
    case 'mode': f.mode = v; break;
    case 'time': f.time = v; break;
    case 'max': f.unoMax = +v; break;
    case 'random': f.random = !f.random; break;
    case 'start': {
      const t = TIMES.find((x) => x.id === f.time);
      S.conn.send({ type: 'create', white: f.white, black: f.black, mode: f.mode, time: { base: t.base, inc: t.inc }, unoMax: f.unoMax, randomColor: f.random });
      f.white = f.black = null;
      break;
    }
    case 'watch': showMatch(v); return;
    case 'abort': if (confirm('Bu maç berabere sayılıp sonlandırılsın mı?')) S.conn.send({ type: 'abort', matchId: v }); return;
    case 'dismiss': S.conn.send({ type: 'dismiss', matchId: v }); return;
    case 'kick': if (confirm(`${nameOf(v)} odadan çıkarılsın mı?`)) S.conn.send({ type: 'kick', clientId: v }); return;
    default: return;
  }
  renderPairing(true);
}

function busyIds() {
  const set = new Set();
  for (const m of S.room.matches) if (m.status === 'playing') { set.add(m.players.w); set.add(m.players.b); }
  return set;
}

function renderLobbyState() {
  const room = S.room;
  if (!room || S.view !== 'lobby') return;
  const busy = busyIds();
  const online = room.members.filter((m) => m.online);
  $('.members .count').textContent = online.length;

  // Members
  const list = $('.member-list');
  const sig = JSON.stringify([room.members, [...busy], room.hostId]);
  if (S.lobbyCache.members !== sig) {
    S.lobbyCache.members = sig;
    list.innerHTML = room.members.map((m) => `<li class="${m.online ? '' : 'offline'}">
      ${avatar(m.name)}
      <div class="who"><b>${esc(m.name)}</b>
        <small>${m.id === room.hostId ? '<span class="badge host">Yönetici</span>' : ''}${m.id === me.id ? '<span class="badge">Sen</span>' : ''}
        ${!m.online ? 'Bağlantı koptu' : busy.has(m.id) ? '<span class="live">Oynuyor</span>' : 'Boşta'}</small></div>
      ${isHost() && m.id !== me.id ? `<button class="icon kick" data-l="kick" data-v="${m.id}" title="Odadan çıkar">×</button>` : ''}
    </li>`).join('');
  }

  // Chat
  const msgs = $('.msgs');
  const last = room.chat[room.chat.length - 1];
  if (S.lobbyCache.chat !== (last?.id || '') ) {
    S.lobbyCache.chat = last?.id || '';
    const stick = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 40;
    msgs.innerHTML = room.chat.length
      ? room.chat.map((c) => c.system
        ? `<p class="sys">${esc(c.text)}</p>`
        : `<p class="${c.from === me.id ? 'mine' : ''}"><b>${esc(nameOf(c.from))}</b>${esc(c.text)}</p>`).join('')
      : '<p class="empty">Henüz mesaj yok.</p>';
    if (stick || last?.from === me.id) msgs.scrollTop = msgs.scrollHeight;
  }

  // Invite
  const alone = online.length < 2;
  const inv = $('.invite');
  if (S.lobbyCache.alone !== alone) {
    S.lobbyCache.alone = alone;
    inv.className = `invite ${alone ? 'big' : 'compact'}`;
    inv.innerHTML = `<div class="invite-copy">
        <p class="eyebrow">${alone ? 'Oda hazır' : 'Davet et'}</p>
        <h2>${alone ? 'Arkadaşına bu kodu gönder' : 'Daha fazla kişi mi? Kodu paylaş.'}</h2>
        ${alone ? '<p class="muted">Kod ile ya da davet linkiyle katılabilirler. Katılınca burada görünecekler.</p>' : ''}
      </div>
      <div class="code-tiles" data-act="copy-code" title="Kopyala">${[...room.code].map((ch, i) => `<span style="--i:${i}">${ch}</span>`).join('')}</div>
      <button class="btn ${alone ? 'primary' : 'ghost'} sm" data-act="copy">Davet linkini kopyala</button>`;
  }

  renderPairing();

  // Matches
  const grid = $('.match-grid');
  const matches = [...room.matches].sort((a, b) => (a.status === b.status ? b.createdAt - a.createdAt : a.status === 'playing' ? -1 : 1));
  const live = matches.filter((m) => m.status === 'playing').length;
  $('.matches .hint').textContent = live ? `${live} canlı` : '';
  const msig = matches.map((m) => m.id + ':' + m.seq).join('|') + JSON.stringify(room.members.map((m) => m.name));
  if (S.lobbyCache.matches !== msig) {
    S.lobbyCache.matches = msig;
    grid.innerHTML = '';
    if (!matches.length) {
      grid.innerHTML = `<div class="empty-matches"><div class="ghost-board">${'<i></i>'.repeat(16)}</div><p>${isHost() ? 'Henüz maç yok. Yukarıdan iki oyuncu seçip eşleştir.' : 'Henüz maç yok. Yönetici eşleştirmeyi yapınca maçlar burada görünecek.'}</p></div>`;
    }
    for (const m of matches) grid.append(matchCard(m));
  }
}

function matchCard(m) {
  const mine = colorOf(m, me.id);
  const el = document.createElement('article');
  el.className = `mcard ${m.status}`;
  const res = m.result
    ? m.result.winnerId ? `${esc(nameOf(m.result.winnerId))} kazandı` : 'Berabere'
    : '';
  const meta = m.mode === 'uno' ? `Unolu · 1–${m.unoMax}` : 'Klasik';
  const time = m.time ? ` · ${Math.round(m.time.base / 60000)}+${m.time.inc / 1000}` : '';
  el.innerHTML = `<div class="mcard-board"></div>
    <div class="mcard-body">
      <div class="mcard-top"><span class="mode-tag ${m.mode}">${meta}${time}</span>
        ${m.status === 'playing' ? '<span class="live-dot">Canlı</span>' : `<span class="done">${esc(m.result?.reason || 'Bitti')}</span>`}</div>
      <div class="vs">
        <span class="pl"><i class="chip w"></i>${esc(nameOf(m.players.w))}</span>
        <span class="pl"><i class="chip b"></i>${esc(nameOf(m.players.b))}</span>
      </div>
      ${res ? `<p class="res">${res}</p>` : ''}
      <div class="mcard-actions">
        <button class="btn ${mine && m.status === 'playing' ? 'primary' : ''} sm" data-l="watch" data-v="${m.id}">${mine && m.status === 'playing' ? 'Oyuna dön' : m.status === 'playing' ? 'İzle' : 'İncele'}</button>
        ${isHost() && m.status === 'playing' ? `<button class="btn ghost sm" data-l="abort" data-v="${m.id}">Sonlandır</button>` : ''}
        ${isHost() && m.status === 'over' ? `<button class="btn ghost sm" data-l="dismiss" data-v="${m.id}">Kaldır</button>` : ''}
      </div>
    </div>`;
  el.querySelector('.mcard-board').append(miniBoard(m.chess.board, mine || 'w'));
  return el;
}

function renderPairing(force) {
  const room = S.room;
  const el = $('.pairing');
  if (!el) return;
  if (!isHost()) {
    if (!el.dataset.guest) {
      el.dataset.guest = '1';
      el.className = 'pairing waiting';
      el.innerHTML = `<div class="wait-art">${cardBackHTML('sm tilt-a')}${cardBackHTML('sm tilt-b')}</div>
        <div><h3>Yönetici eşleştirmeyi yapıyor</h3><p class="muted">${esc(nameOf(room.hostId))} seni bir maça eklediğinde oyun ekranı kendiliğinden açılacak. Bu arada canlı maçları izleyebilirsin.</p></div>`;
    }
    return;
  }
  const f = S.form;
  const busy = busyIds();
  const idle = room.members.filter((m) => m.online && !busy.has(m.id));
  for (const k of ['white', 'black']) if (f[k] && !idle.some((m) => m.id === f[k])) f[k] = null;
  const sig = JSON.stringify([f, idle.map((m) => m.id + m.name)]);
  if (!force && el.dataset.sig === sig) return;
  el.dataset.sig = sig;
  el.className = 'pairing panel host';
  const seat = (k, c) => {
    const id = f[k];
    return `<button class="seat ${id ? 'filled' : ''}" data-l="seat" data-v="${k}">
      <i class="chip ${c}"></i>
      ${id ? `${avatar(nameOf(id), 'sm')}<b>${esc(nameOf(id))}</b><span class="x">×</span>` : `<span class="ph">${f.random ? 'Oyuncu' : COLOR_TR[c]} seç</span>`}
    </button>`;
  };
  const ready = f.white && f.black;
  el.innerHTML = `<div class="panel-head"><h3>Yeni eşleşme</h3><span class="muted sm">Oyunculara dokun, koltuklara otursunlar</span></div>
    <div class="pair-row">
      <div class="seats">${seat('white', 'w')}<button class="vs-btn" data-l="swap" title="Renkleri değiştir">vs</button>${seat('black', 'b')}</div>
      <div class="pool">${idle.length ? idle.map((m) => `<button class="pick ${f.white === m.id || f.black === m.id ? 'on' : ''}" data-l="pick" data-v="${m.id}">${avatar(m.name, 'sm')}${esc(m.name)}${m.id === me.id ? ' <small>(sen)</small>' : ''}</button>`).join('') : '<span class="muted sm">Boşta oyuncu yok.</span>'}</div>
    </div>
    <div class="opts">
      <div class="opt"><span class="lbl">Mod</span>
        <div class="seg mode-seg">
          <button class="${f.mode === 'normal' ? 'on' : ''}" data-l="mode" data-v="normal"><b>Klasik</b><small>Normal satranç</small></button>
          <button class="${f.mode === 'uno' ? 'on' : ''}" data-l="mode" data-v="uno"><b>Unolu</b><small>Kartla hamle</small></button>
        </div></div>
      <div class="opt"><span class="lbl">Süre</span>
        <div class="seg chips">${TIMES.map((t) => `<button class="${f.time === t.id ? 'on' : ''}" data-l="time" data-v="${t.id}">${t.label}</button>`).join('')}</div></div>
      ${f.mode === 'uno' ? `<div class="opt"><span class="lbl">Sayı kartları</span>
        <div class="seg chips">${[3, 5, 9].map((n) => `<button class="${f.unoMax === n ? 'on' : ''}" data-l="max" data-v="${n}">1 – ${n}</button>`).join('')}</div></div>` : ''}
      <div class="opt"><span class="lbl">Renkler</span>
        <button class="toggle ${f.random ? 'on' : ''}" data-l="random"><i></i>Rastgele dağıt</button></div>
    </div>
    <div class="pair-foot"><button class="btn primary" data-l="start" ${ready ? '' : 'disabled'}>Maçı başlat <span class="arrow">→</span></button></div>`;
}

// ---- match -------------------------------------------------------------------------

let board = null;
let clockTimer = null;

function showMatch(id) {
  const m = S.room.matches.find((x) => x.id === id);
  if (!m) return showLobby();
  S.matchId = id;
  S.reviveType = null;
  S.confirmResign = false;
  S.hideResult = false;
  S.seen[id] = { hist: m.history.length, cardSeq: m.uno?.cardSeq || 0, status: m.status, flash: false };
  mount(`${header(true)}
  <main class="game ${m.mode}">
    <div class="stage">
      <div class="pstrip top"></div>
      <div class="board-wrap"><div class="board-host"></div><div class="fx"></div><div class="result"></div></div>
      <div class="pstrip bottom"></div>
    </div>
    <aside class="gside">
      <button class="back" data-act="home">← Lobiye dön</button>
      <div class="turn"></div>
      ${m.mode === 'uno' ? `<div class="uno-zone">
        <div class="table">
          <button class="deck" title="Kart çek">${cardBackHTML('d3')}${cardBackHTML('d2')}${cardBackHTML('d1')}<span class="deck-count mono"></span></button>
          <div class="pile"></div>
        </div>
        <div class="uno-info"></div>
        <div class="revive-tray"></div>
      </div>` : ''}
      <div class="hist-wrap"><div class="panel-head"><h3>Hamleler</h3></div><div class="hist"></div></div>
      <div class="controls"></div>
    </aside>
  </main>`, 'match');

  board = new BoardView($('.board-host'), {
    onMove: (mv) => sendAct({ kind: 'move', ...mv }),
    onSquare: (sq) => {
      if (S.reviveType) sendAct({ kind: 'revive', t: S.reviveType, sq });
    },
  });
  $('.gside').addEventListener('click', onGameClick);
  $('.board-wrap').addEventListener('click', onGameClick);
  clockTimer = setInterval(tickClocks, 100);
  teardown = () => { clearInterval(clockTimer); board?.destroy(); board = null; };
  renderMatchState();
}

function sendAct(action) {
  S.conn.send({ type: 'act', matchId: S.matchId, action });
}

function onGameClick(e) {
  const b = e.target.closest('[data-g]');
  if (!b) return;
  const m = curMatch();
  switch (b.dataset.g) {
    case 'draw': sendAct({ kind: 'draw' }); break;
    case 'revive-type':
      S.reviveType = S.reviveType === b.dataset.v ? null : b.dataset.v;
      renderMatchState(true);
      break;
    case 'offer': sendAct({ kind: 'offerDraw' }); break;
    case 'decline': sendAct({ kind: 'declineDraw' }); break;
    case 'resign':
      if (!S.confirmResign) {
        S.confirmResign = true;
        renderControls(m);
        setTimeout(() => { S.confirmResign = false; if (curMatch()) renderControls(curMatch()); }, 3000);
      } else { S.confirmResign = false; sendAct({ kind: 'resign' }); }
      break;
    case 'rematch': sendAct({ kind: 'rematch' }); break;
    case 'hide-result': S.hideResult = true; renderResult(m); break;
    case 'show-result': S.hideResult = false; renderResult(m); break;
  }
}

$('#app').addEventListener('click', (e) => {
  if (e.target.closest('.deck') && S.view === 'match') {
    const m = curMatch();
    if (m && canDraw(m)) sendAct({ kind: 'draw' });
  }
});

const curMatch = () => S.room?.matches.find((x) => x.id === S.matchId);
const canDraw = (m) => m.status === 'playing' && m.uno?.phase === 'draw' && colorOf(m, me.id) === m.chess.turn;

function renderMatchState(resetBoard) {
  const m = curMatch();
  if (!m || !board) return;
  const my = colorOf(m, me.id);
  const myTurn = m.status === 'playing' && my === m.chess.turn;
  const seen = S.seen[m.id];

  // Moves available to me
  let moves = [];
  let dropTargets = null;
  if (myTurn) {
    if (m.mode === 'normal') moves = legalMoves(m.chess, my);
    else if (m.uno.phase === 'move') moves = pseudoMoves(m.chess, my);
    else if (m.uno.phase === 'revive') {
      if (S.reviveType && !m.captured[my].includes(S.reviveType)) S.reviveType = null;
      const types = [...new Set(m.captured[my])].filter((t) => reviveSquares(m.chess.board, my, t).length);
      if (!S.reviveType && types.length === 1) S.reviveType = types[0];
      dropTargets = S.reviveType ? reviveSquares(m.chess.board, my, S.reviveType) : [];
    }
  }
  if (!(myTurn && m.mode === 'uno' && m.uno.phase === 'revive')) S.reviveType = null;

  const checks = m.checks.map((c) => m.chess.board.findIndex((p) => p && p.t === 'k' && p.c === c));
  board.set({
    board: resetBoard ? m.chess.board.map((p) => p && { ...p }) : m.chess.board,
    orientation: my || 'w',
    lastMove: m.lastMove,
    checks,
    movable: moves.length ? my : null,
    moves,
    dropTargets,
  });
  $('.board-wrap').classList.toggle('my-turn', myTurn);
  $('.board-wrap').classList.toggle('dropping', !!dropTargets);

  // Effects for new events
  const fresh = m.history.slice(seen.hist);
  seen.hist = m.history.length;
  for (const ev of fresh) {
    if (ev.type === 'move') play(ev.san.includes('x') ? 'capture' : 'move');
    if (ev.type === 'revive') play('revive');
  }
  if (m.uno && m.uno.cardSeq !== seen.cardSeq) {
    seen.cardSeq = m.uno.cardSeq;
    const c = m.uno.card;
    play('card');
    setTimeout(() => cardEffect(m, c), 380);
    renderPile(m, true);
  } else if (m.uno) renderPile(m, false);
  if (m.checks.length && fresh.some((e) => e.type === 'move')) play('check');
  if (m.status === 'over' && seen.status !== 'over') { play('end'); S.hideResult = false; }
  seen.status = m.status;

  renderStrips(m);
  renderTurn(m);
  if (m.uno) renderUno(m);
  renderHistory(m);
  renderControls(m);
  renderResult(m);
  tickClocks();
}

function cardEffect(m, c) {
  const fx = $('.fx');
  if (!fx) return;
  const by = c.by;
  let big, small;
  switch (c.kind) {
    case 'num':
      big = c.n;
      small = c.n === 0 ? 'Tur boş geçti' : `${c.n === 1 ? 'tek' : c.n} hamle`;
      if (c.n === 0) play('skip');
      break;
    case 'skip': big = 'Engel'; small = 'Sıra rakibe geçti'; play('skip'); break;
    case 'rev': big = 'Yön değişti'; small = 'Taraflar yer değiştirdi'; play('reverse'); break;
    default: big = `+${c.n}`; small = m.captured[by]?.length || m.uno.phase === 'revive' ? 'taş canlandır' : 'canlandıracak taş yok';
  }
  fx.innerHTML = `<div class="burst ${c.color} k-${c.kind}"><b>${big}</b><span>${small}</span></div>`;
  fx.classList.remove('go');
  void fx.offsetWidth;
  fx.classList.add('go');
}

function stripHTML(m, color, pos) {
  const id = m.players[color];
  const mem = member(id);
  const capturedByMe = m.captured[other(color)] || [];
  const mat = (arr) => arr.reduce((s, t) => s + VALUE[t], 0);
  const diff = mat(m.captured[other(color)]) - mat(m.captured[color]);
  const order = { q: 0, r: 1, b: 2, n: 3, p: 4 };
  const caps = [...capturedByMe].sort((a, b) => order[a] - order[b]);
  const active = m.status === 'playing' && m.chess.turn === color;
  return `<div class="pinfo ${active ? 'active' : ''} ${pos}">
      ${avatar(mem?.name || '?')}
      <div class="pname"><b>${esc(mem?.name || 'Ayrıldı')}</b>
        <small><i class="chip ${color}"></i>${COLOR_TR[color]}${id === me.id ? ' · sen' : ''}${mem && !mem.online ? ' · <span class="warn">bağlantı koptu</span>' : ''}</small></div>
      <div class="caps">${caps.map((t) => `<img src="${pieceUrl(other(color), t)}" alt="">`).join('')}${diff > 0 ? `<span class="adv">+${diff}</span>` : ''}</div>
    </div>
    ${m.clock ? `<div class="clock mono ${active ? 'running' : ''}" data-c="${color}"></div>` : ''}`;
}

function renderStrips(m) {
  const bottom = colorOf(m, me.id) || 'w';
  const top = other(bottom);
  const t = $('.pstrip.top'), b = $('.pstrip.bottom');
  const ht = stripHTML(m, top, 'top'), hb = stripHTML(m, bottom, 'bottom');
  if (t.dataset.h !== ht) { t.innerHTML = ht; t.dataset.h = ht; }
  if (b.dataset.h !== hb) { b.innerHTML = hb; b.dataset.h = hb; }
}

function tickClocks() {
  const m = curMatch();
  if (!m || !m.clock) return;
  const elapsed = Date.now() - S.recvAt;
  document.querySelectorAll('.clock').forEach((el) => {
    const c = el.dataset.c;
    let ms = m.clock[c];
    if (m.clock.running === c && m.status === 'playing') ms -= elapsed;
    el.textContent = fmtClock(ms);
    el.classList.toggle('low', ms < 20_000);
  });
}

function renderTurn(m) {
  const my = colorOf(m, me.id);
  const turn = m.chess.turn;
  const mover = nameOf(m.players[turn]);
  let html;
  if (m.status === 'over') {
    html = `<span class="t-label">Maç bitti</span><b>${m.result.winnerId ? `${esc(nameOf(m.result.winnerId))} kazandı` : 'Berabere'}</b><small>${esc(m.result.reason)}</small>`;
  } else if (m.mode === 'normal') {
    html = my === turn
      ? `<span class="t-label you">Sıra sende</span><b>${COLOR_TR[turn]} oynuyor</b>${m.checks.includes(my) ? '<small class="warn">Şahın tehdit altında!</small>' : '<small>Taşını sürükle ya da tıkla</small>'}`
      : `<span class="t-label">Bekleniyor</span><b>${esc(mover)} düşünüyor</b><small>${COLOR_TR[turn]} hamle sırası</small>`;
  } else {
    const u = m.uno;
    const you = my === turn;
    const who = you ? 'Sen' : esc(mover);
    if (u.phase === 'draw') {
      html = you
        ? `<span class="t-label you">Sıra sende</span><b>Bir kart çek</b><small>Desteye dokun</small>`
        : `<span class="t-label">Bekleniyor</span><b>${who} kart çekiyor</b><small>${COLOR_TR[turn]} taşlar</small>`;
    } else if (u.phase === 'move') {
      html = `<span class="t-label ${you ? 'you' : ''}">${you ? 'Sıra sende' : COLOR_TR[turn]}</span><b>${who}: ${u.movesLeft} hamle kaldı</b>${you && m.checks.includes(my) ? '<small class="warn">Şahın tehdit altında!</small>' : `<small>${COLOR_TR[turn]} taşlar oynuyor</small>`}`;
    } else {
      html = `<span class="t-label ${you ? 'you' : ''}">${you ? 'Sıra sende' : COLOR_TR[turn]}</span><b>${who}: ${u.reviveLeft} taş canlandır</b><small>${you ? 'Taşı seç, kendi yarında boş bir kareye koy' : 'Taşlar geri dönüyor'}</small>`;
    }
  }
  const el = $('.turn');
  el.innerHTML = html;
  el.classList.toggle('mine', m.status === 'playing' && my === turn);
}

function renderPile(m, animate) {
  const pile = $('.pile');
  if (!pile) return;
  const c = m.uno.card;
  const key = m.uno.cardSeq;
  if (pile.dataset.k == key) return;
  pile.dataset.k = key;
  if (!c) { pile.innerHTML = '<div class="pile-empty">Kart yok</div>'; return; }
  const prev = pile.querySelector('.flip-card:last-child');
  const wrap = document.createElement('div');
  wrap.className = `flip-card ${animate ? 'draw-in' : ''}`;
  wrap.style.setProperty('--r', `${(key * 37) % 11 - 5}deg`);
  wrap.innerHTML = `<div class="flip-inner">${cardBackHTML('back-side')}${cardHTML(c, 'front-side')}</div>`;
  pile.querySelectorAll('.pile-empty').forEach((x) => x.remove());
  if (prev) prev.classList.add('under');
  pile.append(wrap);
  while (pile.children.length > 3) pile.firstElementChild.remove();
}

function renderUno(m) {
  const u = m.uno;
  const my = colorOf(m, me.id);
  const deck = $('.deck');
  deck.classList.toggle('ready', canDraw(m));
  deck.disabled = !canDraw(m);
  $('.deck-count').textContent = u.deckCount;

  const info = $('.uno-info');
  const c = u.card;
  let html = c ? `<p class="card-name">${esc(nameOf(m.players[c.by]) || '')} · <b>${cardLabel(c)}</b></p>` : '<p class="card-name muted">İlk kartı Beyaz çeker</p>';
  if (u.phase === 'move' && m.status === 'playing') {
    const total = c && c.kind === 'num' ? c.n : u.movesLeft;
    html += `<div class="pips">${Array.from({ length: total }, (_, i) => `<i class="${i < total - u.movesLeft ? 'used' : ''}"></i>`).join('')}</div>`;
  }
  if (u.swaps) html += `<p class="muted sm">Taraflar ${u.swaps} kez yer değiştirdi</p>`;
  info.innerHTML = html;

  const tray = $('.revive-tray');
  if (m.status === 'playing' && u.phase === 'revive' && my === m.chess.turn) {
    const counts = {};
    for (const t of m.captured[my]) counts[t] = (counts[t] || 0) + 1;
    tray.innerHTML = `<p class="lbl">Canlandırılacak taş</p><div class="tray">${Object.entries(counts)
      .sort((a, b) => VALUE[b[0]] - VALUE[a[0]])
      .map(([t, n]) => {
        const ok = reviveSquares(m.chess.board, my, t).length > 0;
        return `<button class="${S.reviveType === t ? 'on' : ''}" data-g="revive-type" data-v="${t}" ${ok ? '' : 'disabled'}><img src="${pieceUrl(my, t)}" alt="">${n > 1 ? `<small>×${n}</small>` : ''}</button>`;
      }).join('')}</div>`;
    tray.classList.add('show');
  } else {
    tray.classList.remove('show');
    tray.innerHTML = '';
  }
}

const PIECE_TR = { p: 'Piyon', n: 'At', b: 'Fil', r: 'Kale', q: 'Vezir', k: 'Şah' };

function renderHistory(m) {
  const el = $('.hist');
  if (el.dataset.n == m.history.length) return;
  el.dataset.n = m.history.length;
  let html = '';
  if (m.mode === 'normal') {
    const moves = m.history.filter((e) => e.type === 'move');
    html = '<ol class="pairs">';
    for (let i = 0; i < moves.length; i += 2) {
      html += `<li><span class="n">${i / 2 + 1}.</span><span>${esc(moves[i].san)}</span><span>${moves[i + 1] ? esc(moves[i + 1].san) : ''}</span></li>`;
    }
    html += '</ol>';
    if (!moves.length) html = '<p class="muted sm empty">İlk hamle Beyaz’ın.</p>';
  } else {
    const groups = [];
    for (const e of m.history) {
      if (e.type === 'card') groups.push({ card: e.card, color: e.color, items: [] });
      else if (e.type === 'swap') groups.push({ swap: true });
      else if (groups.length) groups[groups.length - 1].items.push(e);
    }
    html = groups.map((g) => g.swap
      ? '<div class="swap-row">⇄ Taraflar değişti</div>'
      : `<div class="turn-row"><span class="mini-card ${g.card.color}">${g.card.kind === 'num' ? g.card.n : g.card.kind === 'skip' ? '⊘' : g.card.kind === 'rev' ? '⇄' : '+' + g.card.n}</span>
        <i class="chip ${g.color}"></i>
        <span class="items">${g.items.length ? g.items.map((e) => e.type === 'move' ? `<span>${esc(e.san)}</span>` : `<span class="rv">+${PIECE_TR[e.t]} ${e.sq}</span>`).join('') : `<span class="muted">${g.card.kind === 'rev' ? '' : g.card.kind === 'num' && g.card.n > 0 ? '…' : 'pas'}</span>`}</span></div>`).join('');
    if (!groups.length) html = '<p class="muted sm empty">Beyaz ilk kartı çekecek.</p>';
  }
  el.innerHTML = html;
  el.scrollTop = el.scrollHeight;
}

function renderControls(m) {
  const el = $('.controls');
  const my = colorOf(m, me.id);
  if (!my) { el.innerHTML = '<p class="spectator"><span class="live-dot">İzliyorsun</span></p>'; return; }
  if (m.status === 'over') { el.innerHTML = ''; return; }
  const offerFromOpp = m.drawOffer && m.drawOffer !== my;
  el.innerHTML = `${offerFromOpp ? `<div class="offer"><span>Rakibin beraberlik teklif ediyor</span><button class="btn sm primary" data-g="offer">Kabul et</button><button class="btn sm ghost" data-g="decline">Reddet</button></div>` : ''}
    <div class="ctl-row">
      <button class="btn ghost sm" data-g="offer" ${m.drawOffer === my ? 'disabled' : ''}>${m.drawOffer === my ? 'Teklif gönderildi' : '½ Beraberlik teklif et'}</button>
      <button class="btn ghost sm danger ${S.confirmResign ? 'confirm' : ''}" data-g="resign">${S.confirmResign ? 'Emin misin? Tekrar bas' : '⚑ Terk et'}</button>
    </div>`;
}

function renderResult(m) {
  const el = $('.result');
  if (m.status !== 'over') { el.className = 'result'; el.innerHTML = ''; return; }
  const my = colorOf(m, me.id);
  const r = m.result;
  let title;
  if (!r.winnerId) title = 'Berabere.';
  else if (my) title = r.winnerId === me.id ? 'Kazandın.' : 'Kaybettin.';
  else title = `${esc(nameOf(r.winnerId))} kazandı.`;
  const mood = !r.winnerId ? 'draw' : r.winnerId === me.id ? 'win' : my ? 'loss' : 'draw';
  const myRe = my && m.rematch[my];
  const oppRe = my && m.rematch[other(my)];
  const sig = [title, r.reason, myRe, oppRe, S.hideResult].join('|');
  if (el.dataset.sig === sig) return;
  el.dataset.sig = sig;
  if (S.hideResult) {
    el.className = 'result peek';
    el.innerHTML = `<button class="btn sm" data-g="show-result">Sonucu göster</button>`;
    return;
  }
  el.className = `result show ${mood}`;
  el.innerHTML = `<div class="result-card">
    <p class="eyebrow">${esc(r.reason)}</p>
    <h2>${title}</h2>
    ${my ? `<p class="muted">${oppRe && !myRe ? 'Rakibin rövanş istiyor.' : myRe ? 'Rövanş isteği gönderildi…' : 'Renkler değişerek tekrar oynayabilirsiniz.'}</p>` : ''}
    <div class="result-actions">
      ${my ? `<button class="btn primary" data-g="rematch" ${myRe ? 'disabled' : ''}>${oppRe && !myRe ? 'Rövanşı kabul et' : 'Rövanş'}</button>` : ''}
      <button class="btn" data-act="home">Lobiye dön</button>
      <button class="btn ghost" data-g="hide-result">Tahtayı gör</button>
    </div></div>`;
}

// ---- boot --------------------------------------------------------------------------

function boot() {
  let session = null;
  try { session = JSON.parse(store.get('sessionStorage', 'sahuno.session')); } catch { /* ignore */ }
  if (session && me.name) {
    if (session.host) {
      const saved = savedHostRoom(me.id);
      if (saved) return connect(new HostConnection({ clientId: me.id, name: me.name, resume: saved }), true);
    } else if (session.code) {
      return connect(new GuestConnection({ clientId: me.id, name: me.name, code: session.code }), false);
    }
  }
  showHome();
}

if (!window.Peer) {
  app.innerHTML = '<main class="connecting"><p>Bağlantı kütüphanesi yüklenemedi. İnternet bağlantını kontrol edip sayfayı yenile.</p></main>';
} else boot();
