// Yarn chat — frontend. Change the name here and in index.html.
const APP_NAME = 'Yarn';

const $ = (s, el = document) => el.querySelector(s);
const S = {
  token: localStorage.getItem('chat_token'),
  me: JSON.parse(localStorage.getItem('chat_me') || 'null'),
  chats: [], chatsKey: '', serverNow: Date.now(),
  chatId: null, chat: null, members: [],
  lastId: 0, firstId: 0, noOlder: false, loadingOlder: false,
  readUpto: 0, seen: 0, ids: new Set(), tempN: 0,
};
const touch = matchMedia('(pointer: coarse)').matches;
const isPhone = () => matchMedia('(max-width: 760px)').matches;

/* ---------------- helpers ---------------- */
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
const COLORS = [['#6366F1','#8B5CF6'],['#0EA5E9','#2563EB'],['#10B981','#0D9488'],['#3B82F6','#06B6D4'],['#EC4899','#DB2777'],['#14B8A6','#0EA5E9'],['#8B5CF6','#D946EF'],['#22C55E','#0EA5E9']];
function avatarHTML(name, seed, cls = '') {
  const words = String(name || '?').replace(/[^\p{L}\p{N}\s]/gu, '').trim().split(/\s+/);
  const ini = ((words[0]?.[0] || '') + (words[1]?.[0] || '')).toUpperCase() || '?';
  let h = 0; for (const ch of String(seed || name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const c = COLORS[((h ^ (h >>> 5)) >>> 0) % COLORS.length];
  return `<span class="avatar ${cls}" style="background:linear-gradient(135deg,${c[0]},${c[1]})">${esc(ini)}</span>`;
}
const pad = (n) => String(n).padStart(2, '0');
const clock = (ts) => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
function dayLabel(ts) {
  const d = new Date(ts), t = new Date();
  const y = new Date(); y.setDate(t.getDate() - 1);
  if (d.toDateString() === t.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: d.getFullYear() === t.getFullYear() ? undefined : 'numeric' });
}
function listTime(ts) {
  const d = new Date(ts), t = new Date();
  if (d.toDateString() === t.toDateString()) return clock(ts);
  const l = dayLabel(ts); return l;
}
const isOnline = (seen) => seen && S.serverNow - seen < 2.5 * 60000;
function seenText(seen) {
  if (!seen) return '';
  if (isOnline(seen)) return 'online';
  return 'last seen ' + (dayLabel(seen) === 'Today' ? 'today at ' + clock(seen) : dayLabel(seen).toLowerCase() + ' at ' + clock(seen));
}
const TICK = '<svg class="tick" viewBox="0 0 18 12"><path d="M1 6.5l3.2 3.2L10 3.5M7.5 9.7L13.8 3.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const TICK1 = '<svg class="tick" viewBox="0 0 18 12"><path d="M4 6.5l3.2 3.2L13 3.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/* ---------------- auth ---------------- */
let authMode = 'login';
document.querySelectorAll('.tabs button').forEach((b) =>
  b.addEventListener('click', () => {
    authMode = b.dataset.tab;
    document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('on', x === b));
    $('#dnWrap').classList.toggle('hidden', authMode !== 'register');
    $('#authBtn').textContent = authMode === 'login' ? 'Log in' : 'Create account';
    $('#authTitle').textContent = authMode === 'login' ? 'Welcome back' : 'Create your account';
    $('#authSub').textContent = authMode === 'login' ? 'Log in to continue your chats.' : 'Pick a username. Friends find you with it.';
    $('#pw').autocomplete = authMode === 'login' ? 'current-password' : 'new-password';
    $('#authErr').textContent = '';
  })
);
$('#authForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#authBtn'); btn.disabled = true; $('#authErr').textContent = '';
  try {
    const d = await api(authMode, { body: { username: $('#un').value, password: $('#pw').value, display_name: $('#dn').value } });
    S.token = d.token; S.me = d.user;
    localStorage.setItem('chat_token', d.token); localStorage.setItem('chat_me', JSON.stringify(d.user));
    $('#pw').value = '';
    startApp();
  } catch (x) { $('#authErr').textContent = x.message; }
  btn.disabled = false;
});
function signOutLocal() {
  S.token = null; S.me = null;
  localStorage.removeItem('chat_token'); localStorage.removeItem('chat_me');
  clearTimeout(listTimer); clearTimeout(msgTimer);
  closeChat(false);
  $('#app').classList.add('hidden'); $('#auth').classList.remove('hidden');
}

