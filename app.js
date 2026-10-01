// Yarn chat — frontend. Change the app name here and in index.html.
const APP_NAME = 'Yarn';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};
const S = {
  token: LS.get('yarn_token', null), me: LS.get('yarn_me', null),
  prefs: Object.assign({ sound: true, popups: true }, LS.get('yarn_prefs', {})),
  tab: 'chats', filter: 'all', chats: [], chatsKey: '', serverNow: Date.now(), known: null,
  padis: [], vibes: { mine: [], feed: [] },
  chatId: null, chat: null, members: [], blockedByMe: false, blockedMe: false,
  lastId: 0, firstId: 0, noOlder: false, loadingOlder: false, loaded: [], ids: new Set(),
  readUpto: 0, seen: 0, since: 0, typing: [], replyTo: null, tempN: 0,
};
const touch = matchMedia('(pointer: coarse)').matches;
const isPhone = () => matchMedia('(max-width: 760px)').matches;

/* ================= helpers ================= */
async function api(path, opts = {}) {
  const res = await fetch('/api/' + path, {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    headers: { 'content-type': 'application/json', ...(S.token ? { authorization: 'Bearer ' + S.token } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch {}
  if (res.status === 401 && S.token && !path.startsWith('login')) { signOutLocal(); throw new Error('Please log in again.'); }
  if (!res.ok) throw new Error(data.error || 'Could not reach the server. Check your connection.');
  return data;
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const linkify = (s) => esc(s).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove('show'), 2600);
}
const COLORS = [['#6366F1', '#8B5CF6'], ['#0EA5E9', '#2563EB'], ['#10B981', '#0D9488'], ['#3B82F6', '#06B6D4'], ['#EC4899', '#DB2777'], ['#14B8A6', '#0EA5E9'], ['#8B5CF6', '#D946EF'], ['#22C55E', '#0EA5E9']];
function hashIdx(seed) { let h = 0; for (const ch of String(seed)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return ((h ^ (h >>> 5)) >>> 0) % COLORS.length; }
const media = (key) => '/api/media/' + key;
function avatarHTML(name, seed, cls = '', key = null) {
  if (key) return `<span class="avatar ${cls}" data-photo="${media(key)}"><img src="${media(key)}" alt="" loading="lazy"></span>`;
  const words = String(name || '?').replace(/[^\p{L}\p{N}\s]/gu, '').trim().split(/\s+/);
  const ini = ((words[0]?.[0] || '') + (words[1]?.[0] || '')).toUpperCase() || '?';
  const c = COLORS[hashIdx(seed || name)];
  return `<span class="avatar ${cls}" style="background:linear-gradient(135deg,${c[0]},${c[1]})">${esc(ini)}</span>`;
}
const colorFor = (name) => COLORS[hashIdx(name)][1];
const nameOf = (u) => (u && (u.nickname || u.display_name)) || 'Unknown';
const pad = (n) => String(n).padStart(2, '0');
const clock = (ts) => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
function dayLabel(ts) {
  const d = new Date(ts), t = new Date(), y = new Date(); y.setDate(t.getDate() - 1);
  if (d.toDateString() === t.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: d.getFullYear() === t.getFullYear() ? undefined : 'numeric' });
}
const listTime = (ts) => (new Date(ts).toDateString() === new Date().toDateString() ? clock(ts) : dayLabel(ts));
function ago(ts) {
  const s = Math.max(0, (S.serverNow || Date.now()) - ts) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  return Math.floor(s / 3600) + 'h ago';
}
const isOnline = (seen) => seen && S.serverNow - seen < 2.5 * 60000;
function seenText(seen) {
  if (!seen) return '';
  if (isOnline(seen)) return 'online';
  return 'last seen ' + (dayLabel(seen) === 'Today' ? 'today at ' + clock(seen) : dayLabel(seen).toLowerCase() + ' at ' + clock(seen));
}
const snippet = (type, body) => (type === 'image' ? '📷 Photo' + (body ? ' · ' + body : '') : type === 'deleted' ? '🚫 Deleted message' : body || '');
const TICK2 = '<svg class="tick" viewBox="0 0 18 12"><path d="M1 6.5l3.2 3.2L10 3.5M7.5 9.7L13.8 3.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const TICK1 = '<svg class="tick" viewBox="0 0 18 12"><path d="M4 6.5l3.2 3.2L13 3.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const VIBE_BGS = {
  g0: 'linear-gradient(135deg,#FF7A3D,#F0386B)', g1: 'linear-gradient(135deg,#6366F1,#8B5CF6)', g2: 'linear-gradient(135deg,#0EA5E9,#10B981)',
  g3: 'linear-gradient(135deg,#0F1B2D,#334155)', g4: 'linear-gradient(135deg,#F59E0B,#EF4444)', g5: 'linear-gradient(135deg,#EC4899,#8B5CF6)',
};

/* ================= sounds & alerts ================= */
let AC = null;
function ac() {
  if (!AC) { try { AC = new (window.AudioContext || window.webkitAudioContext)(); } catch { return null; } }
  if (AC.state === 'suspended') AC.resume();
  return AC;
}
document.addEventListener('pointerdown', ac, { passive: true });
function tone(notes, vol = 0.2, type = 'sine') {
  if (!S.prefs.sound) return;
  const a = ac(); if (!a) return;
  let t = a.currentTime + 0.01;
  for (const [f, d] of notes) {
    const o = a.createOscillator(), g = a.createGain();
    o.type = type; o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    o.connect(g).connect(a.destination); o.start(t); o.stop(t + d + 0.05);
    t += d * 0.55;
  }
}
const sounds = {
  bell: () => { tone([[1318, 0.5], [1760, 0.7]], 0.22, 'triangle'); },
  pop: () => tone([[740, 0.12]], 0.12),
  sent: () => tone([[520, 0.07], [780, 0.1]], 0.07),
};
function banner(title, text, avatar, onClick) {
  const n = $('#notif');
  n.innerHTML = `${avatar}<span class="nt"><strong>${esc(title)}</strong><span>${esc(text)}</span></span>`;
  n.onclick = () => { n.classList.remove('show'); onClick && onClick(); };
  n.classList.add('show');
  clearTimeout(banner.h); banner.h = setTimeout(() => n.classList.remove('show'), 4500);
}
function notifyMsg(c) {
  const title = c.is_group ? c.name : c.other_nick || c.other_name || 'New message';
  const who = c.is_group ? (c.last_sender_name || '').split(' ')[0] + ': ' : '';
  const text = who + snippet(c.last_type, c.last_body);
  sounds.bell();
  if (navigator.vibrate) try { navigator.vibrate(60); } catch {}
  if (document.hidden) {
    if ('Notification' in window && Notification.permission === 'granted') {
      try { const n = new Notification(title, { body: text, tag: 'yarn-' + c.id }); n.onclick = () => { window.focus(); openChat(c.id); n.close(); }; } catch {}
    }
  } else if (S.prefs.popups) {
    banner(title, text, c.is_group ? avatarHTML(c.name, 'g' + c.id, 'sm') : avatarHTML(title, c.other_username, 'sm', c.other_avatar), () => openChat(c.id));
  }
}

/* ================= auth ================= */
let authMode = 'login';
$$('.tabs button').forEach((b) => b.addEventListener('click', () => {
  authMode = b.dataset.tab;
  $$('.tabs button').forEach((x) => x.classList.toggle('on', x === b));
  $('#dnWrap').classList.toggle('hidden', authMode !== 'register');
  $('#authBtn').textContent = authMode === 'login' ? 'Log in' : 'Create account';
  $('#authTitle').textContent = authMode === 'login' ? 'Welcome back' : 'Create your account';
  $('#authSub').textContent = authMode === 'login' ? 'Log in to continue your chats.' : 'Pick a username. Friends find you with it.';
  $('#pw').autocomplete = authMode === 'login' ? 'current-password' : 'new-password';
  $('#authErr').textContent = '';
}));
$('#authForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#authBtn'); btn.disabled = true; $('#authErr').textContent = '';
  try {
    const d = await api(authMode, { body: { username: $('#un').value, password: $('#pw').value, display_name: $('#dn').value } });
    S.token = d.token; saveMe(d.user); LS.set('yarn_token', d.token);
    $('#pw').value = '';
    startApp();
  } catch (x) { $('#authErr').textContent = x.message; }
  btn.disabled = false;
});
function saveMe(u) { S.me = u; LS.set('yarn_me', u); drawMe(); }
function signOutLocal() {
  S.token = null; S.me = null; S.known = null; S.chats = []; S.chatsKey = '';
  LS.del('yarn_token'); LS.del('yarn_me');
  clearTimeout(listTimer); clearTimeout(msgTimer); clearInterval(vibeTimer);
  closeChat(false); hideModal();
  $('#app').classList.add('hidden'); $('#auth').classList.remove('hidden');
}

