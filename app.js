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
  token: LS.get('yarn_t2', null), me: LS.get('yarn_me2', null),
  prefs: Object.assign({ sound: true, popups: true, theme: 'system' }, LS.get('yarn_prefs', {})),
  locked: false, hiddenAt: 0,
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
  if (!res.ok) { const e = new Error(data.error || 'Could not reach the server. Check your connection.'); e.data = data; throw e; }
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
const DAY_MS = 86400000;
const snippet = (type, body) => (type === 'image' ? '📷 Photo' + (body ? ' · ' + body : '') : type === 'deleted' ? '🚫 Deleted message' : body || '');
const TICK2 = '<svg class="tick" viewBox="0 0 18 12"><path d="M1 6.5l3.2 3.2L10 3.5M7.5 9.7L13.8 3.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const TICK1 = '<svg class="tick" viewBox="0 0 18 12"><path d="M4 6.5l3.2 3.2L13 3.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const VIBE_BGS = {
  g0: 'linear-gradient(135deg,#FF7A3D,#F0386B)', g1: 'linear-gradient(135deg,#6366F1,#8B5CF6)', g2: 'linear-gradient(135deg,#0EA5E9,#10B981)',
  g3: 'linear-gradient(135deg,#0F1B2D,#334155)', g4: 'linear-gradient(135deg,#F59E0B,#EF4444)', g5: 'linear-gradient(135deg,#EC4899,#8B5CF6)',
};

/* ================= end-to-end encryption ================= */
// Each person has a key pair made on their own device. Messages are locked with a fresh key,
// and that key is locked separately for each person in the chat. The server only sees scrambled data.
const TE = new TextEncoder(), TD = new TextDecoder();
function b64(buf) { const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); }
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const isEnv = (s) => typeof s === 'string' && s.startsWith('{"e2e"');
const ECDH = { name: 'ECDH', namedCurve: 'P-256' };
let KEYS = null;
const keyStore = {
  db: null,
  open() { return this.db || (this.db = new Promise((res, rej) => { const r = indexedDB.open('yarn-keys', 1); r.onupgradeneeded = () => r.result.createObjectStore('k'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); })); },
  async run(mode, fn) { const db = await this.open(); return new Promise((res, rej) => { const tx = db.transaction('k', mode); const q = fn(tx.objectStore('k')); tx.oncomplete = () => res(q && q.result); tx.onerror = () => rej(tx.error); }); },
  get(k) { return this.run('readonly', (st) => st.get(k)).catch(() => null); },
  set(k, v) { return this.run('readwrite', (st) => st.put(v, k)).catch(() => null); },
  del(k) { return this.run('readwrite', (st) => st.delete(k)).catch(() => null); },
};
async function deriveSecrets(username, password) {
  const base = await crypto.subtle.importKey('raw', TE.encode(password), 'PBKDF2', false, ['deriveBits']);
  const salt = TE.encode('yarn-e2e-v1|' + String(username).trim().toLowerCase().replace(/^@/, ''));
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 210000 }, base, 512));
  return { auth: b64(bits.slice(0, 32)), wrapKey: await crypto.subtle.importKey('raw', bits.slice(32), 'AES-GCM', false, ['encrypt', 'decrypt']) };
}
async function aesEncrypt(key, bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes));
  const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12); return out;
}
async function aesDecrypt(key, bytes) { return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, key, bytes.slice(12))); }
async function newIdentity(wrapKey) {
  const kp = await crypto.subtle.generateKey(ECDH, true, ['deriveBits']);
  const pub = JSON.stringify(await crypto.subtle.exportKey('jwk', kp.publicKey));
  const pk8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey));
  const priv = await crypto.subtle.importKey('pkcs8', pk8, ECDH, false, ['deriveBits']);
  return { pub, priv, sealed: b64(await aesEncrypt(wrapKey, pk8)) };
}
async function openSealed(sealed, wrapKey) {
  const pk8 = await aesDecrypt(wrapKey, unb64(sealed));
  return { pk8, priv: await crypto.subtle.importKey('pkcs8', pk8, ECDH, false, ['deriveBits']) };
}
const pairCache = new Map();
function pairKey(pubJwk) {
  if (!pairCache.has(pubJwk)) pairCache.set(pubJwk, (async () => {
    const pub = await crypto.subtle.importKey('jwk', JSON.parse(pubJwk), ECDH, false, []);
    const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: pub }, KEYS.priv, 256);
    const hk = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: TE.encode('yarn-pair-v1'), info: new Uint8Array(0) }, hk, { name: 'AES-KW', length: 256 }, false, ['wrapKey', 'unwrapKey']);
  })());
  return pairCache.get(pubJwk);
}
async function seal(recipients, text) {
  const ck = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const k = {};
  for (const r of recipients) if (r && r.public_key && !k[r.id]) k[r.id] = b64(await crypto.subtle.wrapKey('raw', ck, await pairKey(r.public_key), 'AES-KW'));
  const env = { e2e: 1, k };
  if (text) env.t = b64(await aesEncrypt(ck, TE.encode(text)));
  return { body: JSON.stringify(env), ck };
}
async function unseal(body, senderPub) {
  const env = JSON.parse(body);
  const w = env.k && env.k[S.me.id];
  if (!w || !senderPub || !KEYS) throw new Error('no key');
  const ck = await crypto.subtle.unwrapKey('raw', unb64(w), await pairKey(senderPub), 'AES-KW', { name: 'AES-GCM' }, false, ['decrypt']);
  return { text: env.t ? TD.decode(await aesDecrypt(ck, unb64(env.t))) : '', ck };
}
const canOpen = (body) => { if (!isEnv(body)) return true; try { const e = JSON.parse(body); return !!(e.k && e.k[S.me.id]); } catch { return false; } };
const LOCKED = '🔒 Encrypted message';
async function decryptMsg(m) {
  if (m._d) return m;
  m._d = true;
  if (m.type === 'system' || m.type === 'deleted') { m.text = m.body || ''; return m; }
  if (isEnv(m.body)) {
    try { const r = await unseal(m.body, m.sender_key); m.text = r.text; m.ck = r.ck; }
    catch { m.text = LOCKED; m.locked = true; }
  } else m.text = m.body || '';
  if (m.reply_to && m.reply_type) {
    if (m.reply_type === 'deleted') m.reply_text = '';
    else if (isEnv(m.reply_body)) { try { m.reply_text = (await unseal(m.reply_body, m.reply_sender_key)).text; } catch { m.reply_text = LOCKED; } }
    else m.reply_text = m.reply_body || '';
  }
  return m;
}
const decryptAll = (list) => Promise.all(list.map(decryptMsg));
const mediaURLs = new Map();
function mediaURL(key, ck) {
  if (!ck) return Promise.resolve(media(key));
  if (!mediaURLs.has(key)) mediaURLs.set(key, (async () => {
    const res = await fetch(media(key));
    if (!res.ok) throw new Error('missing');
    const plain = await aesDecrypt(ck, new Uint8Array(await res.arrayBuffer()));
    return URL.createObjectURL(new Blob([plain], { type: 'image/jpeg' }));
  })());
  return mediaURLs.get(key);
}
async function encryptImage(ck, dataUrl) { return b64(await aesEncrypt(ck, unb64(dataUrl.split(',')[1]))); }
async function safetyCode(a, b) {
  const [x, y] = [a, b].sort();
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', TE.encode(x + '|' + y)));
  const out = []; for (let i = 0; i < 16; i += 2) out.push(String(((h[i] << 8) | h[i + 1]) % 10000).padStart(4, '0'));
  return out.join(' ');
}
async function saveKeys(uid, priv, pub) { KEYS = { priv, pub }; pairCache.clear(); await keyStore.set('id-' + uid, { priv, pub }); }
// After logging in: unlock my key with my password, or make a new one
async function setupKeys(d, wrapKey) {
  if (d.enc_priv && d.user.public_key) {
    const { priv } = await openSealed(d.enc_priv, wrapKey);
    return saveKeys(d.user.id, priv, d.user.public_key);
  }
  const id = await newIdentity(wrapKey);
  const r = await api('keys', { body: { public_key: id.pub, enc_priv: id.sealed } });
  d.user = r.user;
  await saveKeys(d.user.id, id.priv, id.pub);
}
async function ensureKeys() {
  if (KEYS) return;
  const k = await keyStore.get('id-' + S.me.id);
  if (k && k.priv) { KEYS = k; return; }
  if (window.YARN_PREVIEW_KEY) { const pk = await window.YARN_PREVIEW_KEY; return saveKeys(S.me.id, pk.priv, pk.pub); }
  // This device doesn't have the key yet: ask for the password to unlock it
  await new Promise((resolve) => {
    S.modalLocked = true;
    showModal(`<div class="profile-top"><div class="big-emoji">🔐</div><h2>Unlock your messages</h2>
      <p class="muted">Your chats are end-to-end encrypted. Enter your password once to unlock them on this device.</p></div>
      <input class="field" type="password" id="ukPw" placeholder="Your password" autocomplete="current-password">
      <p class="err" id="ukErr"></p>
      <div class="row"><button class="btn ghost" id="ukOut">Log out</button><button class="btn" id="ukGo">Unlock</button></div>`);
    $('#ukOut').onclick = () => { S.modalLocked = false; hideModal(); signOutLocal(); };
    const go = async () => {
      const b = $('#ukGo'); b.disabled = true; b.textContent = 'Unlocking…'; $('#ukErr').textContent = '';
      try {
        const sec = await deriveSecrets(S.me.username, $('#ukPw').value);
        const d = await api('me');
        if (!d.enc_priv) { S.modalLocked = false; hideModal(); signOutLocal(); toast('Please log in again.'); return; }
        let opened;
        try { opened = await openSealed(d.enc_priv, sec.wrapKey); } catch { throw new Error('Wrong password. Try again.'); }
        await saveKeys(d.user.id, opened.priv, d.user.public_key);
        S.modalLocked = false; hideModal(); resolve();
      } catch (x) { $('#ukErr').textContent = x.message; b.disabled = false; b.textContent = 'Unlock'; }
    };
    $('#ukGo').onclick = go;
    $('#ukPw').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  });
}