/* ---------------- chat list ---------------- */
let listTimer = null;
async function loadChats() {
  clearTimeout(listTimer);
  try {
    const d = await api('chats');
    S.serverNow = d.now;
    const key = JSON.stringify(d.chats);
    if (key !== S.chatsKey) { S.chatsKey = key; S.chats = d.chats; renderChats(); }
  } catch (e) { /* keep quiet, retry */ }
  clearTimeout(listTimer);
  if (S.token) listTimer = setTimeout(loadChats, document.hidden ? 20000 : 4000);
}
function chatTitle(c) { return c.is_group ? c.name : c.other_name || 'Unknown'; }
function renderChats() {
  const q = $('#filter').value.trim().toLowerCase();
  const f = S.filter || 'all';
  const list = S.chats.filter((c) => (!q || chatTitle(c).toLowerCase().includes(q) || (c.other_username || '').includes(q)) && (f === 'all' || (f === 'unread' && c.unread) || (f === 'groups' && c.is_group)));
  const ul = $('#chatList');
  if (!S.chats.length) {
    ul.innerHTML = `<li class="list-empty"><strong>No chats yet</strong>Find a friend by their username and say hi.<br><button class="btn" id="emptyNew">Start a chat</button></li>`;
    $('#emptyNew').onclick = openNewChat;
  } else if (!list.length) {
    ul.innerHTML = `<li class="list-empty">${q ? 'No chats match your search.' : S.filter === 'unread' ? 'You are all caught up.' : 'No group chats yet. Tap the people icon to create one.'}</li>`;
  } else {
    ul.innerHTML = list.map((c) => {
      const name = chatTitle(c);
      let last = 'No messages yet';
      if (c.last_id) {
        const who = c.last_type === 'system' ? '' : c.last_sender === S.me.id ? 'You: ' : c.is_group ? (c.last_sender_name || '').split(' ')[0] + ': ' : '';
        last = who + (c.last_type === 'image' ? '📷 Photo' + (c.last_body ? ' · ' + c.last_body : '') : c.last_body);
      }
      const online = !c.is_group && isOnline(c.other_seen) ? 'online' : '';
      return `<li class="chat-item ${c.unread ? 'unread' : ''} ${c.id === S.chatId ? 'active' : ''}" data-id="${c.id}">
        ${avatarHTML(name, c.is_group ? 'g' + c.id : c.other_username, online)}
        <div class="ci-main">
          <div class="ci-top"><span class="ci-name">${esc(name)}</span><span class="ci-time">${listTime(c.last_msg_at)}</span></div>
          <div class="ci-bot"><span class="ci-last">${esc(last)}</span>${c.unread ? `<span class="badge">${c.unread > 99 ? '99+' : c.unread}</span>` : ''}</div>
        </div></li>`;
    }).join('');
  }
  const total = S.chats.reduce((a, c) => a + (c.unread || 0), 0);
  document.title = total ? `(${total}) ${APP_NAME}` : APP_NAME;
}
$('#chatList').addEventListener('click', (e) => {
  const li = e.target.closest('.chat-item'); if (li) openChat(+li.dataset.id);
});
$('#filter').addEventListener('input', renderChats);
$('#filters').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  S.filter = b.dataset.f;
  document.querySelectorAll('#filters button').forEach((x) => x.classList.toggle('on', x === b));
  renderChats();
});