/* ================= tabs ================= */
const FAB_ICONS = {
  chats: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>',
  vibes: '<svg viewBox="0 0 24 24"><path d="M4 20l4-1 11-11-3-3L5 16z" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/></svg>',
  padis: '<svg viewBox="0 0 24 24"><circle cx="10" cy="8" r="3.4" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M4 19c.6-3.3 3-5 6-5 1.3 0 2.5.3 3.4 1M18 13v6M15 16h6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
};
function setTab(tab) {
  S.tab = tab;
  $$('#nav button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  $('#sideTitle').textContent = { chats: 'Chats', vibes: 'Vibes', padis: 'Padis' }[tab];
  $('#chatsView').classList.toggle('hidden', tab !== 'chats');
  $('#vibesView').classList.toggle('hidden', tab !== 'vibes');
  $('#padisView').classList.toggle('hidden', tab !== 'padis');
  $('#fab').innerHTML = FAB_ICONS[tab];
  $('#fab').setAttribute('aria-label', { chats: 'New chat', vibes: 'Post a vibe', padis: 'Add a padi' }[tab]);
  if (tab === 'vibes') { renderVibes(); loadVibes(); }
  if (tab === 'padis') { renderPadis(); loadPadis(); }
}
$('#nav').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setTab(b.dataset.tab); });
$('#fab').onclick = () => (S.tab === 'chats' ? openNewChat() : S.tab === 'vibes' ? openNewVibe() : openFindPadi());

/* ================= chat list ================= */
let listTimer = null;
async function loadChats() {
  clearTimeout(listTimer);
  try {
    const d = await api('chats');
    S.serverNow = d.now;
    const prev = S.known;
    S.known = new Map(d.chats.map((c) => [c.id, c.last_id || 0]));
    if (prev) {
      for (const c of d.chats) {
        const was = prev.get(c.id) || 0;
        if (c.last_id && c.last_id > was && c.last_sender !== S.me.id && !['system', 'deleted'].includes(c.last_type)) {
          if (!(c.id === S.chatId && !document.hidden)) notifyMsg(c);
        }
      }
    }
    const key = JSON.stringify(d.chats);
    if (key !== S.chatsKey) { S.chatsKey = key; S.chats = d.chats; renderChats(); }
  } catch (e) { /* retry quietly */ }
  clearTimeout(listTimer);
  if (S.token) listTimer = setTimeout(loadChats, document.hidden ? 8000 : 3500);
}
const chatTitle = (c) => (c.is_group ? c.name : c.other_nick || c.other_name || 'Unknown');
function renderChats() {
  const q = $('#filter').value.trim().toLowerCase();
  const f = S.filter;
  const list = S.chats.filter((c) =>
    (!q || chatTitle(c).toLowerCase().includes(q) || (c.other_username || '').includes(q)) &&
    (f === 'all' || (f === 'unread' && c.unread) || (f === 'groups' && c.is_group)));
  const ul = $('#chatList');
  if (!S.chats.length) {
    ul.innerHTML = `<li class="list-empty"><strong>No chats yet</strong>Find a friend by their exact username and say hi.<br><button class="btn" id="emptyNew">Start a chat</button></li>`;
    $('#emptyNew').onclick = openNewChat;
  } else if (!list.length) {
    ul.innerHTML = `<li class="list-empty">${q ? 'No chats match your search.' : f === 'unread' ? 'You are all caught up. 🎉' : 'No group chats yet. Tap the people icon at the top to create one.'}</li>`;
  } else {
    ul.innerHTML = list.map((c) => {
      const name = chatTitle(c);
      let last = 'Say hi 👋';
      if (c.last_id) {
        const who = ['system', 'deleted'].includes(c.last_type) ? '' : c.last_sender === S.me.id ? 'You: ' : c.is_group ? (c.last_sender_name || '').split(' ')[0] + ': ' : '';
        last = who + snippet(c.last_type, c.last_body);
      }
      const typing = c.typing ? (c.is_group ? 'someone is typing…' : 'typing…') : '';
      const online = !c.is_group && isOnline(c.other_seen) ? 'online' : '';
      return `<li class="chat-item ${c.unread ? 'unread' : ''} ${c.id === S.chatId ? 'active' : ''}" data-id="${c.id}">
        ${c.is_group ? avatarHTML(c.name, 'g' + c.id) : avatarHTML(name, c.other_username, online, c.other_avatar)}
        <div class="ci-main">
          <div class="ci-top"><span class="ci-name">${esc(name)}</span><span class="ci-time">${listTime(c.last_msg_at)}</span></div>
          <div class="ci-bot"><span class="ci-last ${typing ? 'typing-txt' : ''}">${esc(typing || last)}</span>${c.unread ? `<span class="badge">${c.unread > 99 ? '99+' : c.unread}</span>` : ''}</div>
        </div></li>`;
    }).join('');
  }
  const total = S.chats.reduce((a, c) => a + (c.unread || 0), 0);
  document.title = total ? `(${total}) ${APP_NAME}` : APP_NAME;
  const b = $('#chatsBadge'); b.textContent = total > 99 ? '99+' : total; b.classList.toggle('hidden', !total);
}
$('#chatList').addEventListener('click', (e) => { const li = e.target.closest('.chat-item'); if (li) openChat(+li.dataset.id); });
$('#filter').addEventListener('input', renderChats);
$('#filters').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  S.filter = b.dataset.f;
  $$('#filters button').forEach((x) => x.classList.toggle('on', x === b));
  renderChats();
});

/* ================= open / close chat ================= */
let msgTimer = null, lastMarked = 0;
async function openChat(id, push = true) {
  hideModal();
  if (S.chatId === id) { if (isPhone()) document.body.classList.add('in-chat'); return; }
  clearTimeout(msgTimer); lastMarked = 0;
  Object.assign(S, { chatId: id, chat: null, members: [], loaded: [], lastId: 0, firstId: 0, noOlder: false, ids: new Set(), readUpto: 0, since: 0, typing: [], seen: 0, blockedByMe: false, blockedMe: false });
  clearReply();
  const c = S.chats.find((x) => x.id === id);
  if (c) setHeader(chatTitle(c), c.is_group ? 'g' + c.id : c.other_username, '', false, c.is_group ? null : c.other_avatar);
  $('#msgs').innerHTML = '';
  $('#empty').classList.add('hidden'); $('#chatView').classList.remove('hidden');
  document.body.classList.add('in-chat');
  updateComposer();
  if (push && isPhone() && window.top === window) { try { history.pushState({ chat: id }, ''); } catch {} }
  $$('.chat-item').forEach((li) => li.classList.toggle('active', +li.dataset.id === id));
  if (!touch) $('#text').focus();
  await loadChatDetails();
  await pollMessages(true);
}
async function loadChatDetails() {
  const id = S.chatId;
  try {
    const d = await api('chats/' + id);
    if (S.chatId !== id) return;
    S.chat = d.chat; S.members = d.members; S.serverNow = d.now;
    S.blockedByMe = d.blocked_by_me; S.blockedMe = d.blocked_me;
    updateHeader(); updateComposer();
  } catch (e) { toast(e.message); }
}
function closeChat(back = true) {
  clearTimeout(msgTimer);
  S.chatId = null; S.chat = null;
  document.body.classList.remove('in-chat');
  $('#chatView').classList.add('hidden'); $('#empty').classList.remove('hidden');
  $$('.chat-item.active').forEach((li) => li.classList.remove('active'));
  if (back && window.top === window && history.state && history.state.chat) { try { history.back(); } catch {} }
}
$('#backBtn').onclick = () => closeChat(true);
window.addEventListener('popstate', () => { if (S.chatId) closeChat(false); });