/* ================= theme ================= */
const darkMQ = matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  const t = S.prefs.theme || 'system';
  const dark = t === 'dark' || (t === 'system' && darkMQ.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const meta = $('meta[name=theme-color]'); if (meta) meta.content = dark ? '#0B1220' : '#FFFFFF';
}
darkMQ.addEventListener ? darkMQ.addEventListener('change', applyTheme) : darkMQ.addListener(applyTheme);
applyTheme();

/* ================= PIN lock ================= */
const PIN = {
  key: () => 'yarn_pin_' + (S.me ? S.me.id : 0),
  get() { return LS.get(this.key(), null); },
  async hash(pin, salt) {
    const b = await crypto.subtle.importKey('raw', TE.encode(pin), 'PBKDF2', false, ['deriveBits']);
    return b64(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: TE.encode(salt), iterations: 60000 }, b, 256));
  },
  async set(pin) { const old = this.get(); const salt = b64(crypto.getRandomValues(new Uint8Array(16))); LS.set(this.key(), { salt, hash: await this.hash(pin, salt), after: old ? old.after : 60000 }); },
  async check(pin) { const p = this.get(); return !!p && (await this.hash(pin, p.salt)) === p.hash; },
  setAfter(ms) { const p = this.get(); if (p) { p.after = ms; LS.set(this.key(), p); } },
  clear() { LS.del(this.key()); },
};
let pinEntry = '', pinHandler = null, pinFails = 0, pinWaitUntil = 0, pinBusy = false;
function drawDots() { $$('#pinDots i').forEach((d, i) => d.classList.toggle('on', i < pinEntry.length)); }
function showPinPad({ title, cancel, handler }) {
  $('#lockMsg').textContent = title; $('#lockMsg').classList.remove('bad');
  pinEntry = ''; drawDots(); pinHandler = handler;
  $('#lockCancel').classList.toggle('hidden', !cancel);
  $('#lockForgot').classList.toggle('hidden', !!cancel);
  $('#lock').classList.remove('hidden');
}
function hidePinPad() { $('#lock').classList.add('hidden'); pinHandler = null; }
function pinMsg(t) { $('#lockMsg').textContent = t; $('#lockMsg').classList.add('bad'); }
async function pinKey(k) {
  if (pinBusy || !pinHandler) return;
  if (k === 'back') { pinEntry = pinEntry.slice(0, -1); return drawDots(); }
  if (!/^\d$/.test(k) || pinEntry.length >= 4) return;
  pinEntry += k; drawDots();
  if (pinEntry.length < 4) return;
  pinBusy = true;
  const ok = await pinHandler(pinEntry);
  pinBusy = false;
  if (ok === false) { const d = $('#pinDots'); d.classList.remove('shake'); void d.offsetWidth; d.classList.add('shake'); if (navigator.vibrate) try { navigator.vibrate(120); } catch {} }
  pinEntry = ''; drawDots();
}
$('#keypad').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) pinKey(b.dataset.k); });
document.addEventListener('keydown', (e) => {
  if ($('#lock').classList.contains('hidden')) return;
  if (/^\d$/.test(e.key)) pinKey(e.key);
  else if (e.key === 'Backspace') pinKey('back');
});
$('#lockCancel').onclick = () => { hidePinPad(); openSettings(); };
$('#lockForgot').onclick = () => {
  if (!confirm('Log out to reset your PIN? You can log back in with your password.')) return;
  PIN.clear(); S.locked = false; hidePinPad();
  disablePushOnThisDevice().then((endpoint) => api('logout', { body: { endpoint } }).catch(() => {})).finally(signOutLocal);
};
function lockApp() {
  if (!PIN.get() || S.locked) return;
  S.locked = true;
  $('#notif').classList.remove('show');
  showPinPad({ title: 'Enter your PIN', handler: async (pin) => {
    if (Date.now() < pinWaitUntil) { pinMsg(`Too many tries. Wait ${Math.ceil((pinWaitUntil - Date.now()) / 1000)}s.`); return false; }
    if (await PIN.check(pin)) { pinFails = 0; S.locked = false; hidePinPad(); return true; }
    pinFails++;
    if (pinFails >= 5) { pinWaitUntil = Date.now() + 30000; pinFails = 0; pinMsg('Too many tries. Wait 30 seconds.'); }
    else pinMsg(`Wrong PIN. ${5 - pinFails} ${5 - pinFails === 1 ? 'try' : 'tries'} left.`);
    return false;
  } });
}
function setupPin() {
  hideModal();
  showPinPad({ title: 'Choose a 4-digit PIN', cancel: true, handler: async (first) => {
    showPinPad({ title: 'Type the same PIN again', cancel: true, handler: async (second) => {
      if (first !== second) { setupPin(); pinMsg("PINs didn't match. Choose a PIN again."); return false; }
      await PIN.set(first); saveSession(); hidePinPad(); toast('App lock is on 🔒'); openSettings(); return true;
    } });
    return true;
  } });
}