/* ---------------- open / close a chat ---------------- */
let msgTimer = null;
async function openChat(id, push = true) {
  if (S.chatId === id) { if (isPhone()) document.body.classList.add('in-chat'); return; }
  clearTimeout(msgTimer); lastMarked = 0;
  S.chatId = id; S.chat = null; S.loaded = []; S.lastId = 0; S.firstId = 0; S.noOlder = false; S.ids = new Set(); S.readUpto = 0;
  const c = S.chats.find((x) => x.id === id);
  setHeader(c ? chatTitle(c) : '…', c ? (c.is_group ? 'g' + c.id : c.other_username) : '', '');
  $('#msgs').innerHTML = '';
  $('#empty').classList.add('hidden'); $('#chatView').classList.remove('hidden');
  document.body.classList.add('in-chat');
  if (push && isPhone() && window.top === window) { try { history.pushState({ chat: id }, ''); } catch {} }
  document.querySelectorAll('.chat-item').forEach((li) => li.classList.toggle('active', +li.dataset.id === id));
  if (!touch) $('#text').focus();
  try {
    const d = await api('chats/' + id);
    if (S.chatId !== id) return;
    S.chat = d.chat; S.members = d.members; S.serverNow = d.now;
    updateHeader();
  } catch (e) { toast(e.message); }
  await pollMessages(true);
}
function closeChat(back = true) {
  clearTimeout(msgTimer);
  S.chatId = null; S.chat = null;
  document.body.classList.remove('in-chat');
  $('#chatView').classList.add('hidden'); $('#empty').classList.remove('hidden');
  document.querySelectorAll('.chat-item.active').forEach((li) => li.classList.remove('active'));
  if (back && window.top === window && history.state && history.state.chat) { try { history.back(); } catch {} }
}
$('#backBtn').onclick = () => closeChat(true);
window.addEventListener('popstate', () => { if (S.chatId) closeChat(false); });

function setHeader(name, seed, sub, online) {
  $('#chatAvatar').outerHTML = avatarHTML(name, seed, online ? 'online' : '').replace('<span class="avatar', '<span id="chatAvatar" class="avatar');
  $('#chatName').textContent = name; $('#chatSub').textContent = sub; $('#chatSub').classList.toggle('on', sub === 'online');
}
function updateHeader() {
  if (!S.chat) return;
  if (S.chat.is_group) {
    const names = S.members.map((m) => (m.id === S.me.id ? 'You' : m.display_name.split(' ')[0]));
    setHeader(S.chat.name, 'g' + S.chat.id, names.join(', '));
  } else {
    const o = S.members.find((m) => m.id !== S.me.id) || {};
    const seen = Math.max(o.last_seen || 0, S.seen || 0);
    setHeader(o.display_name || 'Unknown', o.username, seenText(seen) || '@' + (o.username || ''), isOnline(seen));
  }
}

/* ---------------- messages ---------------- */
async function pollMessages(first = false) {
  clearTimeout(msgTimer);
  const id = S.chatId; if (!id) return;
  try {
    const d = await api(`chats/${id}/messages` + (S.lastId ? '?after=' + S.lastId : ''));
    if (S.chatId !== id) return;
    S.serverNow = d.now; S.readUpto = d.read_upto; S.seen = d.seen;
    if (first) {
      S.noOlder = d.messages.length < 50;
      renderAll(d.messages);
      scrollBottom();
    } else if (d.messages.length) {
      const near = nearBottom();
      appendMessages(d.messages);
      if (near) scrollBottom(true);
    }
    updateTicks();
    if (!S.chat?.is_group) updateHeader();
    markRead();
  } catch (e) { if (first) toast(e.message); }
  clearTimeout(msgTimer);
  if (S.chatId === id) msgTimer = setTimeout(pollMessages, document.hidden ? 10000 : 1500);
}
function nearBottom() { const m = $('#msgs'); return m.scrollHeight - m.scrollTop - m.clientHeight < 120; }
function scrollBottom(smooth) { const m = $('#msgs'); m.scrollTo({ top: m.scrollHeight, behavior: smooth ? 'smooth' : 'auto' }); }