const other = () => S.members.find((m) => m.id !== S.me.id) || {};
function setHeader(name, seed, sub, online, key) {
  $('#chatAvatar').outerHTML = avatarHTML(name, seed, online ? 'online' : '', key).replace('<span class="avatar', '<span id="chatAvatar" class="avatar');
  $('#chatName').textContent = name;
  $('#chatSub').textContent = sub;
  $('#chatSub').classList.toggle('on', sub === 'online' || /typing/.test(sub));
}
function updateHeader() {
  if (!S.chat) return;
  if (S.chat.is_group) {
    const sub = S.typing.length ? `${S.typing[0].split(' ')[0]} is typing…` : S.members.map((m) => (m.id === S.me.id ? 'You' : nameOf(m).split(' ')[0])).join(', ');
    setHeader(S.chat.name, 'g' + S.chat.id, sub);
  } else {
    const o = other();
    const seen = S.blockedMe ? 0 : Math.max(o.last_seen || 0, S.seen || 0);
    const sub = S.typing.length ? 'typing…' : seenText(seen) || 'tap here for info';
    setHeader(nameOf(o), o.username, sub, isOnline(seen), o.avatar_key);
  }
}
function updateComposer() {
  const bar = $('#blockedBar');
  let html = '';
  if (S.blockedByMe) html = `You blocked ${esc(nameOf(other()))}. <button id="unblockHere">Unblock</button>`;
  else if (S.blockedMe) html = `You can't reply to this conversation.`;
  bar.innerHTML = html;
  bar.classList.toggle('hidden', !html);
  $('#composer').classList.toggle('hidden', !!html);
  const ub = $('#unblockHere');
  if (ub) ub.onclick = async () => { try { await api('blocks/remove', { body: { user_id: other().id } }); S.blockedByMe = false; updateComposer(); toast('Unblocked'); } catch (e) { toast(e.message); } };
}

/* ================= messages ================= */
async function pollMessages(first = false) {
  clearTimeout(msgTimer);
  const id = S.chatId; if (!id) return;
  try {
    const d = await api(`chats/${id}/messages?` + (S.lastId && !first ? `after=${S.lastId}&` : '') + `since=${S.since}`);
    if (S.chatId !== id) return;
    S.serverNow = d.now; S.since = d.now; S.readUpto = d.read_upto; S.seen = d.seen; S.typing = d.typing || [];
    if (first) {
      S.noOlder = d.messages.length < 50;
      renderAll(d.messages);
      scrollBottom();
    } else if (d.messages.length) {
      const near = nearBottom();
      const incoming = d.messages.some((m) => m.sender_id !== S.me.id && !S.ids.has(m.id) && m.type !== 'system');
      appendMessages(d.messages);
      if (incoming && !document.hidden) sounds.pop();
      if (near) scrollBottom(true);
    }
    (d.deleted || []).forEach(markDeleted);
    updateTicks(); updateHeader(); markRead();
  } catch (e) { if (first) toast(e.message); }
  clearTimeout(msgTimer);
  if (S.chatId === id) msgTimer = setTimeout(pollMessages, document.hidden ? 8000 : 1500);
}
const nearBottom = () => { const m = $('#msgs'); return m.scrollHeight - m.scrollTop - m.clientHeight < 140; };
const scrollBottom = (smooth) => { const m = $('#msgs'); m.scrollTo({ top: m.scrollHeight, behavior: smooth ? 'smooth' : 'auto' }); };

function msgHTML(m, prev, extra = '') {
  if (m.type === 'system') return `<div class="sys" data-id="${m.id}">${esc(m.body)}</div>`;
  const mine = m.sender_id === S.me.id;
  const first = !prev || prev.sender_id !== m.sender_id || prev.type === 'system' || new Date(prev.created_at).toDateString() !== new Date(m.created_at).toDateString();
  const who = S.chat?.is_group && !mine && first ? `<div class="who" style="color:${colorFor(m.sender_name)}">${esc(m.sender_name)}</div>` : '';
  if (m.type === 'deleted') {
    return `<div class="m deleted ${mine ? 'mine' : ''} ${first ? 'first' : ''}" data-id="${m.id}">${who}<div class="txt">🚫 ${mine ? 'You deleted this message' : 'This message was deleted'}</div><div class="meta"><span>${clock(m.created_at)}</span></div></div>`;
  }
  const quote = m.reply_to && m.reply_type ? `<div class="quote" data-jump="${m.reply_to}"><b>${esc(m.reply_sender === S.me.id ? 'You' : m.reply_name)}</b><span>${esc(snippet(m.reply_type, m.reply_body))}</span></div>` : '';
  const src = m.media_url || (m.media_key ? media(m.media_key) : '');
  const img = m.type === 'image' && src ? `<span class="img" data-src="${src}"><img src="${src}" loading="lazy" alt="Photo"></span>` : '';
  const txt = m.body ? `<div class="txt">${linkify(m.body)}</div>` : '';
  const read = mine && !m.pending && S.readUpto >= m.id;
  const tick = mine ? (m.pending ? '<span class="clock">🕓</span>' : read ? TICK2 : TICK1) : '';
  const cls = ['m', mine && 'mine', first && 'first', read && 'read', m.pending && 'pending', extra].filter(Boolean).join(' ');
  return `<div class="${cls}" ${m.pending ? `data-temp="${m.temp}"` : `data-id="${m.id}"`}>${who}${quote}${img}${txt}<div class="meta"><span>${clock(m.created_at)}</span>${tick}</div></div>`;
}
let lastRendered = null;
function renderAll(list) {
  S.ids = new Set(); lastRendered = null;
  let html = S.noOlder ? '' : '<button class="older" id="olderBtn">Load earlier messages</button>';
  let day = '';
  for (const m of list) {
    const d = dayLabel(m.created_at);
    if (d !== day) { html += `<div class="day">${d}</div>`; day = d; lastRendered = null; }
    html += msgHTML(m, lastRendered); lastRendered = m; S.ids.add(m.id);
  }
  $('#msgs').innerHTML = html;
  S.lastDay = day;
  S.loaded = list.slice();
  S.firstId = list.length ? list[0].id : 0;
  S.lastId = list.length ? list[list.length - 1].id : S.lastId;
  const ob = $('#olderBtn'); if (ob) ob.onclick = loadOlder;
}
function appendMessages(list) {
  const box = $('#msgs');
  for (const m of list) {
    S.lastId = Math.max(S.lastId, m.id);
    if (S.ids.has(m.id)) continue;
    S.ids.add(m.id);
    const d = dayLabel(m.created_at);
    if (d !== S.lastDay) { box.insertAdjacentHTML('beforeend', `<div class="day">${d}</div>`); S.lastDay = d; lastRendered = null; }
    box.insertAdjacentHTML('beforeend', msgHTML(m, lastRendered, 'pop'));
    lastRendered = m; S.loaded.push(m);
  }
  box.querySelectorAll('[data-temp]').forEach((el) => box.appendChild(el));
}
function markDeleted(id) {
  const i = S.loaded.findIndex((m) => m.id === id);
  if (i < 0) return;
  const m = S.loaded[i];
  if (m.type === 'deleted') return;
  Object.assign(m, { type: 'deleted', body: '', media_key: null, media_url: null });
  const el = $(`#msgs [data-id="${id}"]`);
  if (el) el.outerHTML = msgHTML(m, S.loaded[i - 1]);
  S.loaded.forEach((x) => { if (x.reply_to === id) x.reply_type = 'deleted'; });
  $$(`#msgs .quote[data-jump="${id}"] span`).forEach((s) => (s.textContent = '🚫 Deleted message'));
}
async function loadOlder() {
  if (S.loadingOlder || S.noOlder || !S.firstId) return;
  S.loadingOlder = true;
  const id = S.chatId, box = $('#msgs'), before = box.scrollHeight;
  try {
    const d = await api(`chats/${id}/messages?before=${S.firstId}`);
    if (S.chatId !== id) return;
    S.noOlder = d.messages.length < 50;
    renderAll([...d.messages, ...S.loaded]);
    box.scrollTop = box.scrollHeight - before;
  } catch (e) { toast(e.message); }
  S.loadingOlder = false;
}
$('#msgs').addEventListener('scroll', () => { if ($('#msgs').scrollTop < 40) loadOlder(); });
function updateTicks() {
  $$('#msgs .m.mine[data-id]:not(.read):not(.deleted)').forEach((el) => {
    if (+el.dataset.id <= S.readUpto) { el.classList.add('read'); const t = el.querySelector('.tick'); if (t) t.outerHTML = TICK2; }
  });
}
function markRead() {
  if (document.hidden || !S.chatId || !S.lastId || S.lastId <= lastMarked) return;
  lastMarked = S.lastId;
  api(`chats/${S.chatId}/read`, { body: { last_id: S.lastId } }).catch(() => {});
  const c = S.chats.find((x) => x.id === S.chatId);
  if (c && c.unread) { c.unread = 0; renderChats(); }
}