/* ================= install as an app ================= */
let installEvt = null;
const UA = navigator.userAgent;
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(UA) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isAndroid = () => /android/i.test(UA);
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; });
window.addEventListener('appinstalled', () => { installEvt = null; hideModal(); toast('Yarn is installed 🎉'); });
const swOK = 'serviceWorker' in navigator && location.protocol === 'https:' && window.top === window;
if (swOK) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (!e.data || !S.token) return;
    if (e.data.open) openChat(e.data.open);
    if (e.data.poke) loadChats();
  });
}

/* ================= push notifications ================= */
// The server sends an empty "wake up" push; the phone then fetches what's new and decrypts the preview itself.
const pushSupported = () => swOK && 'PushManager' in window && 'Notification' in window;
function urlB64(s) { const p = '='.repeat((4 - (s.length % 4)) % 4); return unb64((s + p).replace(/-/g, '+').replace(/_/g, '/')); }
async function saveSession() {
  if (!S.me || !S.token) return;
  await keyStore.set('session', { token: S.token, userId: S.me.id, hidePreview: !!PIN.get() });
}
async function pushState() {
  if (!pushSupported()) return isIOS() && !isStandalone() ? 'install' : 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  if (Notification.permission !== 'granted') return 'off';
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = reg && (await reg.pushManager.getSubscription());
  return sub ? 'on' : 'off';
}
async function enablePush(quiet = false) {
  try {
    if (!pushSupported()) { if (!quiet) toast(isIOS() ? 'Install Yarn to your Home Screen first.' : 'This browser does not support notifications.'); return false; }
    const perm = Notification.permission === 'granted' ? 'granted' : quiet ? Notification.permission : await Notification.requestPermission();
    if (perm !== 'granted') { if (!quiet) toast('Notifications were not allowed.'); return false; }
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const { key } = await api('push/key');
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64(key) });
    }
    await api('push/subscribe', { body: sub.toJSON() });
    await saveSession();
    return true;
  } catch (e) { if (!quiet) toast('Could not turn on notifications: ' + e.message); return false; }
}
async function disablePushOnThisDevice() {
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg && (await reg.pushManager.getSubscription());
    if (sub) { const endpoint = sub.endpoint; await sub.unsubscribe(); return endpoint; }
  } catch {}
  return null;
}
async function maybeAskPush() {
  const st = await pushState();
  if (st === 'on' || st === 'denied' || st === 'unsupported') return;
  if (Date.now() - LS.get('yarn_push_ask', 0) < DAY_MS) return;
  setTimeout(() => {
    if (!S.token || S.locked || S.chatId || !$('#modal').classList.contains('hidden')) return;
    if (st === 'install') return; // iPhone: the install guide comes first
    showModal(`<div class="profile-top"><div class="big-emoji">🔔</div><h2>Don't miss a message</h2>
      <p class="muted">Turn on notifications to get alerts for new messages, even when Yarn is closed. Previews are unlocked on your phone, so they stay private.</p></div>
      <div class="row"><button class="btn ghost" id="paLater">Not now</button><button class="btn" id="paGo">Turn on</button></div>`);
    $('#paLater').onclick = () => { LS.set('yarn_push_ask', Date.now()); hideModal(); };
    $('#paGo').onclick = async () => { hideModal(); if (await enablePush()) { toast('Notifications are on 🔔'); } else LS.set('yarn_push_ask', Date.now()); };
  }, 2500);
}
const SHARE_IC = '<svg class="inl" viewBox="0 0 24 24"><path d="M12 3v12M8 7l4-4 4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M6 11H5v10h14V11h-1" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';
const DOTS_IC = '<svg class="inl" viewBox="0 0 24 24"><circle cx="12" cy="5" r="2" fill="currentColor"/><circle cx="12" cy="12" r="2" fill="currentColor"/><circle cx="12" cy="19" r="2" fill="currentColor"/></svg>';
function showInstallGuide() {
  const iosSafari = isIOS() && /safari/i.test(UA) && !/crios|fxios|edgios|opios/i.test(UA);
  let body;
  if (isStandalone()) body = `<p class="muted">Yarn is already installed on this device. 🎉</p><div class="row"><button class="btn" data-close>Done</button></div>`;
  else if (installEvt) body = `<p class="muted">Put Yarn on your home screen. It opens full screen like a normal app, loads faster and can alert you about new messages.</p>
    <div class="row"><button class="btn ghost" id="instLater">Not now</button><button class="btn" id="instGo">Install Yarn</button></div>`;
  else if (isIOS() && !iosSafari) body = `<ol class="steps"><li>Copy this page's link</li><li>Open it in <b>Safari</b> (iPhone only lets Safari add apps)</li><li>Tap ${SHARE_IC} <b>Share</b>, then <b>Add to Home Screen</b></li></ol>
    <div class="row"><button class="btn ghost" id="instLater">Not now</button><button class="btn" id="instCopy">Copy link</button></div>`;
  else if (isIOS()) body = `<ol class="steps"><li>Tap the ${SHARE_IC} <b>Share</b> button at the bottom of Safari</li><li>Scroll down and tap <b>Add to Home Screen</b> ➕</li><li>Tap <b>Add</b> at the top right</li></ol>
    <p class="hint-box">🔔 On iPhone, message alerts only work after Yarn is added to your Home Screen (iOS 16.4 or newer).</p>
    <div class="row"><button class="btn ghost" id="instLater">Not now</button><button class="btn" data-close>Got it</button></div>`;
  else if (isAndroid()) body = `<ol class="steps"><li>Tap the ${DOTS_IC} <b>menu</b> at the top right of Chrome</li><li>Tap <b>Install app</b> or <b>Add to Home screen</b></li><li>Tap <b>Install</b></li></ol>
    <div class="row"><button class="btn ghost" id="instLater">Not now</button><button class="btn" data-close>Got it</button></div>`;
  else body = `<ol class="steps"><li>Use <b>Chrome</b> or <b>Edge</b></li><li>Click the install icon in the address bar, or open the ${DOTS_IC} menu</li><li>Choose <b>Install Yarn</b></li></ol>
    <div class="row"><button class="btn ghost" id="instLater">Not now</button><button class="btn" data-close>Got it</button></div>`;
  showModal(`<div class="install-head"><span class="app-icon">y<i></i></span><div><h2>Install Yarn</h2><p class="muted">Free · iPhone, Android and computer</p></div></div>${body}`);
  const later = $('#instLater'); if (later) later.onclick = () => { LS.set('yarn_install_dismiss', Date.now()); hideModal(); };
  const go = $('#instGo'); if (go) go.onclick = async () => { installEvt.prompt(); const r = await installEvt.userChoice; installEvt = null; hideModal(); if (r.outcome !== 'accepted') LS.set('yarn_install_dismiss', Date.now()); };
  const cp = $('#instCopy'); if (cp) cp.onclick = () => { navigator.clipboard?.writeText(location.origin).then(() => toast('Link copied. Paste it in Safari.'), () => toast(location.origin)); };
}
function maybeShowInstall() {
  if (isStandalone() || window.top !== window) return;
  if (Date.now() - LS.get('yarn_install_dismiss', 0) < 3 * DAY_MS) return;
  setTimeout(() => {
    if (S.token && !S.locked && !S.chatId && $('#modal').classList.contains('hidden') && $('#story').classList.contains('hidden')) showInstallGuide();
  }, 6000);
}

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
  const text = who + snippet(c.last_type, c.last_text);
  sounds.bell();
  if (navigator.vibrate) try { navigator.vibrate(60); } catch {}
  if (document.hidden || S.locked) {
    if (S.pushOn) return; // the push notification from the server handles it
    if ('Notification' in window && Notification.permission === 'granted') {
      const t = S.locked || PIN.get() ? APP_NAME : title, b = S.locked || PIN.get() ? 'New message' : text;
      navigator.serviceWorker?.getRegistration?.().then((reg) => {
        if (reg) return reg.showNotification(t, { body: b, tag: 'yarn-' + c.id, icon: '/icon-192.png', badge: '/badge-96.png', data: { chat: c.id } });
        const n = new Notification(t, { body: b, tag: 'yarn-' + c.id }); n.onclick = () => { window.focus(); openChat(c.id); n.close(); };
      }).catch(() => {});
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
  const btn = $('#authBtn'), label = btn.textContent; btn.disabled = true; $('#authErr').textContent = '';
  const un = $('#un').value.trim().toLowerCase().replace(/^@/, ''), pw = $('#pw').value;
  try {
    if (!window.crypto || !crypto.subtle) throw new Error('Your browser is too old for encrypted chats. Please update it.');
    if (authMode === 'register' && pw.length < 6) throw new Error('Password must be at least 6 characters.');
    btn.textContent = 'Securing your account…';
    const sec = await deriveSecrets(un, pw);
    let d;
    if (authMode === 'register') {
      const id = await newIdentity(sec.wrapKey);
      d = await api('register', { body: { username: un, password: sec.auth, display_name: $('#dn').value, public_key: id.pub, enc_priv: id.sealed } });
      S.token = d.token;
      await saveKeys(d.user.id, id.priv, id.pub);
    } else {
      try { d = await api('login', { body: { username: un, password: sec.auth } }); }
      catch (x) { if (x.data && x.data.legacy) d = await api('login', { body: { username: un, password: sec.auth, legacy_password: pw } }); else throw x; }
      S.token = d.token;
      await setupKeys(d, sec.wrapKey);
    }
    LS.set('yarn_t2', d.token); saveMe(d.user);
    $('#pw').value = '';
    startApp();
  } catch (x) { S.token = null; $('#authErr').textContent = x.message; }
  btn.disabled = false; btn.textContent = label;
});
function saveMe(u) { S.me = u; LS.set('yarn_me2', u); drawMe(); }
function signOutLocal() {
  if (S.me) keyStore.del('id-' + S.me.id);
  keyStore.del('session'); S.pushOn = false;
  KEYS = null; pairCache.clear(); mediaURLs.clear(); previewCache.clear();
  S.token = null; S.me = null; S.known = null; S.chats = []; S.chatsKey = ''; S.locked = false; S.modalLocked = false;
  LS.del('yarn_t2'); LS.del('yarn_me2');
  if (!$('#lock').classList.contains('hidden')) hidePinPad();
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
    await decryptPreviews(d.chats);
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
const previewCache = new Map();
async function decryptPreviews(list) {
  await Promise.all(list.map(async (c) => {
    if (!c.last_id || !isEnv(c.last_body)) { c.last_text = c.last_body; return; }
    if (!previewCache.has(c.last_id)) previewCache.set(c.last_id, unseal(c.last_body, c.last_sender_key).then((r) => r.text, () => LOCKED));
    c.last_text = await previewCache.get(c.last_id);
  }));
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
        const mineLast = c.last_sender === S.me.id && !['system', 'deleted'].includes(c.last_type);
        const who = ['system', 'deleted'].includes(c.last_type) || mineLast ? '' : c.is_group ? (c.last_sender_name || '').split(' ')[0] + ': ' : '';
        last = who + snippet(c.last_type, c.last_text);
        if (mineLast) {
          const st = c.others_read >= c.last_id ? 'read' : c.others_delivered >= c.last_id ? 'delivered' : 'sent';
          c._tick = `<span class="ci-tick ${st}">${st === 'sent' ? TICK1 : TICK2}</span>`;
        } else c._tick = '';
      }
      const typing = c.typing ? (c.is_group ? 'someone is typing…' : 'typing…') : '';
      const online = !c.is_group && isOnline(c.other_seen) ? 'online' : '';
      return `<li class="chat-item ${c.unread ? 'unread' : ''} ${c.id === S.chatId ? 'active' : ''}" data-id="${c.id}">
        ${c.is_group ? avatarHTML(c.name, 'g' + c.id) : avatarHTML(name, c.other_username, online, c.other_avatar)}
        <div class="ci-main">
          <div class="ci-top"><span class="ci-name">${esc(name)}</span><span class="ci-time">${listTime(c.last_msg_at)}</span></div>
          <div class="ci-bot"><span class="ci-last ${typing ? 'typing-txt' : ''}">${typing ? '' : c._tick || ''}${esc(typing || last)}</span>${c.unread ? `<span class="badge">${c.unread > 99 ? '99+' : c.unread}</span>` : ''}</div>
        </div></li>`;
    }).join('');
  }
  const total = S.chats.reduce((a, c) => a + (c.unread || 0), 0);
  document.title = total ? `(${total}) ${APP_NAME}` : APP_NAME;
  const b = $('#chatsBadge'); b.textContent = total > 99 ? '99+' : total; b.classList.toggle('hidden', !total);
  try { if (navigator.setAppBadge) total ? navigator.setAppBadge(total) : navigator.clearAppBadge(); } catch {}
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
    await decryptAll(d.messages);
    if (S.chatId !== id) return;
    S.serverNow = d.now; S.since = d.now; S.readUpto = d.read_upto; S.deliveredUpto = d.delivered_upto || 0; S.reads = d.reads || []; S.seen = d.seen; S.typing = d.typing || [];
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
    updateTicks(); updateSeenLabel(); updateHeader(); markRead(); hydrateImages();
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
  const quote = m.reply_to && m.reply_type ? `<div class="quote" data-jump="${m.reply_to}"><b>${esc(m.reply_sender === S.me.id ? 'You' : m.reply_name)}</b><span>${esc(snippet(m.reply_type, m.reply_text))}</span></div>` : '';
  let img = '';
  if (m.type === 'image' && !m.locked) {
    if (m.media_url) img = `<span class="img" data-src="${m.media_url}"><img src="${m.media_url}" alt="Photo"></span>`;
    else if (m.media_key && m.ck) img = `<span class="img loading" data-mk="${m.media_key}" data-mid="${m.id}"></span>`;
    else if (m.media_key) img = `<span class="img" data-src="${media(m.media_key)}"><img src="${media(m.media_key)}" loading="lazy" alt="Photo"></span>`;
  }
  const txt = m.text ? `<div class="txt ${m.locked ? 'locked' : ''}">${m.locked ? esc(m.text) : linkify(m.text)}</div>` : '';
  const st = mine && !m.pending ? tickState(m.id) : '';
  const tick = mine ? (m.pending ? '<span class="clock">🕓</span>' : st === 'sent' ? TICK1 : TICK2) : '';
  const cls = ['m', mine && 'mine', first && 'first', st && 'st-' + st, m.pending && 'pending', extra].filter(Boolean).join(' ');
  return `<div class="${cls}" ${m.pending ? `data-temp="${m.temp}"` : `data-id="${m.id}" data-st="${st}"`}>${who}${quote}${img}${txt}<div class="meta"><span>${clock(m.created_at)}</span>${tick}</div></div>`;
}
let lastRendered = null;
function renderAll(list) {
  S.ids = new Set(); lastRendered = null;
  let html = S.noOlder ? '<div class="e2e-note">🔒 Messages and photos are end-to-end encrypted. Only people in this chat can read them, not even Yarn.</div>' : '<button class="older" id="olderBtn">Load earlier messages</button>';
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
  hydrateImages(); updateSeenLabel();
}
function hydrateImages() {
  $$('#msgs .img[data-mk]:not([data-src])').forEach(async (el) => {
    if (el.dataset.busy) return; el.dataset.busy = '1';
    const m = S.loaded.find((x) => x.id === +el.dataset.mid);
    if (!m || !m.ck) return;
    try { const url = await mediaURL(m.media_key, m.ck); el.dataset.src = url; el.classList.remove('loading'); el.innerHTML = `<img src="${url}" alt="Photo">`; }
    catch { el.classList.remove('loading'); el.classList.add('gone'); el.textContent = 'Photo unavailable'; }
  });
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
  Object.assign(m, { type: 'deleted', body: '', text: '', media_key: null, media_url: null });
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
    await decryptAll(d.messages);
    if (S.chatId !== id) return;
    S.noOlder = d.messages.length < 50;
    renderAll([...d.messages, ...S.loaded]);
    box.scrollTop = box.scrollHeight - before;
  } catch (e) { toast(e.message); }
  S.loadingOlder = false;
}
$('#msgs').addEventListener('scroll', () => { if ($('#msgs').scrollTop < 40) loadOlder(); });
// sent = server has it · delivered = reached their phone (data/Wi-Fi on) · read = they opened the chat
function tickState(id) { return S.readUpto >= id ? 'read' : S.deliveredUpto >= id ? 'delivered' : 'sent'; }
function updateTicks() {
  $$('#msgs .m.mine[data-id]:not(.deleted)').forEach((el) => {
    const st = tickState(+el.dataset.id);
    if (el.dataset.st === st) return;
    el.classList.remove('st-sent', 'st-delivered', 'st-read'); el.classList.add('st-' + st);
    el.dataset.st = st;
    const t = el.querySelector('.tick'); if (t) t.outerHTML = st === 'sent' ? TICK1 : TICK2;
  });
}
const EYE = '<svg class="eye" viewBox="0 0 24 24"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3" fill="currentColor"/></svg>';
// The label under your latest message: Sent / Delivered / Seen (groups: Seen by 2 of 4)
function updateSeenLabel() {
  $$('#msgs .seen-label').forEach((e) => e.remove());
  const last = [...S.loaded].reverse().find((m) => m.type !== 'system');
  if (!last || last.sender_id !== S.me.id || last.type === 'deleted') return;
  const el = $(`#msgs [data-id="${last.id}"]`); if (!el) return;
  const reads = S.reads || [];
  let html, cls = '';
  if (!S.chat || !S.chat.is_group) {
    const st = tickState(last.id);
    html = st === 'read' ? `${EYE} Seen` : st === 'delivered' ? 'Delivered' : 'Sent';
    cls = st;
  } else {
    const seen = reads.filter((r) => r.last_read_id >= last.id).length;
    const got = reads.filter((r) => r.delivered_id >= last.id).length;
    if (reads.length && seen === reads.length) { html = `${EYE} Seen by everyone`; cls = 'read'; }
    else if (seen) { html = `${EYE} Seen by ${seen} of ${reads.length}`; cls = 'read'; }
    else html = got ? `Delivered to ${got} of ${reads.length}` : 'Sent';
    cls += ' tap';
  }
  el.insertAdjacentHTML('afterend', `<button class="seen-label ${cls}" data-mid="${last.id}">${html}</button>`);
}
$('#msgs').addEventListener('click', (e) => {
  const b = e.target.closest('.seen-label.tap'); if (!b) return;
  const id = +b.dataset.mid, name = (uid) => nameOf(S.members.find((m) => m.id === uid));
  const seen = S.reads.filter((r) => r.last_read_id >= id), got = S.reads.filter((r) => r.last_read_id < id && r.delivered_id >= id), wait = S.reads.filter((r) => r.delivered_id < id);
  const list = (arr, empty) => arr.length ? `<div class="ulist">${arr.map((r) => { const u = S.members.find((m) => m.id === r.user_id) || { id: r.user_id, display_name: '?' }; return userRow(u); }).join('')}</div>` : `<p class="muted pad">${empty}</p>`;
  showModal(`<h2>Message info</h2>
    <p class="sec seen-sec">${EYE} Seen by ${seen.length}</p>${list(seen, 'No one yet')}
    <p class="sec">✓✓ Delivered to ${got.length}</p>${list(got, 'No one else')}
    ${wait.length ? `<p class="sec">✓ Not delivered yet · ${wait.length}</p>${list(wait, '')}` : ''}
    <div class="row"><button class="btn ghost" data-close>Close</button></div>`);
});
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
  if (m.locked) return;
  showModal(`<div class="menu-preview">${esc(snippet(m.type, m.text).slice(0, 160))}</div>
    <div class="menu">
      ${canSend ? '<button data-a="reply">↩️ Reply</button>' : ''}
      ${m.text ? '<button data-a="copy">📋 Copy text</button>' : ''}
      ${m.type === 'image' ? '<button data-a="view">🖼️ View photo</button>' : ''}
      ${mine ? `<button data-a="info">ℹ️ Info · ${{ read: 'Seen', delivered: 'Delivered', sent: 'Sent' }[tickState(id)]}</button>` : ''}
      ${mine ? '<button data-a="del" class="danger-txt">🗑️ Delete for everyone</button>' : ''}
    </div>`);
  $('#sheet .menu').onclick = async (e) => {
    const a = e.target.closest('button')?.dataset.a; if (!a) return;
    hideModal();
    if (a === 'reply') startReply(id);
    if (a === 'info') {
      if (S.chat && S.chat.is_group) { const fake = document.createElement('button'); fake.className = 'seen-label tap'; fake.dataset.mid = id; $('#msgs').appendChild(fake); fake.click(); fake.remove(); }
      else { const st = tickState(id); toast(st === 'read' ? '👁 Seen by ' + nameOf(other()) : st === 'delivered' ? '✓✓ Delivered to their phone, not opened yet' : '✓ Sent. Their phone is offline or has no data right now.'); }
    }
    if (a === 'copy') { try { await navigator.clipboard.writeText(m.text); toast('Copied'); } catch { toast('Could not copy'); } }
    if (a === 'view') { const el = $(`#msgs [data-id="${id}"] .img`); if (el && el.dataset.src) showPhoto(el.dataset.src); }
    if (a === 'del') {
      if (!confirm('Delete this message for everyone?')) return;
      try { await api(`chats/${S.chatId}/messages/${id}/delete`, { body: {} }); markDeleted(id); setTimeout(loadChats, 200); }
      catch (err) { toast(err.message); }
    }
  };
}
function startReply(id) {
  const m = S.loaded.find((x) => x.id === id);
  if (!m || m.type === 'deleted' || m.type === 'system' || m.locked || S.blockedByMe || S.blockedMe) return;
  S.replyTo = { id, name: m.sender_id === S.me.id ? 'You' : m.sender_name, type: m.type, text: m.text, sender_id: m.sender_id };
  $('#rbName').textContent = 'Replying to ' + S.replyTo.name;
  $('#rbSnip').textContent = snippet(m.type, m.text);
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
  send({ type: 'text', text: body });
});
async function send(payload, previewUrl) {
  const id = S.chatId, temp = ++S.tempN, reply = S.replyTo;
  clearReply(); typingSent = 0;
  const fake = {
    temp, pending: true, sender_id: S.me.id, type: payload.type, text: payload.text, media_url: previewUrl, created_at: Date.now(),
    reply_to: reply?.id, reply_type: reply?.type, reply_text: reply?.text, reply_sender: reply?.sender_id, reply_name: reply?.name,
  };
  const box = $('#msgs');
  box.insertAdjacentHTML('beforeend', msgHTML(fake, lastRendered, 'pop'));
  scrollBottom(true);
  try {
    if (!S.members.length) await loadChatDetails();
    const people = S.members.filter((x) => !x.deleted);
    if (!people.some((x) => x.id === S.me.id)) people.push({ id: S.me.id, public_key: KEYS.pub });
    const missing = people.filter((x) => !x.public_key);
    if (missing.length && !S.warnedKeys) { S.warnedKeys = true; toast(`${nameOf(missing[0]).split(' ')[0]} needs to log in to the new Yarn before they can read encrypted messages.`); }
    const sealed = await seal(people, payload.text);
    const req = { type: payload.type, body: sealed.body, reply_to: reply?.id };
    if (payload.type === 'image') req.enc_data = await encryptImage(sealed.ck, payload.data);
    const d = await api(`chats/${id}/messages`, { body: req });
    Object.assign(d.message, { _d: true, text: payload.text || '', ck: sealed.ck, reply_text: reply?.text });
    if (payload.type === 'image' && d.message.media_key) mediaURLs.set(d.message.media_key, Promise.resolve(previewUrl));
    sounds.sent();
    const el = box.querySelector(`[data-temp="${temp}"]`);
    if (S.chatId !== id) return;
    if (S.ids.has(d.message.id)) el?.remove();
    else {
      S.ids.add(d.message.id); S.loaded.push(d.message);
      S.lastId = Math.max(S.lastId, d.message.id);
      const html = msgHTML(d.message, lastRendered); lastRendered = d.message;
      if (el) el.outerHTML = html; else box.insertAdjacentHTML('beforeend', html);
      hydrateImages();
    }
    updateSeenLabel();
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
    $('#sendImg').onclick = () => { const caption = $('#cap').value.trim(); hideModal(); send({ type: 'image', data, text: caption }, data); };
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
$('#modal').addEventListener('click', (e) => { if (S.modalLocked) return; if (e.target.id === 'modal' || e.target.closest('[data-close]')) hideModal(); });
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('#lock').classList.contains('hidden')) return;
  if (!$('#story').classList.contains('hidden')) closeStory();
  else if (!$('#viewer').classList.contains('hidden')) $('#viewer').classList.add('hidden');
  else if (!S.modalLocked) hideModal();
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
      ${u.deleted ? '<p class="pill">This account was deleted.</p>' : ''}
      ${u.is_padi ? `<p class="pill ${u.mutual ? 'ok' : ''}">${u.mutual ? '🤝 You are padis. You can see each other’s vibes.' : '⏳ Saved. You’ll see their vibes once they add you back.'}</p>` : ''}
    </div>
    <div class="menu">
      <button data-a="msg">💬 Message</button>
      ${u.is_padi ? '<button data-a="nick">✏️ Set a nickname</button><button data-a="unpadi">➖ Remove from padis</button>' : '<button data-a="padi">🤝 Add to padis</button>'}
      ${u.public_key && KEYS ? '<button data-a="code">🔐 Verify encryption</button>' : ''}
      <button data-a="block" class="danger-txt">${u.blocked ? '✅ Unblock' : '⛔ Block'} ${esc(nameOf(u).split(' ')[0])}</button>
    </div>`);
  $('#sheet .menu').onclick = async (e) => {
    const a = e.target.closest('button')?.dataset.a; if (!a) return;
    try {
      if (a === 'msg') return openDirect(u);
      if (a === 'padi') { await addPadi(u); return openProfile(uid); }
      if (a === 'unpadi') { await api('padis/remove', { body: { user_id: uid } }); toast('Removed from padis'); loadPadis(); loadVibes(); return openProfile(uid); }
      if (a === 'nick') return nickSheet(u);
      if (a === 'code') {
        const code = await safetyCode(KEYS.pub, u.public_key);
        return showModal(`<div class="profile-top"><div class="big-emoji">🔐</div><h2>Safety code</h2>
          <p class="muted">Your chats with ${esc(nameOf(u))} are end-to-end encrypted. To be extra sure, meet up or call and check that you both see the same code.</p></div>
          <div class="code">${code.split(' ').map((g) => `<span>${g}</span>`).join('')}</div>
          <div class="row"><button class="btn ghost" id="cdBack">Back</button></div>`) || ($('#cdBack').onclick = () => openProfile(uid));
      }
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
    S.vibes = { mine: d.mine, feed: d.feed.filter((v) => canOpen(v.body)) }; S.serverNow = d.now;
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
  for (const g of map.values()) g.user.public_key = g.items[0].owner_key;
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
    mine.length ? openStory([{ user: { ...S.me, public_key: KEYS.pub }, items: mine, mineGroup: true }], 0) : openNewVibe();
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
    try {
      const sealed = await seal(vibeAudience(), body);
      await api('vibes', { body: { type: 'text', body: sealed.body, bg } }); hideModal(); toast('Vibe posted ✨'); await loadVibes(); setTab('vibes');
    } catch (e) { toast(e.message); }
  };
  setTimeout(() => $('#vt')?.focus(), 60);
}
// Vibes are locked for you + every padi who has saved you back (at the time you post)
function vibeAudience() { return [{ id: S.me.id, public_key: KEYS.pub }, ...S.padis.filter((p) => p.mutual && p.public_key)]; }
async function openVibe(v, ownerKey) {
  if (v._p) return v._p;
  let text = v.body || '', url = null;
  if (isEnv(v.body)) {
    const r = await unseal(v.body, ownerKey);
    text = r.text;
    if (v.type === 'image') url = await mediaURL(v.media_key, r.ck);
  } else if (v.type === 'image') url = media(v.media_key);
  return (v._p = { text, url });
}
function vibePhotoStep(data) {
  showModal(`<h2>Photo vibe</h2><img class="preview-img" src="${data}" alt="">
    <input class="field" id="vcap" placeholder="Add a caption (optional)" maxlength="300">
    <div class="row"><button class="btn ghost" data-close>Cancel</button><button class="btn" id="vpPost">Post</button></div>`);
  $('#vpPost').onclick = async () => {
    const b = $('#vpPost'); b.disabled = true;
    try {
      const sealed = await seal(vibeAudience(), $('#vcap').value.trim());
      await api('vibes', { body: { type: 'image', body: sealed.body, enc_data: await encryptImage(sealed.ck, data) } });
      hideModal(); toast('Vibe posted ✨'); await loadVibes(); setTab('vibes');
    }
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
  clearTimeout(ST.timer); ST.ticket = (ST.ticket || 0) + 1;
  $('#story').classList.add('hidden');
  $('#stBody').innerHTML = '';
  loadVibes();
}
async function showVibe() {
  clearTimeout(ST.timer);
  const g = ST.groups[ST.gi], v = g.items[ST.i];
  if (!v) return closeStory();
  const ticket = (ST.ticket = (ST.ticket || 0) + 1);
  let plain;
  $('#stBody').innerHTML = '<div class="st-wait">🔓</div>';
  try { plain = await openVibe(v, g.user.public_key); } catch { plain = { text: LOCKED, url: null }; }
  if (ticket !== ST.ticket || $('#story').classList.contains('hidden')) return;
  $('#stBars').innerHTML = g.items.map((_, k) => `<i class="${k < ST.i ? 'done' : ''}"><b></b></i>`).join('');
  $('#stAv').innerHTML = avatarHTML(nameOf(g.user), g.user.username, 'sm', g.user.avatar_key);
  $('#stName').textContent = g.mineGroup ? 'My vibe' : nameOf(g.user);
  $('#stTime').textContent = ago(v.created_at);
  $('#stBody').innerHTML = v.type === 'image' && plain.url
    ? `<img src="${plain.url}" alt="">${plain.text ? `<p class="st-cap">${linkify(plain.text)}</p>` : ''}`
    : `<div class="st-text" style="background:${VIBE_BGS[v.bg] || VIBE_BGS.g0}"><p>${linkify(plain.text)}</p></div>`;
  $('#stFoot').innerHTML = g.mineGroup
    ? `<button id="stViews">👁 ${v.views} view${v.views === 1 ? '' : 's'}</button><button id="stDel">🗑️ Delete</button>`
    : `<button id="stReply">💬 Reply to ${esc(nameOf(g.user).split(' ')[0])}</button>`;
  if (!g.mineGroup && !v.seen) { v.seen = 1; api(`vibes/${v.id}/view`, { body: {} }).catch(() => {}); }
  ST.dur = v.type === 'image' ? 6000 : Math.min(9000, 4000 + (plain.text || '').length * 35);
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

    <p class="sec">Appearance</p>
    <div class="seg" id="sTheme">${[['system', '📱 System'], ['light', '☀️ Light'], ['dark', '🌙 Dark']].map(([k, l]) => `<button data-v="${k}" class="${(S.prefs.theme || 'system') === k ? 'on' : ''}">${l}</button>`).join('')}</div>

    <p class="sec">Notifications</p>
    <label class="setting"><div><strong>Pop-up alerts</strong><span>Show a banner for new messages</span></div><input type="checkbox" class="switch" id="sPop" ${S.prefs.popups ? 'checked' : ''}></label>
    <label class="setting"><div><strong>Sounds</strong><span>Bell for new messages, soft sounds in chats</span></div><input type="checkbox" class="switch" id="sSnd" ${S.prefs.sound ? 'checked' : ''}></label>
    <div class="setting"><div><strong>Push notifications</strong><span id="pushTxt">Checking…</span></div><span id="pushBtn"></span></div>
    <button class="linkbtn" id="sTest">🔔 Test sound</button>

    <p class="sec">App lock</p>
    <div class="setting"><div><strong>PIN lock</strong><span>${PIN.get() ? 'On. Yarn asks for your PIN when you open it.' : 'Ask for a 4-digit PIN when Yarn opens'}</span></div>
      ${PIN.get() ? '<button class="btn sm ghost" id="pinOff">Turn off</button>' : '<button class="btn sm" id="pinOn">Set PIN</button>'}</div>
    ${PIN.get() ? `<div class="setting"><div><strong>Lock automatically</strong><span>After leaving the app</span></div></div>
      <div class="seg" id="pinAfter">${[[0, 'Immediately'], [60000, 'After 1 min'], [300000, 'After 5 min']].map(([v, l]) => `<button data-v="${v}" class="${PIN.get().after === v ? 'on' : ''}">${l}</button>`).join('')}</div>
      <button class="linkbtn" id="pinChange">Change PIN</button>` : ''}

    <p class="sec">Encryption</p>
    <div class="setting"><div><strong>🔒 End-to-end encrypted</strong><span>Your messages, photos and vibes are locked on your device. Only the people you send them to can read them.</span></div><span class="tag ok">On</span></div>

    <p class="sec">App</p>
    <div class="setting"><div><strong>Install Yarn</strong><span>${isStandalone() ? 'Installed on this device' : 'Add Yarn to your home screen'}</span></div><button class="btn sm ${isStandalone() ? 'ghost' : ''}" id="sInstall">${isStandalone() ? 'Installed' : 'Install'}</button></div>

    <p class="sec">Password</p>
    <input class="field" type="password" id="pCur" placeholder="Current password" autocomplete="current-password">
    <input class="field" type="password" id="pNew" placeholder="New password (6+ characters)" autocomplete="new-password">
    <div class="row"><button class="btn ghost" id="pSave">Change password</button></div>

    <p class="sec">Blocked people</p>
    <div class="ulist" id="bl"><p class="muted pad">Loading…</p></div>

    <div class="row"><button class="btn ghost" id="logout">Log out</button><button class="btn ghost" data-close>Close</button></div>
    <button class="linkbtn danger-txt del-acc" id="delAcc">Delete my account</button>`, 'tall');
  $('#sTheme').onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    S.prefs.theme = b.dataset.v; LS.set('yarn_prefs', S.prefs); applyTheme();
    $$('#sTheme button').forEach((x) => x.classList.toggle('on', x === b));
  };
  const pOn = $('#pinOn'); if (pOn) pOn.onclick = setupPin;
  const pCh = $('#pinChange'); if (pCh) pCh.onclick = setupPin;
  const pOff = $('#pinOff'); if (pOff) pOff.onclick = () => {
    hideModal();
    showPinPad({ title: 'Enter your PIN to turn it off', cancel: true, handler: async (pin) => {
      if (!(await PIN.check(pin))) { pinMsg('Wrong PIN.'); return false; }
      PIN.clear(); saveSession(); hidePinPad(); toast('App lock is off'); openSettings(); return true;
    } });
  };
  const pAf = $('#pinAfter'); if (pAf) pAf.onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    PIN.setAfter(+b.dataset.v); $$('#pinAfter button').forEach((x) => x.classList.toggle('on', x === b));
  };
  $('#sInstall').onclick = () => showInstallGuide();
  $('#delAcc').onclick = deleteAccountSheet;

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
  pushState().then((st) => {
    const txt = $('#pushTxt'), btn = $('#pushBtn'); if (!txt) return;
    const msg = {
      on: 'On for this device, even when Yarn is closed',
      off: 'Get alerts when Yarn is closed',
      denied: 'Blocked. Allow notifications for this site in your browser or phone settings.',
      install: 'On iPhone, install Yarn to your Home Screen first',
      unsupported: 'Not supported in this browser',
    }[st];
    txt.textContent = msg;
    if (st === 'on') { btn.innerHTML = '<button class="btn sm ghost" id="pushTest">Send test</button>'; $('#pushTest').onclick = async () => { try { await api('push/test', { body: {} }); toast('Test sent. Lock your phone or switch apps to see it.'); } catch (e) { toast(e.message); } }; }
    else if (st === 'off') { btn.innerHTML = '<button class="btn sm" id="pushOn">Turn on</button>'; $('#pushOn').onclick = async () => { if (await enablePush()) { S.pushOn = true; toast('Notifications are on 🔔'); openSettings(); } }; }
    else if (st === 'install') { btn.innerHTML = '<button class="btn sm" id="pushInst">How?</button>'; $('#pushInst').onclick = showInstallGuide; }
  });
  $('#pSave').onclick = async () => {
    const b = $('#pSave'), cur = $('#pCur').value, nw = $('#pNew').value;
    if (nw.length < 6) return toast('New password must be at least 6 characters.');
    b.disabled = true; b.textContent = 'Changing…';
    try {
      const [a, z] = await Promise.all([deriveSecrets(S.me.username, cur), deriveSecrets(S.me.username, nw)]);
      const d = await api('me');
      let enc_priv = null;
      if (d.enc_priv) {
        let opened; try { opened = await openSealed(d.enc_priv, a.wrapKey); } catch { throw new Error('Your current password is wrong.'); }
        enc_priv = b64(await aesEncrypt(z.wrapKey, opened.pk8));
      }
      await api('password', { body: { current: a.auth, next: z.auth, enc_priv } });
      $('#pCur').value = $('#pNew').value = ''; toast('Password changed. Other devices were logged out.');
    } catch (e) { toast(e.message); }
    b.disabled = false; b.textContent = 'Change password';
  };
  $('#logout').onclick = async () => { hideModal(); const endpoint = await disablePushOnThisDevice(); try { await api('logout', { body: { endpoint } }); } catch {} signOutLocal(); };
  api('blocks').then((d) => {
    const bl = $('#bl'); if (!bl) return;
    bl.innerHTML = d.users.length ? d.users.map((u) => userRow(u, `<button class="btn sm ghost" data-unb="${u.id}">Unblock</button>`)).join('') : '<p class="muted pad">No one. Nice.</p>';
    bl.onclick = async (e) => {
      const b = e.target.closest('[data-unb]'); if (!b) return;
      try { await api('blocks/remove', { body: { user_id: +b.dataset.unb } }); b.closest('.urow').remove(); toast('Unblocked'); } catch (x) { toast(x.message); }
    };
  }).catch(() => {});
}
function deleteAccountSheet() {
  showModal(`<div class="profile-top"><div class="big-emoji">⚠️</div><h2>Delete your account?</h2>
    <p class="muted">This removes your profile, photo, padis and vibes, takes you out of all groups and logs you out everywhere. It can't be undone.</p></div>
    <input class="field" type="password" id="daPw" placeholder="Type your password to confirm" autocomplete="current-password">
    <p class="err" id="daErr"></p>
    <div class="row"><button class="btn ghost" id="daBack">Cancel</button><button class="btn danger" id="daGo">Delete forever</button></div>`);
  $('#daBack').onclick = openSettings;
  $('#daGo').onclick = async () => {
    const b = $('#daGo'); b.disabled = true; b.textContent = 'Deleting…'; $('#daErr').textContent = '';
    try {
      const sec = await deriveSecrets(S.me.username, $('#daPw').value);
      await api('account/delete', { body: { password: sec.auth } });
      PIN.clear(); hideModal(); signOutLocal(); toast('Your account was deleted.');
    } catch (e) { $('#daErr').textContent = e.message; b.disabled = false; b.textContent = 'Delete forever'; }
  };
}
async function uploadAvatar(data) {
  try { toast('Uploading photo…'); const d = await api('profile/avatar', { body: { data } }); saveMe(d.user); toast('Photo updated'); openSettings(); }
  catch (e) { toast(e.message); }
}

/* ================= start ================= */
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { S.hiddenAt = Date.now(); return; }
  if (!S.token) return;
  const pin = PIN.get();
  if (pin && S.hiddenAt && Date.now() - S.hiddenAt >= (pin.after || 0)) lockApp();
  loadChats(); if (S.chatId) pollMessages();
});
async function startApp() {
  $('#auth').classList.add('hidden'); $('#app').classList.remove('hidden');
  drawMe(); setTab('chats');
  if (PIN.get()) lockApp();
  await ensureKeys();
  if (!S.token) return;
  saveSession();
  await loadChats(); loadPadis(); loadVibes();
  const deep = +new URLSearchParams(location.search).get('chat');
  if (deep) { history.replaceState(null, '', '/'); openChat(deep); }
  pushState().then(async (st) => { if (st === 'on' || (st === 'off' && Notification.permission === 'granted')) S.pushOn = await enablePush(true); else maybeAskPush(); });
  clearInterval(vibeTimer); vibeTimer = setInterval(loadVibes, 30000);
  try { const d = await api('me'); saveMe(d.user); } catch {}
  maybeShowInstall();
}
if (S.token && S.me) startApp(); else $('#auth').classList.remove('hidden');