function msgHTML(m, prev, extra = '') {
  if (m.type === 'system') return `<div class="sys" data-id="${m.id}">${esc(m.body)}</div>`;
  const mine = m.sender_id === S.me.id;
  const first = !prev || prev.sender_id !== m.sender_id || prev.type === 'system' || new Date(prev.created_at).toDateString() !== new Date(m.created_at).toDateString();
  const who = S.chat?.is_group && !mine && first ? `<div class="who" style="color:${colorFor(m.sender_name)}">${esc(m.sender_name)}</div>` : '';
  const img = m.type === 'image' ? `<span class="img" data-src="${m.media_url || '/api/media/' + m.media_key}"><img src="${m.media_url || '/api/media/' + m.media_key}" loading="lazy" alt="Photo"></span>` : '';
  const txt = m.body ? `<div class="txt">${linkify(m.body)}</div>` : '';
  const tick = mine ? (m.pending ? '<span>🕓</span>' : S.readUpto >= m.id ? TICK : TICK1) : '';
  const cls = ['m', mine && 'mine', first && 'first', mine && !m.pending && S.readUpto >= m.id && 'read', m.pending && 'pending', extra].filter(Boolean).join(' ');
  return `<div class="${cls}" ${m.pending ? `data-temp="${m.temp}"` : `data-id="${m.id}"`}>${who}${img}${txt}<div class="meta"><span>${clock(m.created_at)}</span>${tick}</div></div>`;
}
function colorFor(name) { let h = 0; for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return COLORS[h % COLORS.length][1]; }

let lastRendered = null; // previous message for grouping
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
  S.firstId = list.length ? list[0].id : 0;
  S.lastId = list.length ? list[list.length - 1].id : S.lastId;
  S.loaded = list;
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
  // keep any still-sending bubbles at the bottom
  box.querySelectorAll('[data-temp]').forEach((el) => box.appendChild(el));
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
  document.querySelectorAll('#msgs .m.mine[data-id]:not(.read)').forEach((el) => {
    if (+el.dataset.id <= S.readUpto) {
      el.classList.add('read');
      const t = el.querySelector('.tick'); if (t) t.outerHTML = TICK;
    }
  });
}
let lastMarked = 0;
function markRead() {
  if (document.hidden || !S.chatId || !S.lastId || S.lastId <= lastMarked) return;
  lastMarked = S.lastId;
  api(`chats/${S.chatId}/read`, { body: { last_id: S.lastId } }).catch(() => {});
  const c = S.chats.find((x) => x.id === S.chatId);
  if (c && c.unread) { c.unread = 0; renderChats(); }
}
$('#msgs').addEventListener('click', (e) => {
  const im = e.target.closest('.img');
  if (im) { $('#viewerImg').src = im.dataset.src; $('#viewer').classList.remove('hidden'); }
});
$('#viewer').onclick = () => $('#viewer').classList.add('hidden');