// tap photo → full screen; tap quote → jump to message
$('#msgs').addEventListener('click', (e) => {
  const im = e.target.closest('.img');
  if (im) return showPhoto(im.dataset.src);
  const q = e.target.closest('.quote');
  if (q) {
    const el = $(`#msgs [data-id="${q.dataset.jump}"]`);
    if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
    else toast('That message is further up. Scroll up to load it.');
  }
});
function showPhoto(src) { $('#viewerImg').src = src; $('#viewer').classList.remove('hidden'); }
$('#viewer').onclick = () => $('#viewer').classList.add('hidden');

// long-press (phone) or right-click (computer) a message → actions
let pressT = null;
$('#msgs').addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'touch') return;
  const el = e.target.closest('.m[data-id]'); if (!el) return;
  pressT = setTimeout(() => { pressT = null; if (navigator.vibrate) try { navigator.vibrate(20); } catch {} msgMenu(+el.dataset.id); }, 450);
});
['pointerup', 'pointercancel', 'pointermove'].forEach((ev) => $('#msgs').addEventListener(ev, (e) => {
  if (ev === 'pointermove' && Math.abs(e.movementX) + Math.abs(e.movementY) < 4) return;
  clearTimeout(pressT);
}));
$('#msgs').addEventListener('contextmenu', (e) => {
  const el = e.target.closest('.m[data-id]'); if (!el) return;
  e.preventDefault();
  if (!touch) msgMenu(+el.dataset.id);
});
$('#msgs').addEventListener('dblclick', (e) => { const el = e.target.closest('.m[data-id]'); if (el && !touch) startReply(+el.dataset.id); });
function msgMenu(id) {
  const m = S.loaded.find((x) => x.id === id);
  if (!m || m.type === 'deleted' || m.type === 'system') return;
  const mine = m.sender_id === S.me.id;
  const canSend = !S.blockedByMe && !S.blockedMe;
  showModal(`<div class="menu-preview">${esc(snippet(m.type, m.body)).slice(0, 160)}</div>
    <div class="menu">
      ${canSend ? '<button data-a="reply">↩️ Reply</button>' : ''}
      ${m.body ? '<button data-a="copy">📋 Copy text</button>' : ''}
      ${m.type === 'image' ? '<button data-a="view">🖼️ View photo</button>' : ''}
      ${mine ? '<button data-a="del" class="danger-txt">🗑️ Delete for everyone</button>' : ''}
    </div>`);
  $('#sheet .menu').onclick = async (e) => {
    const a = e.target.closest('button')?.dataset.a; if (!a) return;
    hideModal();
    if (a === 'reply') startReply(id);
    if (a === 'copy') { try { await navigator.clipboard.writeText(m.body); toast('Copied'); } catch { toast('Could not copy'); } }
    if (a === 'view') showPhoto(media(m.media_key));
    if (a === 'del') {
      if (!confirm('Delete this message for everyone?')) return;
      try { await api(`chats/${S.chatId}/messages/${id}/delete`, { body: {} }); markDeleted(id); setTimeout(loadChats, 200); }
      catch (err) { toast(err.message); }
    }
  };
}
function startReply(id) {
  const m = S.loaded.find((x) => x.id === id);
  if (!m || m.type === 'deleted' || m.type === 'system' || S.blockedByMe || S.blockedMe) return;
  S.replyTo = { id, name: m.sender_id === S.me.id ? 'You' : m.sender_name, type: m.type, body: m.body, sender_id: m.sender_id };
  $('#rbName').textContent = 'Replying to ' + S.replyTo.name;
  $('#rbSnip').textContent = snippet(m.type, m.body);
  $('#replyBar').classList.remove('hidden');
  $('#text').focus();
}
function clearReply() { S.replyTo = null; $('#replyBar').classList.add('hidden'); }
$('#rbClose').onclick = clearReply;

/* ================= sending ================= */
const ta = $('#text');
function autosize() { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 140) + 'px'; }
let typingSent = 0;
ta.addEventListener('input', () => {
  autosize();
  $('#sendBtn').classList.toggle('ready', !!ta.value.trim());
  if (ta.value.trim() && S.chatId && Date.now() - typingSent > 3500) {
    typingSent = Date.now();
    api(`chats/${S.chatId}/typing`, { body: {} }).catch(() => {});
  }
});
ta.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !touch) { e.preventDefault(); $('#composer').requestSubmit(); }
  if (e.key === 'Escape') clearReply();
});
$('#composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const body = ta.value.trim(); if (!body || !S.chatId) return;
  ta.value = ''; autosize(); $('#sendBtn').classList.remove('ready'); if (touch) ta.focus();
  send({ type: 'text', body });
});
async function send(payload, previewUrl) {
  const id = S.chatId, temp = ++S.tempN, reply = S.replyTo;
  clearReply(); typingSent = 0;
  const fake = {
    temp, pending: true, sender_id: S.me.id, type: payload.type, body: payload.body, media_url: previewUrl, created_at: Date.now(),
    reply_to: reply?.id, reply_type: reply?.type, reply_body: reply?.body, reply_sender: reply?.sender_id, reply_name: reply?.name,
  };
  const box = $('#msgs');
  box.insertAdjacentHTML('beforeend', msgHTML(fake, lastRendered, 'pop'));
  scrollBottom(true);
  try {
    const d = await api(`chats/${id}/messages`, { body: { ...payload, reply_to: reply?.id } });
    sounds.sent();
    const el = box.querySelector(`[data-temp="${temp}"]`);
    if (S.chatId !== id) return;
    if (S.ids.has(d.message.id)) el?.remove();
    else {
      S.ids.add(d.message.id); S.loaded.push(d.message);
      S.lastId = Math.max(S.lastId, d.message.id);
      const html = msgHTML(d.message, lastRendered); lastRendered = d.message;
      if (el) el.outerHTML = html; else box.insertAdjacentHTML('beforeend', html);
    }
    lastMarked = Math.max(lastMarked, d.message.id);
    setTimeout(loadChats, 300);
  } catch (e) {
    const el = box.querySelector(`[data-temp="${temp}"]`);
    if (el) { el.classList.add('failed'); el.querySelector('.meta span').textContent = 'Not sent'; }
    toast(e.message);
  }
}

