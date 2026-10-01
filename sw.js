// Yarn service worker: install as an app, open fast, and show message notifications even when Yarn is closed.
const SHELL = 'yarn-shell-v4';
const MEDIA = 'yarn-media-v1';
const FILES = ['/', '/style.css', '/app.js', '/manifest.json', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (e) => {
  // Cache each file on its own, so one missing file never breaks installing the app
  e.waitUntil(caches.open(SHELL).then((c) => Promise.all(FILES.map((f) => c.add(f).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== MEDIA).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/media/')) {
    e.respondWith(caches.open(MEDIA).then(async (c) => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok) c.put(e.request, res.clone());
      return res;
    }));
    return;
  }
  if (url.pathname.startsWith('/api/')) return;
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res.ok && !res.redirected) { const copy = res.clone(); caches.open(SHELL).then((c) => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request).then((r) => r || caches.match('/')))
  );
});

/* ---------- small key store shared with the app (IndexedDB) ---------- */
function idb(mode, fn) {
  return new Promise((res) => {
    const r = indexedDB.open('yarn-keys', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('k');
    r.onerror = () => res(null);
    r.onsuccess = () => {
      try {
        const tx = r.result.transaction('k', mode); const q = fn(tx.objectStore('k'));
        tx.oncomplete = () => res(q && q.result); tx.onerror = () => res(null);
      } catch { res(null); }
    };
  });
}
const idbGet = (k) => idb('readonly', (s) => s.get(k));
const idbSet = (k, v) => idb('readwrite', (s) => s.put(v, k));

/* ---------- decrypt the preview on this device ---------- */
const TE = new TextEncoder(), TD = new TextDecoder();
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function openPreview(body, senderPub, me, priv) {
  if (!body || !body.startsWith('{"e2e"')) return body || '';
  const env = JSON.parse(body);
  const w = env.k && env.k[me];
  if (!w || !senderPub || !priv) return null;
  const pub = await crypto.subtle.importKey('jwk', JSON.parse(senderPub), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: pub }, priv, 256);
  const hk = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  const kw = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: TE.encode('yarn-pair-v1'), info: new Uint8Array(0) }, hk, { name: 'AES-KW', length: 256 }, false, ['unwrapKey']);
  const ck = await crypto.subtle.unwrapKey('raw', unb64(w), kw, 'AES-KW', { name: 'AES-GCM' }, false, ['decrypt']);
  if (!env.t) return '';
  const data = unb64(env.t);
  return TD.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: data.slice(0, 12) }, ck, data.slice(12)));
}

/* ---------- push: a new message arrived ---------- */
self.addEventListener('push', (e) => e.waitUntil(onPush()));
async function onPush() {
  const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const visible = wins.some((w) => w.visibilityState === 'visible');
  wins.forEach((w) => w.postMessage({ poke: true }));
  const sess = await idbGet('session');
  let items = [];
  if (sess && sess.token) {
    try {
      const r = await fetch('/api/push/peek', { headers: { authorization: 'Bearer ' + sess.token } });
      if (r.ok) items = (await r.json()).messages || [];
    } catch {}
  }
  const apple = /iPhone|iPad|Macintosh/.test(self.navigator.userAgent);
  // If Yarn is open on screen, the app shows its own pop-up instead
  if (visible && !apple) return;
  const lastSeen = (await idbGet('lastPush')) || 0;
  const fresh = items.filter((m) => m.id > lastSeen);
  if (items.length) await idbSet('lastPush', Math.max(lastSeen, ...items.map((m) => m.id)));
  const total = items.reduce((a, m) => a + (m.unread || 0), 0);
  if (self.navigator.setAppBadge && total) self.navigator.setAppBadge(total).catch(() => {});
  if (!fresh.length) {
    if (items.length && !apple) return;
    return self.registration.showNotification('Yarn', { body: 'You have a new message', tag: 'yarn-new', icon: '/icon-192.png', badge: '/badge-96.png', silent: visible });
  }
  const keyRec = sess ? await idbGet('id-' + sess.userId) : null;
  for (const m of fresh.slice(0, 3)) {
    const who = m.nick || m.sender_name;
    const title = m.is_group ? m.chat_name : who;
    let text;
    if (sess.hidePreview) text = m.unread > 1 ? `${m.unread} new messages` : 'New message';
    else {
      let plain = null;
      try { plain = await openPreview(m.body, m.sender_key, sess.userId, keyRec && keyRec.priv); } catch {}
      text = m.type === 'image' ? '📷 Photo' + (plain ? ' · ' + plain : '') : plain || 'New message';
      if (m.unread > 1) text += `  (+${m.unread - 1} more)`;
    }
    if (m.is_group && !sess.hidePreview) text = who.split(' ')[0] + ': ' + text;
    await self.registration.showNotification(sess.hidePreview ? 'Yarn' : title, {
      body: text, tag: 'yarn-' + m.chat_id, renotify: true, icon: '/icon-192.png', badge: '/badge-96.png',
      data: { chat: m.chat_id }, timestamp: m.created_at, silent: visible,
    });
  }
}

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const chat = e.notification.data && e.notification.data.chat;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) { c.focus(); if (chat) c.postMessage({ open: chat }); return; }
    return self.clients.openWindow(chat ? '/?chat=' + chat : '/');
  }));
});