/* ---------------- sending ---------------- */
const ta = $('#text');
function autosize() { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 140) + 'px'; }
ta.addEventListener('input', () => { autosize(); $('#sendBtn').classList.toggle('ready', !!ta.value.trim()); });
ta.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !touch) { e.preventDefault(); $('#composer').requestSubmit(); }
});
$('#composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const body = ta.value.trim(); if (!body || !S.chatId) return;
  ta.value = ''; autosize(); $('#sendBtn').classList.remove('ready'); if (touch) ta.focus();
  send({ type: 'text', body });
});
async function send(payload, previewUrl) {
  const id = S.chatId, temp = ++S.tempN;
  const fake = { temp, pending: true, sender_id: S.me.id, type: payload.type, body: payload.type === 'image' ? payload.caption : payload.body, media_url: previewUrl, created_at: Date.now() };
  const box = $('#msgs');
  box.insertAdjacentHTML('beforeend', msgHTML(fake, lastRendered, 'pop'));
  scrollBottom(true);
  try {
    const d = await api(`chats/${id}/messages`, { body: payload.type === 'image' ? { type: 'image', data: payload.data, body: payload.caption } : payload });
    const el = box.querySelector(`[data-temp="${temp}"]`);
    if (S.chatId !== id) return;
    if (S.ids.has(d.message.id)) { el?.remove(); }
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

/* images: shrink on the phone before upload so it's fast */
$('#attachBtn').onclick = () => $('#fileIn').click();
$('#fileIn').addEventListener('change', async () => {
  const f = $('#fileIn').files[0]; $('#fileIn').value = '';
  if (!f) return;
  if (!f.type.startsWith('image/')) return toast('Pick a photo.');
  let data;
  try { data = await compress(f); } catch { return toast('Could not read that photo.'); }
  showModal(`<h2>Send photo</h2><img class="preview-img" src="${data}" alt="">
    <input class="field" id="cap" placeholder="Add a caption (optional)" maxlength="1000">
    <div class="row"><button class="btn ghost" data-close>Cancel</button><button class="btn" id="sendImg">Send</button></div>`);
  $('#sendImg').onclick = () => { const caption = $('#cap').value.trim(); hideModal(); send({ type: 'image', data, caption }, data); };
  $('#cap').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#sendImg').click(); });
});
async function compress(file) {
  const url = URL.createObjectURL(file);
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
  const max = 1280, s = Math.min(1, max / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
  const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(img, 0, 0, c.width, c.height);
  URL.revokeObjectURL(url);
  let q = 0.8, out = c.toDataURL('image/jpeg', q);
  while (out.length > 900000 && q > 0.35) { q -= 0.1; out = c.toDataURL('image/jpeg', q); }
  return out;
}

/* ---------------- modals ---------------- */
function showModal(html) { $('#sheet').innerHTML = html; $('#modal').classList.remove('hidden'); const f = $('#sheet input'); if (f && !touch) f.focus(); }
function hideModal() { $('#modal').classList.add('hidden'); $('#sheet').innerHTML = ''; }
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal' || e.target.closest('[data-close]')) hideModal(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { if (!$('#viewer').classList.contains('hidden')) $('#viewer').classList.add('hidden'); else hideModal(); }
});

// user search box used by several modals
function userSearch(inputEl, resultsEl, onPick) {
  let h;
  inputEl.addEventListener('input', () => {
    clearTimeout(h);
    const q = inputEl.value.trim().replace(/^@/, '');
    if (q.length < 2) { resultsEl.innerHTML = '<li class="hint">Type at least 2 letters of their username.</li>'; return; }
    h = setTimeout(async () => {
      try {
        const d = await api('users?q=' + encodeURIComponent(q));
        resultsEl.innerHTML = d.users.length
          ? d.users.map((u) => `<li data-u="${esc(u.username)}" data-n="${esc(u.display_name)}">${avatarHTML(u.display_name, u.username, 'sm')}<div><div class="nm">${esc(u.display_name)}</div><div class="un">@${esc(u.username)}</div></div></li>`).join('')
          : '<li class="hint">No one with that username.</li>';
      } catch (e) { resultsEl.innerHTML = `<li class="hint">${esc(e.message)}</li>`; }
    }, 250);
  });
  resultsEl.addEventListener('click', (e) => { const li = e.target.closest('li[data-u]'); if (li) onPick(li.dataset.u, li.dataset.n); });
  resultsEl.innerHTML = '<li class="hint">Type at least 2 letters of their username.</li>';
}

function openNewChat() {
  showModal(`<h2>New chat</h2><input class="field" id="us" placeholder="Search username" autocapitalize="none" spellcheck="false"><ul class="results" id="ur"></ul><button class="btn ghost" data-close>Cancel</button>`);
  userSearch($('#us'), $('#ur'), async (username) => {
    try { const d = await api('chats/direct', { body: { username } }); hideModal(); await loadChats(); openChat(d.id); }
    catch (e) { toast(e.message); }
  });
}
$('#newChatBtn').onclick = openNewChat;

$('#newGroupBtn').onclick = () => {
  const picked = new Map();
  showModal(`<h2>New group</h2>
    <input class="field" id="gn" placeholder="Group name" maxlength="50">
    <div class="chips" id="gc"></div>
    <input class="field" id="us" placeholder="Add people by username" autocapitalize="none" spellcheck="false">
    <ul class="results" id="ur"></ul>
    <div class="row"><button class="btn ghost" data-close>Cancel</button><button class="btn" id="gcreate">Create group</button></div>`);
  const drawChips = () => {
    $('#gc').innerHTML = [...picked].map(([u, n]) => `<span class="chip">${esc(n)}<button data-rm="${esc(u)}" aria-label="Remove">×</button></span>`).join('');
  };
  $('#gc').addEventListener('click', (e) => { const b = e.target.closest('[data-rm]'); if (b) { picked.delete(b.dataset.rm); drawChips(); } });
  userSearch($('#us'), $('#ur'), (u, n) => { picked.set(u, n); drawChips(); $('#us').value = ''; $('#ur').innerHTML = ''; $('#us').focus(); });
  $('#gcreate').onclick = async () => {
    const name = $('#gn').value.trim();
    if (!name) return toast('Give the group a name.');
    try { const d = await api('chats/group', { body: { name, usernames: [...picked.keys()] } }); hideModal(); await loadChats(); openChat(d.id); }
    catch (e) { toast(e.message); }
  };
};

$('#chatInfoBtn').onclick = () => {
  if (!S.chat) return;
  const list = S.members.map((m) => `<li style="cursor:default">${avatarHTML(m.display_name, m.username, 'sm' + (isOnline(m.last_seen) ? ' online' : ''))}<div><div class="nm">${esc(m.display_name)}${m.id === S.me.id ? ' (you)' : ''}</div><div class="un">@${esc(m.username)}</div></div></li>`).join('');
  if (!S.chat.is_group) {
    const o = S.members.find((m) => m.id !== S.me.id) || {};
    return showModal(`<div class="profile-top">${avatarHTML(o.display_name, o.username)}<h2>${esc(o.display_name || '')}</h2><p class="muted">@${esc(o.username || '')} · ${esc(seenText(Math.max(o.last_seen || 0, S.seen)))}</p></div><div class="row"><button class="btn ghost" data-close>Close</button></div>`);
  }
  showModal(`<div class="profile-top">${avatarHTML(S.chat.name, 'g' + S.chat.id)}<h2>${esc(S.chat.name)}</h2><p class="muted">Group · ${S.members.length} members</p></div>
    <ul class="results">${list}</ul>
    <input class="field" id="us" placeholder="Add someone by username" autocapitalize="none" spellcheck="false">
    <ul class="results" id="ur"></ul>
    <div class="row"><button class="btn danger" id="leave">Leave group</button><button class="btn ghost" data-close>Close</button></div>`);
  userSearch($('#us'), $('#ur'), async (username) => {
    try {
      await api(`chats/${S.chatId}/members`, { body: { username } });
      const d = await api('chats/' + S.chatId); S.members = d.members; updateHeader();
      hideModal(); toast('Added'); pollMessages();
    } catch (e) { toast(e.message); }
  });
  $('#leave').onclick = async () => {
    if (!confirm('Leave this group?')) return;
    try { await api(`chats/${S.chatId}/leave`, { body: {} }); hideModal(); closeChat(true); S.chatsKey = ''; loadChats(); }
    catch (e) { toast(e.message); }
  };
};

$('#meBtn').onclick = () => {
  showModal(`<div class="profile-top">${avatarHTML(S.me.display_name, S.me.username)}<h2>${esc(S.me.display_name)}</h2><p class="muted">@${esc(S.me.username)} · share this so friends can find you</p></div>
    <label style="display:block;margin-top:14px;font-weight:600;font-size:14px">Your name<input class="field" id="myName" value="${esc(S.me.display_name)}" maxlength="40"></label>
    <div class="row"><button class="btn" id="saveName">Save name</button></div>
    <div class="row"><button class="btn ghost" id="copyUn">Copy username</button><button class="btn danger" id="logout">Log out</button></div>`);
  $('#saveName').onclick = async () => {
    try { const d = await api('profile', { body: { display_name: $('#myName').value } }); S.me = d.user; localStorage.setItem('chat_me', JSON.stringify(d.user)); drawMe(); hideModal(); toast('Name saved'); }
    catch (e) { toast(e.message); }
  };
  $('#copyUn').onclick = () => { navigator.clipboard?.writeText('@' + S.me.username); toast('Username copied'); };
  $('#logout').onclick = async () => { hideModal(); try { await api('logout', { body: {} }); } catch {} signOutLocal(); };
};

/* ---------------- start ---------------- */
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && S.token) { loadChats(); if (S.chatId) pollMessages(); }
});
function drawMe() { $('#meBtn').innerHTML = avatarHTML(S.me.display_name, S.me.username, 'sm'); }
function startApp() {
  $('#auth').classList.add('hidden'); $('#app').classList.remove('hidden');
  drawMe();
  loadChats();
}
if (S.token && S.me) startApp(); else $('#auth').classList.remove('hidden');