/* ================= images ================= */
let fileMode = null;
function pickImage(mode) { fileMode = mode; $('#fileIn').value = ''; $('#fileIn').click(); }
$('#attachBtn').onclick = () => pickImage('chat');
$('#fileIn').addEventListener('change', async () => {
  const f = $('#fileIn').files[0]; if (!f) return;
  if (!f.type.startsWith('image/')) return toast('Pick a photo.');
  try {
    if (fileMode === 'avatar') return uploadAvatar(await compress(f, 480, true));
    const data = await compress(f, 1280);
    if (fileMode === 'vibe') return vibePhotoStep(data);
    showModal(`<h2>Send photo</h2><img class="preview-img" src="${data}" alt="">
      <input class="field" id="cap" placeholder="Add a caption (optional)" maxlength="1000">
      <div class="row"><button class="btn ghost" data-close>Cancel</button><button class="btn" id="sendImg">Send</button></div>`);
    $('#sendImg').onclick = () => { const caption = $('#cap').value.trim(); hideModal(); send({ type: 'image', data, body: caption }, data); };
    $('#cap').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#sendImg').click(); });
  } catch { toast('Could not read that photo.'); }
});
async function compress(file, max, square = false) {
  const url = URL.createObjectURL(file);
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
  const c = document.createElement('canvas'), ctx = c.getContext('2d');
  if (square) {
    const side = Math.min(img.width, img.height), out = Math.min(max, side);
    c.width = c.height = out;
    ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, out, out);
  } else {
    const s = Math.min(1, max / Math.max(img.width, img.height));
    c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
  }
  URL.revokeObjectURL(url);
  let q = 0.82, out = c.toDataURL('image/jpeg', q);
  while (out.length > (square ? 300000 : 900000) && q > 0.35) { q -= 0.1; out = c.toDataURL('image/jpeg', q); }
  return out;
}

/* ================= modal ================= */
function showModal(html, cls = '') {
  $('#sheet').className = 'sheet ' + cls;
  $('#sheet').innerHTML = html;
  $('#modal').classList.remove('hidden');
}
function hideModal() { $('#modal').classList.add('hidden'); $('#sheet').innerHTML = ''; }
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal' || e.target.closest('[data-close]')) hideModal(); });
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('#story').classList.contains('hidden')) closeStory();
  else if (!$('#viewer').classList.contains('hidden')) $('#viewer').classList.add('hidden');
  else hideModal();
});
// tap any profile photo in a sheet to view it big
$('#sheet').addEventListener('click', (e) => { const a = e.target.closest('.big-av .avatar[data-photo]'); if (a) showPhoto(a.dataset.photo); });

/* ================= find people (exact username only) ================= */
function userRow(u, right = '') {
  return `<div class="urow" data-uid="${u.id}">${avatarHTML(nameOf(u), u.username, 'sm', u.avatar_key)}
    <div class="ur-main"><strong>${esc(nameOf(u))}</strong><span>@${esc(u.username)}${u.about ? ' · ' + esc(u.about) : ''}</span></div>${right}</div>`;
}
function finder(host, actionsFor, placeholder = 'Type their full username') {
  host.innerHTML = `<form class="finder"><span class="at">@</span><input class="finder-in" placeholder="${placeholder}" autocapitalize="none" autocomplete="off" spellcheck="false"><button class="finder-go">Find</button></form><div class="finder-res"></div>`;
  const inp = $('.finder-in', host), res = $('.finder-res', host);
  $('.finder', host).addEventListener('submit', async (e) => {
    e.preventDefault();
    const u = inp.value.trim().replace(/^@/, '').toLowerCase();
    if (!u) return;
    res.innerHTML = '<p class="muted pad">Looking…</p>';
    try {
      const d = await api('users/find?u=' + encodeURIComponent(u));
      const acts = actionsFor(d.user);
      res.innerHTML = `<div class="ucard">${userRow(d.user)}<div class="uc-acts">${acts.map((a, i) => `<button class="btn sm ${a.cls || ''}" data-i="${i}" ${a.disabled ? 'disabled' : ''}>${a.label}</button>`).join('')}</div></div>`;
      $$('.uc-acts button', res).forEach((b) => (b.onclick = () => acts[+b.dataset.i].fn(d.user, b)));
      $('.urow', res).onclick = () => openProfile(d.user.id);
    } catch (x) { res.innerHTML = `<p class="muted pad">${esc(x.message)}</p>`; }
  });
  setTimeout(() => { if (!touch) inp.focus(); }, 50);
  return { input: inp, res };
}
async function openDirect(user) {
  try { const d = await api('chats/direct', { body: { user_id: user.id } }); hideModal(); await loadChats(); setTab('chats'); openChat(d.id); }
  catch (e) { toast(e.message); }
}
async function addPadi(user, btn) {
  try {
    await api('padis', { body: { user_id: user.id } });
    if (btn) { btn.textContent = 'Added ✓'; btn.disabled = true; }
    toast(`${nameOf(user)} is now your padi 🤝`);
    loadPadis(); loadVibes();
  } catch (e) { toast(e.message); }
}

function openNewChat() {
  showModal(`<h2>New chat</h2><p class="muted">Type the person's full username to find them.</p><div id="nf"></div>
    ${S.padis.length ? `<p class="sec">Your padis</p><div class="ulist" id="npl">${S.padis.map((u) => userRow(u)).join('')}</div>` : ''}
    <div class="row"><button class="btn ghost" data-close>Close</button></div>`);
  finder($('#nf'), (u) => [
    { label: 'Message', fn: openDirect },
    u.is_padi ? { label: 'Padi ✓', cls: 'ghost', disabled: true } : { label: 'Add to padis', cls: 'ghost', fn: addPadi },
  ]);
  const npl = $('#npl');
  if (npl) npl.onclick = (e) => { const r = e.target.closest('.urow'); if (r) openDirect({ id: +r.dataset.uid }); };
}
$('#newGroupBtn').onclick = () => {
  const picked = new Map();
  showModal(`<h2>New group</h2>
    <input class="field" id="gn" placeholder="Group name" maxlength="50">
    <div class="chips" id="gc"></div>
    <p class="sec">Add people</p><div id="gf"></div>
    ${S.padis.length ? `<p class="sec">From your padis</p><div class="ulist" id="gpl">${S.padis.map((u) => userRow(u, '<span class="pick">+</span>')).join('')}</div>` : ''}
    <div class="row"><button class="btn ghost" data-close>Cancel</button><button class="btn" id="gcreate">Create group</button></div>`);
  const draw = () => {
    $('#gc').innerHTML = [...picked.values()].map((u) => `<span class="chip">${esc(nameOf(u))}<button data-rm="${u.id}" aria-label="Remove">×</button></span>`).join('');
    $$('#gpl .urow').forEach((r) => r.classList.toggle('picked', picked.has(+r.dataset.uid)));
  };
  $('#gc').onclick = (e) => { const b = e.target.closest('[data-rm]'); if (b) { picked.delete(+b.dataset.rm); draw(); } };
  const f = finder($('#gf'), (u) => [{ label: 'Add', fn: (usr) => { picked.set(usr.id, usr); draw(); f.input.value = ''; f.res.innerHTML = ''; } }]);
  const gpl = $('#gpl');
  if (gpl) gpl.onclick = (e) => {
    const r = e.target.closest('.urow'); if (!r) return;
    const id = +r.dataset.uid, u = S.padis.find((x) => x.id === id);
    picked.has(id) ? picked.delete(id) : picked.set(id, u); draw();
  };
  $('#gcreate').onclick = async () => {
    const name = $('#gn').value.trim();
    if (!name) return toast('Give the group a name.');
    try { const d = await api('chats/group', { body: { name, user_ids: [...picked.keys()] } }); hideModal(); await loadChats(); setTab('chats'); openChat(d.id); }
    catch (e) { toast(e.message); }
  };
};

/* ================= profiles ================= */
async function openProfile(uid) {
  if (uid === S.me.id) return openSettings();
  showModal('<p class="muted pad">Loading…</p>');
  let u;
  try { u = (await api('users/' + uid)).user; } catch (e) { return showModal(`<p class="muted pad">${esc(e.message)}</p><div class="row"><button class="btn ghost" data-close>Close</button></div>`); }
  const seen = seenText(u.last_seen);
  showModal(`<div class="profile-top big-av">${avatarHTML(nameOf(u), u.username, '', u.avatar_key)}
      <h2>${esc(nameOf(u))}</h2>
      <p class="muted">@${esc(u.username)}${u.nickname ? ' · ' + esc(u.display_name) : ''}${seen ? ' · ' + seen : ''}</p>
      ${u.about ? `<p class="about">${esc(u.about)}</p>` : ''}
      ${u.is_padi ? `<p class="pill ${u.mutual ? 'ok' : ''}">${u.mutual ? '🤝 You are padis. You can see each other’s vibes.' : '⏳ Saved. You’ll see their vibes once they add you back.'}</p>` : ''}
    </div>
    <div class="menu">
      <button data-a="msg">💬 Message</button>
      ${u.is_padi ? '<button data-a="nick">✏️ Set a nickname</button><button data-a="unpadi">➖ Remove from padis</button>' : '<button data-a="padi">🤝 Add to padis</button>'}
      <button data-a="block" class="danger-txt">${u.blocked ? '✅ Unblock' : '⛔ Block'} ${esc(nameOf(u).split(' ')[0])}</button>
    </div>`);
  $('#sheet .menu').onclick = async (e) => {
    const a = e.target.closest('button')?.dataset.a; if (!a) return;
    try {
      if (a === 'msg') return openDirect(u);
      if (a === 'padi') { await addPadi(u); return openProfile(uid); }
      if (a === 'unpadi') { await api('padis/remove', { body: { user_id: uid } }); toast('Removed from padis'); loadPadis(); loadVibes(); return openProfile(uid); }
      if (a === 'nick') return nickSheet(u);
      if (a === 'block') {
        if (!u.blocked && !confirm(`Block ${nameOf(u)}? They won't be able to message you or see your vibes.`)) return;
        await api(u.blocked ? 'blocks/remove' : 'blocks', { body: { user_id: uid } });
        toast(u.blocked ? 'Unblocked' : 'Blocked');
        if (S.chat && !S.chat.is_group && other().id === uid) { S.blockedByMe = !u.blocked; updateComposer(); }
        loadVibes();
        return openProfile(uid);
      }
    } catch (x) { toast(x.message); }
  };
}
function nickSheet(u) {
  showModal(`<h2>Nickname for ${esc(u.display_name)}</h2><p class="muted">Only you see this name.</p>
    <input class="field" id="nk" maxlength="40" value="${esc(u.nickname || '')}" placeholder="${esc(u.display_name)}">
    <div class="row"><button class="btn ghost" id="nkBack">Back</button><button class="btn" id="nkSave">Save</button></div>`);
  $('#nkBack').onclick = () => openProfile(u.id);
  $('#nkSave').onclick = async () => {
    try { await api('padis', { body: { user_id: u.id, nickname: $('#nk').value } }); toast('Nickname saved'); S.chatsKey = ''; loadChats(); loadPadis(); openProfile(u.id); }
    catch (e) { toast(e.message); }
  };
}
$('#chatInfoBtn').onclick = () => {
  if (!S.chat) return;
  if (!S.chat.is_group) return openProfile(other().id);
  showModal(`<div class="profile-top">${avatarHTML(S.chat.name, 'g' + S.chat.id)}<h2>${esc(S.chat.name)}</h2><p class="muted">Group · ${S.members.length} members</p></div>
    <p class="sec">Members</p>
    <div class="ulist" id="gml">${S.members.map((m) => userRow(m, m.id === S.me.id ? '<span class="tag">You</span>' : isOnline(m.last_seen) ? '<span class="tag on">online</span>' : '')).join('')}</div>
    <p class="sec">Add someone</p><div id="gaf"></div>
    <div class="row"><button class="btn danger" id="leave">Leave group</button><button class="btn ghost" data-close>Close</button></div>`);
  $('#gml').onclick = (e) => { const r = e.target.closest('.urow'); if (r) openProfile(+r.dataset.uid); };
  finder($('#gaf'), () => [{ label: 'Add to group', fn: async (u) => {
    try {
      await api(`chats/${S.chatId}/members`, { body: { user_id: u.id } });
      await loadChatDetails(); hideModal(); toast('Added'); pollMessages();
    } catch (e) { toast(e.message); }
  } }]);
  $('#leave').onclick = async () => {
    if (!confirm('Leave this group?')) return;
    try { await api(`chats/${S.chatId}/leave`, { body: {} }); hideModal(); closeChat(true); S.chatsKey = ''; loadChats(); }
    catch (e) { toast(e.message); }
  };
};

/* ================= padis tab ================= */
async function loadPadis() {
  try { const d = await api('padis'); S.padis = d.padis; S.serverNow = d.now; if (S.tab === 'padis') renderPadis(); } catch {}
}
function renderPadis() {
  const host = $('#padisView');
  const mutual = S.padis.filter((u) => u.mutual).length;
  host.innerHTML = `<div class="pad-find"><p class="pad-hint">Add a padi with their exact username</p><div id="pf"></div></div>
    ${S.padis.length ? `<p class="sec">Your padis · ${S.padis.length}${mutual ? ` · ${mutual} mutual 🤝` : ''}</p>
    <div class="ulist big" id="pl">${S.padis.map((u) => userRow({ ...u, avatar_key: u.avatar_key },
      `<span class="tag ${u.mutual ? 'ok' : ''}">${u.mutual ? '🤝' : 'waiting'}</span>`).replace('class="avatar sm', `class="avatar sm ${isOnline(u.last_seen) ? 'online' : ''}`)).join('')}</div>`
    : `<div class="list-empty"><strong>No padis yet</strong>Padis are your saved people. When you both add each other, you can see each other's vibes.</div>`}`;
  finder($('#pf'), (u) => [
    u.is_padi ? { label: 'Padi ✓', cls: 'ghost', disabled: true } : { label: 'Add to padis', fn: addPadi },
    { label: 'Message', cls: 'ghost', fn: openDirect },
  ]);
  const pl = $('#pl');
  if (pl) pl.onclick = (e) => { const r = e.target.closest('.urow'); if (r) openProfile(+r.dataset.uid); };
}
function openFindPadi() { setTab('padis'); setTimeout(() => $('#pf .finder-in')?.focus(), 60); }

/* ================= vibes tab ================= */
let vibeTimer = null;
async function loadVibes() {
  try {
    const d = await api('vibes');
    S.vibes = { mine: d.mine, feed: d.feed }; S.serverNow = d.now;
    $('#vibesDot').classList.toggle('hidden', !d.feed.some((v) => !v.seen));
    if (S.tab === 'vibes') renderVibes();
  } catch {}
}
function vibeGroups() {
  const map = new Map();
  for (const v of S.vibes.feed) {
    if (!map.has(v.user_id)) map.set(v.user_id, { user: { id: v.user_id, username: v.username, display_name: v.display_name, nickname: v.nickname, avatar_key: v.avatar_key }, items: [] });
    map.get(v.user_id).items.push(v);
  }
  const groups = [...map.values()].map((g) => ({ ...g, unseen: g.items.some((v) => !v.seen), last: g.items[g.items.length - 1].created_at }));
  groups.sort((a, b) => b.last - a.last);
  return groups;
}
function ring(inner, state) { return `<span class="ring ${state}">${inner}</span>`; }
function renderVibes() {
  const host = $('#vibesView');
  const mine = S.vibes.mine;
  const groups = vibeGroups();
  const unseen = groups.filter((g) => g.unseen), seen = groups.filter((g) => !g.unseen);
  const row = (g) => `<div class="vrow" data-uid="${g.user.id}">${ring(avatarHTML(nameOf(g.user), g.user.username, 'sm', g.user.avatar_key), g.unseen ? '' : 'seen')}
      <div class="ur-main"><strong>${esc(nameOf(g.user))}</strong><span>${g.items.length > 1 ? g.items.length + ' updates · ' : ''}${ago(g.last)}</span></div></div>`;
  host.innerHTML = `
    <div class="vrow me" id="myVibe">${mine.length ? ring(avatarHTML(S.me.display_name, S.me.username, 'sm', S.me.avatar_key), 'mine') : `<span class="add-av">${avatarHTML(S.me.display_name, S.me.username, 'sm', S.me.avatar_key)}<i>+</i></span>`}
      <div class="ur-main"><strong>My vibe</strong><span>${mine.length ? `${mine.length} update${mine.length > 1 ? 's' : ''} · ${ago(mine[mine.length - 1].created_at)} · 👁 ${mine.reduce((a, v) => a + v.views, 0)}` : 'Tap to share what’s up'}</span></div>
      ${mine.length ? '<button class="icon add-more" id="addVibe" aria-label="Add another vibe">＋</button>' : ''}</div>
    ${unseen.length ? `<p class="sec">New</p>${unseen.map(row).join('')}` : ''}
    ${seen.length ? `<p class="sec">Seen</p>${seen.map(row).join('')}` : ''}
    ${!groups.length ? `<div class="list-empty"><strong>No vibes from padis yet</strong>You see vibes from people you've both added as padis.</div>` : ''}
    <p class="vibe-note">🔒 Only mutual padis can see your vibes. Vibes disappear after 24 hours.</p>`;
  $('#myVibe').onclick = (e) => {
    if (e.target.closest('#addVibe')) return openNewVibe();
    mine.length ? openStory([{ user: { ...S.me }, items: mine, mineGroup: true }], 0) : openNewVibe();
  };
  $$('.vrow[data-uid]', host).forEach((r) => (r.onclick = () => {
    const list = [...unseen, ...seen];
    openStory(list, list.findIndex((g) => g.user.id === +r.dataset.uid));
  }));
}
function openNewVibe() {
  let bg = 'g0';
  showModal(`<h2>Post a vibe</h2>
    <div class="vibe-compose" id="vc" style="background:${VIBE_BGS[bg]}"><textarea id="vt" maxlength="700" placeholder="What's the vibe today?"></textarea></div>
    <div class="swatches" id="sw">${Object.keys(VIBE_BGS).map((k) => `<button data-bg="${k}" class="${k === bg ? 'on' : ''}" style="background:${VIBE_BGS[k]}" aria-label="Colour"></button>`).join('')}</div>
    <div class="row"><button class="btn ghost" id="vPhoto">📷 Photo vibe</button><button class="btn" id="vPost">Post</button></div>`);
  $('#sw').onclick = (e) => {
    const b = e.target.closest('[data-bg]'); if (!b) return;
    bg = b.dataset.bg; $('#vc').style.background = VIBE_BGS[bg];
    $$('#sw button').forEach((x) => x.classList.toggle('on', x === b));
  };
  $('#vPhoto').onclick = () => pickImage('vibe');
  $('#vPost').onclick = async () => {
    const body = $('#vt').value.trim(); if (!body) return toast('Write something first.');
    try { await api('vibes', { body: { type: 'text', body, bg } }); hideModal(); toast('Vibe posted ✨'); await loadVibes(); setTab('vibes'); }
    catch (e) { toast(e.message); }
  };
  setTimeout(() => $('#vt')?.focus(), 60);
}
function vibePhotoStep(data) {
  showModal(`<h2>Photo vibe</h2><img class="preview-img" src="${data}" alt="">
    <input class="field" id="vcap" placeholder="Add a caption (optional)" maxlength="300">
    <div class="row"><button class="btn ghost" data-close>Cancel</button><button class="btn" id="vpPost">Post</button></div>`);
  $('#vpPost').onclick = async () => {
    const b = $('#vpPost'); b.disabled = true;
    try { await api('vibes', { body: { type: 'image', data, body: $('#vcap').value.trim() } }); hideModal(); toast('Vibe posted ✨'); await loadVibes(); setTab('vibes'); }
    catch (e) { toast(e.message); b.disabled = false; }
  };
}

/* ----- story viewer ----- */
const ST = { groups: [], gi: 0, i: 0, timer: null, start: 0, dur: 5000 };
function openStory(groups, gi) {
  if (gi < 0 || !groups.length) return;
  Object.assign(ST, { groups, gi, i: 0 });
  const g = groups[gi];
  if (!g.mineGroup) { const first = g.items.findIndex((v) => !v.seen); ST.i = first >= 0 ? first : 0; }
  $('#story').classList.remove('hidden');
  showVibe();
}
function closeStory() {
  clearTimeout(ST.timer);
  $('#story').classList.add('hidden');
  $('#stBody').innerHTML = '';
  loadVibes();
}
function showVibe() {
  clearTimeout(ST.timer);
  const g = ST.groups[ST.gi], v = g.items[ST.i];
  if (!v) return closeStory();
  $('#stBars').innerHTML = g.items.map((_, k) => `<i class="${k < ST.i ? 'done' : ''}"><b></b></i>`).join('');
  $('#stAv').innerHTML = avatarHTML(nameOf(g.user), g.user.username, 'sm', g.user.avatar_key);
  $('#stName').textContent = g.mineGroup ? 'My vibe' : nameOf(g.user);
  $('#stTime').textContent = ago(v.created_at);
  $('#stBody').innerHTML = v.type === 'image'
    ? `<img src="${media(v.media_key)}" alt="">${v.body ? `<p class="st-cap">${linkify(v.body)}</p>` : ''}`
    : `<div class="st-text" style="background:${VIBE_BGS[v.bg] || VIBE_BGS.g0}"><p>${linkify(v.body)}</p></div>`;
  $('#stFoot').innerHTML = g.mineGroup
    ? `<button id="stViews">👁 ${v.views} view${v.views === 1 ? '' : 's'}</button><button id="stDel">🗑️ Delete</button>`
    : `<button id="stReply">💬 Reply to ${esc(nameOf(g.user).split(' ')[0])}</button>`;
  if (!g.mineGroup && !v.seen) { v.seen = 1; api(`vibes/${v.id}/view`, { body: {} }).catch(() => {}); }
  ST.dur = v.type === 'image' ? 6000 : Math.min(9000, 4000 + (v.body || '').length * 35);
  const bar = $(`#stBars i:nth-child(${ST.i + 1}) b`);
  requestAnimationFrame(() => { bar.style.transition = `width ${ST.dur}ms linear`; bar.style.width = '100%'; });
  ST.timer = setTimeout(nextVibe, ST.dur);
  const sv = $('#stViews');
  if (sv) sv.onclick = () => showViewers(v);
  const sd = $('#stDel');
  if (sd) sd.onclick = async () => {
    clearTimeout(ST.timer);
    if (!confirm('Delete this vibe?')) return showVibe();
    try { await api(`vibes/${v.id}/delete`, { body: {} }); g.items.splice(ST.i, 1); toast('Vibe deleted'); g.items.length ? showVibe() : closeStory(); }
    catch (e) { toast(e.message); }
  };
  const sr = $('#stReply');
  if (sr) sr.onclick = () => { closeStory(); openDirect(g.user); };
}
function nextVibe() {
  const g = ST.groups[ST.gi];
  if (ST.i < g.items.length - 1) { ST.i++; return showVibe(); }
  if (ST.gi < ST.groups.length - 1) {
    ST.gi++; const ng = ST.groups[ST.gi];
    const first = ng.items.findIndex((v) => !v.seen); ST.i = first >= 0 ? first : 0;
    return showVibe();
  }
  closeStory();
}
function prevVibe() {
  if (ST.i > 0) { ST.i--; return showVibe(); }
  if (ST.gi > 0) { ST.gi--; ST.i = 0; return showVibe(); }
  showVibe();
}
$('#stNext').onclick = nextVibe;
$('#stPrev').onclick = prevVibe;
$('#stClose').onclick = closeStory;
async function showViewers(v) {
  clearTimeout(ST.timer);
  try {
    const d = await api(`vibes/${v.id}/viewers`);
    closeStory();
    showModal(`<h2>Viewed by ${d.viewers.length}</h2>
      ${d.viewers.length ? `<div class="ulist">${d.viewers.map((u) => userRow(u, `<span class="tag">${clock(u.viewed_at)}</span>`)).join('')}</div>` : '<p class="muted pad">No views yet.</p>'}
      <div class="row"><button class="btn ghost" data-close>Close</button></div>`);
  } catch (e) { toast(e.message); showVibe(); }
}

/* ================= settings ================= */
function drawMe() { if (S.me) $('#meBtn').innerHTML = avatarHTML(S.me.display_name, S.me.username, 'sm', S.me.avatar_key); }
$('#meBtn').onclick = () => openSettings();
function openSettings() {
  const me = S.me;
  const notifOk = 'Notification' in window && Notification.permission === 'granted';
  showModal(`<div class="profile-top big-av">
      <div class="av-edit">${avatarHTML(me.display_name, me.username, '', me.avatar_key)}<button id="avBtn" aria-label="Change photo">📷</button></div>
      <h2>${esc(me.display_name)}</h2><p class="muted">@${esc(me.username)}</p>
      ${me.avatar_key ? '<button class="linkbtn" id="avDel">Remove photo</button>' : ''}
    </div>

    <p class="sec">Profile</p>
    <label class="flabel">Name<input class="field" id="sName" maxlength="40" value="${esc(me.display_name)}"></label>
    <label class="flabel">About<input class="field" id="sAbout" maxlength="140" value="${esc(me.about)}" placeholder="e.g. Available · Building things 🚀"></label>
    <div class="row"><button class="btn ghost" id="copyUn">Copy username</button><button class="btn" id="sSave">Save profile</button></div>

    <p class="sec">Privacy</p>
    <div class="setting"><div><strong>Who sees my last seen</strong><span>Online status and last seen time</span></div></div>
    <div class="seg" id="sPriv">${[['everyone', 'Everyone'], ['padis', 'My padis'], ['nobody', 'Nobody']].map(([k, l]) => `<button data-v="${k}" class="${me.seen_privacy === k ? 'on' : ''}">${l}</button>`).join('')}</div>
    <div class="setting"><div><strong>Vibes</strong><span>Only mutual padis can see your vibes</span></div><span class="tag ok">On</span></div>

    <p class="sec">Notifications</p>
    <label class="setting"><div><strong>Pop-up alerts</strong><span>Show a banner for new messages</span></div><input type="checkbox" class="switch" id="sPop" ${S.prefs.popups ? 'checked' : ''}></label>
    <label class="setting"><div><strong>Sounds</strong><span>Bell for new messages, soft sounds in chats</span></div><input type="checkbox" class="switch" id="sSnd" ${S.prefs.sound ? 'checked' : ''}></label>
    ${'Notification' in window ? `<div class="setting"><div><strong>Alerts when Yarn is in the background</strong><span>${notifOk ? 'On for this device' : 'Needs your permission'}</span></div>${notifOk ? '<span class="tag ok">On</span>' : '<button class="btn sm" id="sNotif">Turn on</button>'}</div>` : ''}
    <button class="linkbtn" id="sTest">🔔 Test notification sound</button>

    <p class="sec">Security</p>
    <input class="field" type="password" id="pCur" placeholder="Current password" autocomplete="current-password">
    <input class="field" type="password" id="pNew" placeholder="New password (6+ characters)" autocomplete="new-password">
    <div class="row"><button class="btn ghost" id="pSave">Change password</button></div>

    <p class="sec">Blocked people</p>
    <div class="ulist" id="bl"><p class="muted pad">Loading…</p></div>

    <div class="row"><button class="btn danger" id="logout">Log out</button><button class="btn ghost" data-close>Close</button></div>`, 'tall');

  $('#avBtn').onclick = () => pickImage('avatar');
  const avDel = $('#avDel');
  if (avDel) avDel.onclick = async () => { try { const d = await api('profile/avatar', { body: { remove: true } }); saveMe(d.user); openSettings(); } catch (e) { toast(e.message); } };
  $('#copyUn').onclick = () => { navigator.clipboard?.writeText('@' + me.username).then(() => toast('Username copied'), () => toast('@' + me.username)); };
  $('#sSave').onclick = async () => {
    try { const d = await api('profile', { body: { display_name: $('#sName').value, about: $('#sAbout').value } }); saveMe(d.user); toast('Profile saved'); }
    catch (e) { toast(e.message); }
  };
  $('#sPriv').onclick = async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    try { const d = await api('profile', { body: { seen_privacy: b.dataset.v } }); saveMe(d.user); $$('#sPriv button').forEach((x) => x.classList.toggle('on', x === b)); toast('Privacy updated'); }
    catch (x) { toast(x.message); }
  };
  $('#sPop').onchange = (e) => { S.prefs.popups = e.target.checked; LS.set('yarn_prefs', S.prefs); };
  $('#sSnd').onchange = (e) => { S.prefs.sound = e.target.checked; LS.set('yarn_prefs', S.prefs); };
  $('#sTest').onclick = () => { const was = S.prefs.sound; S.prefs.sound = true; sounds.bell(); S.prefs.sound = was; banner('Yarn', 'This is how new messages will pop up 👋', avatarHTML('Yarn', 'yarn', 'sm'), null); };
  const sn = $('#sNotif');
  if (sn) sn.onclick = async () => {
    try { const p = await Notification.requestPermission(); toast(p === 'granted' ? 'Background alerts are on' : 'Permission was not given'); openSettings(); }
    catch { toast('This browser does not support it'); }
  };
  $('#pSave').onclick = async () => {
    try { await api('password', { body: { current: $('#pCur').value, next: $('#pNew').value } }); $('#pCur').value = $('#pNew').value = ''; toast('Password changed. Other devices were logged out.'); }
    catch (e) { toast(e.message); }
  };
  $('#logout').onclick = async () => { hideModal(); try { await api('logout', { body: {} }); } catch {} signOutLocal(); };
  api('blocks').then((d) => {
    const bl = $('#bl'); if (!bl) return;
    bl.innerHTML = d.users.length ? d.users.map((u) => userRow(u, `<button class="btn sm ghost" data-unb="${u.id}">Unblock</button>`)).join('') : '<p class="muted pad">No one. Nice.</p>';
    bl.onclick = async (e) => {
      const b = e.target.closest('[data-unb]'); if (!b) return;
      try { await api('blocks/remove', { body: { user_id: +b.dataset.unb } }); b.closest('.urow').remove(); toast('Unblocked'); } catch (x) { toast(x.message); }
    };
  }).catch(() => {});
}
async function uploadAvatar(data) {
  try { toast('Uploading photo…'); const d = await api('profile/avatar', { body: { data } }); saveMe(d.user); toast('Photo updated'); openSettings(); }
  catch (e) { toast(e.message); }
}

/* ================= start ================= */
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && S.token) { loadChats(); if (S.chatId) pollMessages(); }
});
async function startApp() {
  $('#auth').classList.add('hidden'); $('#app').classList.remove('hidden');
  drawMe(); setTab('chats');
  loadChats(); loadPadis(); loadVibes();
  clearInterval(vibeTimer); vibeTimer = setInterval(loadVibes, 30000);
  try { const d = await api('me'); saveMe(d.user); } catch {}
}
if (S.token && S.me) startApp(); else $('#auth').classList.remove('hidden');
