// Yarn chat API — Cloudflare Pages Function. Needs a D1 binding named DB.

const J = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
const err = (msg, status = 400) => J({ error: msg }, status);
const now = () => Date.now();
const DAY = 86400000;
const VIBE_BGS = ['g0', 'g1', 'g2', 'g3', 'g4', 'g5'];

function randHex(n) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return [...a].map((x) => x.toString(16).padStart(2, '0')).join('');
}

async function hashPass(password, saltHex) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const salt = new Uint8Array(saltHex.match(/../g).map((h) => parseInt(h, 16)));
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, key, 256);
  let s = '';
  new Uint8Array(bits).forEach((b) => (s += String.fromCharCode(b)));
  return btoa(s);
}

async function newSession(DB, userId) {
  const token = randHex(32);
  await DB.prepare('INSERT INTO sessions (token,user_id,created_at) VALUES (?,?,?)').bind(token, userId, now()).run();
  return token;
}

async function getUser(DB, req) {
  const h = req.headers.get('authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token) return null;
  const u = await DB.prepare(
    'SELECT u.id,u.username,u.display_name,u.last_seen,u.about,u.avatar_key,u.seen_privacy,u.public_key,u.enc_priv FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?'
  ).bind(token).first();
  return u ? { ...u, token } : null;
}

const cleanUsername = (v) => String(v || '').trim().toLowerCase().replace(/^@/, '');
const meOut = (u) => ({
  id: u.id, username: u.username, display_name: u.display_name,
  about: u.about || '', avatar_key: u.avatar_key || null, seen_privacy: u.seen_privacy || 'everyone',
  public_key: u.public_key || null,
});
const okKey = (v, max) => typeof v === 'string' && v.length > 20 && v.length < max;
const isEnvelope = (v) => typeof v === 'string' && v.startsWith('{"e2e"');
const B64 = /^[A-Za-z0-9+/=]+$/;
// Hide "last seen" depending on that person's privacy setting
const showSeen = (seen, privacy, hasMe) => (privacy === 'nobody' ? 0 : privacy === 'padis' && !hasMe ? 0 : seen || 0);

function parseImage(data, maxLen = 1500000) {
  const mt = /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(data || '');
  if (!mt) return { error: 'That image type is not supported.' };
  if (mt[2].length > maxLen) return { error: 'That image is too large.' };
  return { mime: mt[1], b64: mt[2] };
}

async function profileOf(DB, me, byUsername, val) {
  const u = await DB.prepare(`SELECT u.id,u.username,u.display_name,u.about,u.avatar_key,u.last_seen,u.seen_privacy,u.public_key,u.deleted,
      (SELECT nickname FROM padis WHERE owner_id=?1 AND padi_id=u.id) AS nickname,
      EXISTS(SELECT 1 FROM padis WHERE owner_id=?1 AND padi_id=u.id) AS is_padi,
      EXISTS(SELECT 1 FROM padis WHERE owner_id=u.id AND padi_id=?1) AS has_me,
      EXISTS(SELECT 1 FROM blocks WHERE blocker_id=?1 AND blocked_id=u.id) AS blocked,
      EXISTS(SELECT 1 FROM blocks WHERE blocker_id=u.id AND blocked_id=?1) AS blocked_me
    FROM users u WHERE ${byUsername ? 'u.username' : 'u.id'}=?2`).bind(me.id, val).first();
  if (!u) return null;
  return {
    id: u.id, username: u.username, display_name: u.display_name, about: u.about || '',
    avatar_key: u.avatar_key || null, nickname: u.nickname || null,
    is_padi: !!u.is_padi, mutual: !!(u.is_padi && u.has_me), blocked: !!u.blocked,
    public_key: u.public_key || null, deleted: !!u.deleted,
    last_seen: u.blocked_me ? 0 : showSeen(u.last_seen, u.seen_privacy, u.has_me),
  };
}

async function canSeeVibes(DB, meId, ownerId) {
  if (meId === ownerId) return true;
  const r = await DB.prepare(`SELECT (EXISTS(SELECT 1 FROM padis WHERE owner_id=?1 AND padi_id=?2)
      AND EXISTS(SELECT 1 FROM padis WHERE owner_id=?2 AND padi_id=?1)
      AND NOT EXISTS(SELECT 1 FROM blocks WHERE (blocker_id=?1 AND blocked_id=?2) OR (blocker_id=?2 AND blocked_id=?1))) AS ok`)
    .bind(meId, ownerId).first();
  return !!r?.ok;
}

/* ---------- Push notifications (Web Push with VAPID, no payload: the phone fetches + decrypts the preview itself) ---------- */
const TE = new TextEncoder();
const b64url = (bytes) => { let s = ''; bytes.forEach((b) => (s += String.fromCharCode(b))); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
async function vapidKeys(DB) {
  let row = await DB.prepare("SELECT v FROM config WHERE k='vapid'").first();
  if (row) return JSON.parse(row.v);
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const priv = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const pub = b64url(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey)));
  await DB.prepare("INSERT OR IGNORE INTO config (k,v) VALUES ('vapid',?)").bind(JSON.stringify({ priv, pub })).run();
  row = await DB.prepare("SELECT v FROM config WHERE k='vapid'").first();
  return JSON.parse(row.v);
}
async function vapidHeader(endpoint, keys, contact) {
  const aud = new URL(endpoint).origin;
  const head = b64url(TE.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64url(TE.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: contact })));
  const { key_ops, ext, ...jwk } = keys.priv;
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, TE.encode(head + '.' + body)));
  return `vapid t=${head}.${body}.${b64url(sig)}, k=${keys.pub}`;
}
async function pushToChat(DB, chatId, senderId, origin) {
  try {
    const subs = (await DB.prepare(`SELECT ps.endpoint FROM push_subs ps JOIN members m ON m.user_id=ps.user_id
        WHERE m.chat_id=? AND ps.user_id<>? AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.blocker_id=ps.user_id AND b.blocked_id=?)`)
      .bind(chatId, senderId, senderId).all()).results;
    if (!subs.length) return;
    const keys = await vapidKeys(DB);
    const contact = origin.startsWith('https://') ? origin : 'mailto:hello@example.com';
    await Promise.all(subs.map(async (sub) => {
      try {
        const r = await fetch(sub.endpoint, {
          method: 'POST',
          headers: { TTL: '86400', Urgency: 'high', Authorization: await vapidHeader(sub.endpoint, keys, contact), 'Content-Length': '0' },
        });
        if (r.status === 404 || r.status === 410) await DB.prepare('DELETE FROM push_subs WHERE endpoint=?').bind(sub.endpoint).run();
      } catch {}
    }));
  } catch {}
}

async function pushToUser(DB, userId, origin) {
  const subs = (await DB.prepare('SELECT endpoint FROM push_subs WHERE user_id=?').bind(userId).all()).results;
  const keys = await vapidKeys(DB);
  const contact = origin.startsWith('https://') ? origin : 'mailto:hello@example.com';
  await Promise.all(subs.map(async (sub) => {
    try {
      const r = await fetch(sub.endpoint, { method: 'POST', headers: { TTL: '600', Urgency: 'high', Authorization: await vapidHeader(sub.endpoint, keys, contact), 'Content-Length': '0' } });
      if (r.status === 404 || r.status === 410) await DB.prepare('DELETE FROM push_subs WHERE endpoint=?').bind(sub.endpoint).run();
    } catch {}
  }));
}

const MSG_SELECT = `SELECT m.id,m.sender_id,m.type,m.body,m.media_key,m.created_at,m.reply_to,u.display_name AS sender_name,
  u.public_key AS sender_key,
  r.type AS reply_type, r.body AS reply_body, r.sender_id AS reply_sender, ru.display_name AS reply_name, ru.public_key AS reply_sender_key
  FROM messages m JOIN users u ON u.id=m.sender_id
  LEFT JOIN messages r ON r.id=m.reply_to LEFT JOIN users ru ON ru.id=r.sender_id`;

export async function onRequest({ request, env, params, waitUntil }) {
  try {
    if (!env.DB) return err('Database not connected. Add a D1 binding named DB.', 500);
    const parts = Array.isArray(params.path) ? params.path : params.path ? [params.path] : [];
    return await route(request, env.DB, parts, waitUntil);
  } catch (e) {
    return err('Server error: ' + e.message, 500);
  }
}

async function route(req, DB, parts, waitUntil = (p) => p) {
  const m = req.method;
  const url = new URL(req.url);
  const p = parts.join('/');
  const body = async () => { try { return await req.json(); } catch { return {}; } };
  const t = now();

  // ---------- Images (public, by random key) ----------
  if (m === 'GET' && parts[0] === 'media' && parts[1]) {
    const row = await DB.prepare('SELECT mime,data FROM media WHERE key=?').bind(parts[1]).first();
    if (!row) return new Response('Not found', { status: 404 });
    const bin = Uint8Array.from(atob(row.data), (c) => c.charCodeAt(0));
    return new Response(bin, { headers: { 'content-type': row.mime, 'cache-control': 'public, max-age=31536000, immutable' } });
  }

  // ---------- Sign up / log in ----------
  if (m === 'POST' && p === 'register') {
    const b = await body();
    const username = cleanUsername(b.username);
    const display = String(b.display_name || '').trim().slice(0, 40) || username;
    const password = String(b.password || '');
    if (!/^[a-z0-9_]{3,20}$/.test(username)) return err('Username must be 3 to 20 letters, numbers or underscores.');
    if (password.length < 6) return err('Password must be at least 6 characters.');
    if (await DB.prepare('SELECT 1 FROM users WHERE username=?').bind(username).first()) return err('That username is taken.');
    if (!okKey(b.public_key, 2000) || !okKey(b.enc_priv, 4000)) return err('Your browser could not create encryption keys. Please update it and try again.');
    const salt = randHex(16);
    const hash = await hashPass(password, salt);
    const r = await DB.prepare('INSERT INTO users (username,display_name,pass_hash,salt,created_at,last_seen,public_key,enc_priv,pw_v) VALUES (?,?,?,?,?,?,?,?,2)')
      .bind(username, display, hash, salt, t, t, b.public_key, b.enc_priv).run();
    const id = r.meta.last_row_id;
    const token = await newSession(DB, id);
    return J({ token, user: meOut({ id, username, display_name: display, public_key: b.public_key }), enc_priv: b.enc_priv });
  }
  if (m === 'POST' && p === 'login') {
    const b = await body();
    const u = await DB.prepare('SELECT * FROM users WHERE username=? AND deleted=0').bind(cleanUsername(b.username)).first();
    if (!u) return err('Wrong username or password.', 401);
    if (u.pw_v < 2) {
      // Account made before encryption: check the old password once, then switch to the new secure login
      if (!b.legacy_password) return J({ error: 'Upgrading your account…', legacy: true }, 401);
      if ((await hashPass(String(b.legacy_password), u.salt)) !== u.pass_hash) return err('Wrong username or password.', 401);
      const salt = randHex(16);
      await DB.prepare('UPDATE users SET pass_hash=?,salt=?,pw_v=2 WHERE id=?').bind(await hashPass(String(b.password || ''), salt), salt, u.id).run();
    } else if ((await hashPass(String(b.password || ''), u.salt)) !== u.pass_hash) return err('Wrong username or password.', 401);
    const token = await newSession(DB, u.id);
    return J({ token, user: meOut(u), enc_priv: u.enc_priv || null });
  }

  // ---------- Everything below needs login ----------
  const me = await getUser(DB, req);
  if (!me) return err('Please log in.', 401);
  if (t - me.last_seen > 60000) await DB.prepare('UPDATE users SET last_seen=? WHERE id=?').bind(t, me.id).run();

  if (m === 'GET' && p === 'me') return J({ user: meOut(me), enc_priv: me.enc_priv || null });

  // ---------- Push notifications ----------
  if (m === 'GET' && p === 'push/key') return J({ key: (await vapidKeys(DB)).pub });
  if (m === 'POST' && p === 'push/subscribe') {
    const b = await body();
    const ep = String(b.endpoint || ''), k = b.keys || {};
    if (!/^https:\/\//.test(ep) || ep.length > 1000) return err('Invalid subscription.');
    await DB.prepare('INSERT INTO push_subs (endpoint,user_id,p256dh,auth,created_at) VALUES (?,?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id, p256dh=excluded.p256dh, auth=excluded.auth')
      .bind(ep, me.id, String(k.p256dh || ''), String(k.auth || ''), t).run();
    return J({ ok: true });
  }
  if (m === 'POST' && p === 'push/unsubscribe') {
    const b = await body();
    await DB.prepare('DELETE FROM push_subs WHERE endpoint=? AND user_id=?').bind(String(b.endpoint || ''), me.id).run();
    return J({ ok: true });
  }
  if (m === 'POST' && p === 'push/test') {
    waitUntil(pushToUser(DB, me.id, url.origin));
    return J({ ok: true });
  }
  // The phone asks "what's new?" after a push, then decrypts the preview on the device
  if (m === 'GET' && p === 'push/peek') {
    const r = await DB.prepare(`SELECT m.id, m.chat_id, m.type, m.body, m.created_at, m.sender_id, u.display_name AS sender_name, u.public_key AS sender_key,
        c.is_group, c.name AS chat_name, (SELECT nickname FROM padis pp WHERE pp.owner_id=?1 AND pp.padi_id=m.sender_id) AS nick,
        (SELECT COUNT(*) FROM messages mx WHERE mx.chat_id=c.id AND mx.id>mem.last_read_id AND mx.sender_id<>?1 AND mx.type IN ('text','image')) AS unread
      FROM members mem JOIN chats c ON c.id=mem.chat_id
      JOIN messages m ON m.id=(SELECT MAX(id) FROM messages mx WHERE mx.chat_id=c.id AND mx.sender_id<>?1 AND mx.type IN ('text','image'))
      JOIN users u ON u.id=m.sender_id
      WHERE mem.user_id=?1 AND m.id>mem.last_read_id
      ORDER BY m.id DESC LIMIT 5`).bind(me.id).all();
    await DB.prepare('UPDATE members SET delivered_id=(SELECT MAX(id) FROM messages WHERE chat_id=members.chat_id) WHERE user_id=? AND delivered_id<(SELECT COALESCE(MAX(id),0) FROM messages WHERE chat_id=members.chat_id)').bind(me.id).run();
    return J({ messages: r.results });
  }

  // Save my encryption keys (only if I don't have any yet)
  if (m === 'POST' && p === 'keys') {
    const b = await body();
    if (me.public_key) return err('Keys already exist for this account.');
    if (!okKey(b.public_key, 2000) || !okKey(b.enc_priv, 4000)) return err('Invalid keys.');
    await DB.prepare('UPDATE users SET public_key=?,enc_priv=? WHERE id=? AND public_key IS NULL').bind(b.public_key, b.enc_priv, me.id).run();
    return J({ user: meOut({ ...me, public_key: b.public_key }) });
  }

  // Delete my account
  if (m === 'POST' && p === 'account/delete') {
    const b = await body();
    const u = await DB.prepare('SELECT pass_hash,salt FROM users WHERE id=?').bind(me.id).first();
    if ((await hashPass(String(b.password || ''), u.salt)) !== u.pass_hash) return err('Your password is wrong.');
    await DB.batch([
      DB.prepare("INSERT INTO messages (chat_id,sender_id,type,body,created_at) SELECT m.chat_id,?,'system',?,? FROM members m JOIN chats c ON c.id=m.chat_id WHERE m.user_id=? AND c.is_group=1")
        .bind(me.id, `${me.display_name} deleted their account`, t, me.id),
      DB.prepare('DELETE FROM members WHERE user_id=? AND chat_id IN (SELECT id FROM chats WHERE is_group=1)').bind(me.id),
      DB.prepare('DELETE FROM padis WHERE owner_id=? OR padi_id=?').bind(me.id, me.id),
      DB.prepare('DELETE FROM blocks WHERE blocker_id=? OR blocked_id=?').bind(me.id, me.id),
      DB.prepare('DELETE FROM vibe_views WHERE viewer_id=? OR vibe_id IN (SELECT id FROM vibes WHERE user_id=?)').bind(me.id, me.id),
      DB.prepare('DELETE FROM media WHERE key IN (SELECT media_key FROM vibes WHERE user_id=? AND media_key IS NOT NULL)').bind(me.id),
      DB.prepare('DELETE FROM vibes WHERE user_id=?').bind(me.id),
      DB.prepare('DELETE FROM media WHERE key=?').bind(me.avatar_key || '-'),
      DB.prepare("UPDATE users SET username=?,display_name='Deleted account',about='',avatar_key=NULL,pass_hash='',salt='',enc_priv=NULL,seen_privacy='nobody',deleted=1 WHERE id=?")
        .bind('deleted_' + me.id + '_' + randHex(4), me.id),
      DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(me.id),
      DB.prepare('DELETE FROM push_subs WHERE user_id=?').bind(me.id),
    ]);
    return J({ ok: true });
  }
  if (m === 'POST' && p === 'logout') {
    const b = await body();
    if (b.endpoint) await DB.prepare('DELETE FROM push_subs WHERE endpoint=? AND user_id=?').bind(String(b.endpoint), me.id).run();
    await DB.prepare('DELETE FROM sessions WHERE token=?').bind(me.token).run();
    return J({ ok: true });
  }

  // ---------- Profile & settings ----------
  if (m === 'POST' && p === 'profile') {
    const b = await body();
    const display = b.display_name !== undefined ? String(b.display_name).trim().slice(0, 40) : me.display_name;
    const about = b.about !== undefined ? String(b.about).trim().slice(0, 140) : me.about || '';
    const privacy = ['everyone', 'padis', 'nobody'].includes(b.seen_privacy) ? b.seen_privacy : me.seen_privacy || 'everyone';
    if (!display) return err('Enter your name.');
    await DB.prepare('UPDATE users SET display_name=?,about=?,seen_privacy=? WHERE id=?').bind(display, about, privacy, me.id).run();
    return J({ user: meOut({ ...me, display_name: display, about, seen_privacy: privacy }) });
  }
  if (m === 'POST' && p === 'profile/avatar') {
    const b = await body();
    const stmts = [];
    let key = null;
    if (!b.remove) {
      const img = parseImage(b.data, 500000);
      if (img.error) return err(img.error);
      key = randHex(16);
      stmts.push(DB.prepare('INSERT INTO media (key,mime,data,created_at) VALUES (?,?,?,?)').bind(key, img.mime, img.b64, t));
    }
    stmts.push(DB.prepare('UPDATE users SET avatar_key=? WHERE id=?').bind(key, me.id));
    if (me.avatar_key) stmts.push(DB.prepare('DELETE FROM media WHERE key=?').bind(me.avatar_key));
    await DB.batch(stmts);
    return J({ user: meOut({ ...me, avatar_key: key }) });
  }
  if (m === 'POST' && p === 'password') {
    const b = await body();
    const u = await DB.prepare('SELECT pass_hash,salt FROM users WHERE id=?').bind(me.id).first();
    if ((await hashPass(String(b.current || ''), u.salt)) !== u.pass_hash) return err('Your current password is wrong.');
    const next = String(b.next || '');
    if (next.length < 20) return err('Invalid new password.');
    if (me.enc_priv && !okKey(b.enc_priv, 4000)) return err('Could not re-lock your encryption key. Try again.');
    const salt = randHex(16);
    await DB.batch([
      DB.prepare('UPDATE users SET pass_hash=?,salt=?,enc_priv=COALESCE(?,enc_priv),pw_v=2 WHERE id=?').bind(await hashPass(next, salt), salt, b.enc_priv || null, me.id),
      DB.prepare('DELETE FROM sessions WHERE user_id=? AND token<>?').bind(me.id, me.token),
    ]);
    return J({ ok: true });
  }

  // ---------- Find people (exact username only) ----------
  if (m === 'GET' && p === 'users/find') {
    const u = cleanUsername(url.searchParams.get('u'));
    if (!u) return err('Type a username.');
    if (u === me.username) return err("That's your own username.");
    const user = u.startsWith('deleted_') ? null : await profileOf(DB, me, true, u);
    if (!user) return err('No one has that username. Check the spelling.', 404);
    return J({ user });
  }
  if (m === 'GET' && parts[0] === 'users' && /^\d+$/.test(parts[1] || '')) {
    const user = await profileOf(DB, me, false, +parts[1]);
    if (!user) return err('User not found.', 404);
    return J({ user });
  }

  // ---------- Padis (saved contacts) ----------
  if (m === 'GET' && p === 'padis') {
    const r = await DB.prepare(`SELECT u.id,u.username,u.display_name,u.about,u.avatar_key,u.last_seen,u.seen_privacy,u.public_key,p.nickname,
        EXISTS(SELECT 1 FROM padis b WHERE b.owner_id=u.id AND b.padi_id=?1) AS mutual
      FROM padis p JOIN users u ON u.id=p.padi_id WHERE p.owner_id=?1
      ORDER BY LOWER(COALESCE(p.nickname,u.display_name))`).bind(me.id).all();
    const padis = r.results.map((u) => ({
      id: u.id, username: u.username, display_name: u.display_name, about: u.about || '', avatar_key: u.avatar_key,
      nickname: u.nickname, mutual: !!u.mutual, last_seen: showSeen(u.last_seen, u.seen_privacy, u.mutual), public_key: u.public_key,
    }));
    return J({ padis, now: t });
  }
  if (m === 'POST' && p === 'padis') {
    const b = await body();
    const id = parseInt(b.user_id);
    if (!id || id === me.id) return err('Pick someone to add.');
    if (!(await DB.prepare('SELECT 1 FROM users WHERE id=?').bind(id).first())) return err('User not found.');
    const nick = b.nickname !== undefined ? String(b.nickname || '').trim().slice(0, 40) || null : undefined;
    if (nick === undefined)
      await DB.prepare('INSERT OR IGNORE INTO padis (owner_id,padi_id,created_at) VALUES (?,?,?)').bind(me.id, id, t).run();
    else
      await DB.prepare('INSERT INTO padis (owner_id,padi_id,nickname,created_at) VALUES (?,?,?,?) ON CONFLICT(owner_id,padi_id) DO UPDATE SET nickname=excluded.nickname')
        .bind(me.id, id, nick, t).run();
    return J({ ok: true });
  }
  if (m === 'POST' && p === 'padis/remove') {
    const b = await body();
    await DB.prepare('DELETE FROM padis WHERE owner_id=? AND padi_id=?').bind(me.id, parseInt(b.user_id)).run();
    return J({ ok: true });
  }

  // ---------- Blocking ----------
  if (m === 'GET' && p === 'blocks') {
    const r = await DB.prepare('SELECT u.id,u.username,u.display_name,u.avatar_key FROM blocks b JOIN users u ON u.id=b.blocked_id WHERE b.blocker_id=? ORDER BY b.created_at DESC')
      .bind(me.id).all();
    return J({ users: r.results });
  }
  if (m === 'POST' && p === 'blocks') {
    const b = await body();
    const id = parseInt(b.user_id);
    if (!id || id === me.id) return err('Pick someone to block.');
    await DB.prepare('INSERT OR IGNORE INTO blocks (blocker_id,blocked_id,created_at) VALUES (?,?,?)').bind(me.id, id, t).run();
    return J({ ok: true });
  }
  if (m === 'POST' && p === 'blocks/remove') {
    const b = await body();
    await DB.prepare('DELETE FROM blocks WHERE blocker_id=? AND blocked_id=?').bind(me.id, parseInt(b.user_id)).run();
    return J({ ok: true });
  }

  // ---------- Vibes (24-hour status) ----------
  if (m === 'GET' && p === 'vibes') {
    if (Math.random() < 0.05) {
      await DB.batch([
        DB.prepare('DELETE FROM media WHERE key IN (SELECT media_key FROM vibes WHERE expires_at<? AND media_key IS NOT NULL)').bind(t),
        DB.prepare('DELETE FROM vibe_views WHERE vibe_id IN (SELECT id FROM vibes WHERE expires_at<?)').bind(t),
        DB.prepare('DELETE FROM vibes WHERE expires_at<?').bind(t),
      ]);
    }
    const [mine, feed] = await DB.batch([
      DB.prepare(`SELECT v.id,v.type,v.body,v.bg,v.media_key,v.created_at,
          (SELECT COUNT(*) FROM vibe_views vv WHERE vv.vibe_id=v.id) AS views
        FROM vibes v WHERE v.user_id=? AND v.expires_at>? ORDER BY v.id`).bind(me.id, t),
      DB.prepare(`SELECT v.id,v.user_id,v.type,v.body,v.bg,v.media_key,v.created_at,u.display_name,u.username,u.avatar_key,u.public_key AS owner_key,p.nickname,
          EXISTS(SELECT 1 FROM vibe_views vv WHERE vv.vibe_id=v.id AND vv.viewer_id=?1) AS seen
        FROM padis p
        JOIN padis b ON b.owner_id=p.padi_id AND b.padi_id=p.owner_id
        JOIN vibes v ON v.user_id=p.padi_id AND v.expires_at>?2
        JOIN users u ON u.id=v.user_id
        WHERE p.owner_id=?1 AND NOT EXISTS(SELECT 1 FROM blocks bl WHERE (bl.blocker_id=?1 AND bl.blocked_id=v.user_id) OR (bl.blocker_id=v.user_id AND bl.blocked_id=?1))
        ORDER BY v.user_id, v.id`).bind(me.id, t),
    ]);
    return J({ mine: mine.results, feed: feed.results, now: t });
  }
  if (m === 'POST' && p === 'vibes') {
    const b = await body();
    const active = await DB.prepare('SELECT COUNT(*) AS n FROM vibes WHERE user_id=? AND expires_at>?').bind(me.id, t).first();
    if (active.n >= 30) return err('You have 30 vibes up already. Delete one first.');
    const text = isEnvelope(b.body) ? String(b.body).slice(0, 120000) : String(b.body || '').trim().slice(0, 700);
    const stmts = [];
    let type = 'text', key = null, bg = VIBE_BGS.includes(b.bg) ? b.bg : 'g0';
    if (b.type === 'image') {
      let mime, data;
      if (b.enc_data) {
        if (!B64.test(b.enc_data) || b.enc_data.length > 1800000) return err('That image is too large.');
        mime = 'application/octet-stream'; data = b.enc_data;
      } else {
        const img = parseImage(b.data);
        if (img.error) return err(img.error);
        mime = img.mime; data = img.b64;
      }
      type = 'image';
      key = randHex(16);
      stmts.push(DB.prepare('INSERT INTO media (key,mime,data,created_at) VALUES (?,?,?,?)').bind(key, mime, data, t));
    } else if (!text) return err('Write something for your vibe.');
    stmts.push(DB.prepare('INSERT INTO vibes (user_id,type,body,bg,media_key,created_at,expires_at) VALUES (?,?,?,?,?,?,?)')
      .bind(me.id, type, text, bg, key, t, t + DAY));
    await DB.batch(stmts);
    return J({ ok: true });
  }
  if (parts[0] === 'vibes' && /^\d+$/.test(parts[1] || '')) {
    const vid = +parts[1];
    const v = await DB.prepare('SELECT id,user_id,media_key FROM vibes WHERE id=? AND expires_at>?').bind(vid, t).first();
    if (!v) return err('This vibe has expired.', 404);
    if (m === 'POST' && parts[2] === 'view') {
      if (v.user_id !== me.id && (await canSeeVibes(DB, me.id, v.user_id)))
        await DB.prepare('INSERT OR IGNORE INTO vibe_views (vibe_id,viewer_id,viewed_at) VALUES (?,?,?)').bind(vid, me.id, t).run();
      return J({ ok: true });
    }
    if (v.user_id !== me.id) return err('That is not your vibe.', 403);
    if (m === 'GET' && parts[2] === 'viewers') {
      const r = await DB.prepare('SELECT u.id,u.username,u.display_name,u.avatar_key,vv.viewed_at FROM vibe_views vv JOIN users u ON u.id=vv.viewer_id WHERE vv.vibe_id=? ORDER BY vv.viewed_at DESC')
        .bind(vid).all();
      return J({ viewers: r.results });
    }
    if (m === 'POST' && parts[2] === 'delete') {
      const stmts = [
        DB.prepare('DELETE FROM vibe_views WHERE vibe_id=?').bind(vid),
        DB.prepare('DELETE FROM vibes WHERE id=?').bind(vid),
      ];
      if (v.media_key) stmts.push(DB.prepare('DELETE FROM media WHERE key=?').bind(v.media_key));
      await DB.batch(stmts);
      return J({ ok: true });
    }
  }

  // ---------- Chats ----------
  if (m === 'GET' && p === 'chats') {
    await DB.prepare('UPDATE members SET delivered_id=(SELECT MAX(id) FROM messages WHERE chat_id=members.chat_id) WHERE user_id=? AND delivered_id<(SELECT COALESCE(MAX(id),0) FROM messages WHERE chat_id=members.chat_id)').bind(me.id).run();
    const r = await DB.prepare(`
      SELECT c.id, c.is_group, c.name, c.last_msg_at,
        o.id AS other_id, o.display_name AS other_name, o.username AS other_username, o.last_seen AS other_seen,
        o.avatar_key AS other_avatar, o.seen_privacy AS other_privacy,
        EXISTS(SELECT 1 FROM padis p WHERE p.owner_id=o.id AND p.padi_id=?1) AS other_has_me,
        EXISTS(SELECT 1 FROM blocks bl WHERE bl.blocker_id=o.id AND bl.blocked_id=?1) AS other_blocked_me,
        (SELECT nickname FROM padis p WHERE p.owner_id=?1 AND p.padi_id=o.id) AS other_nick,
        lm.id AS last_id, lm.type AS last_type, lm.body AS last_body, lm.sender_id AS last_sender,
        su.display_name AS last_sender_name, su.public_key AS last_sender_key, o.deleted AS other_deleted,
        (SELECT MIN(mm.last_read_id) FROM members mm WHERE mm.chat_id=c.id AND mm.user_id<>?1) AS others_read,
        (SELECT MIN(MAX(mm.delivered_id, mm.last_read_id)) FROM members mm WHERE mm.chat_id=c.id AND mm.user_id<>?1) AS others_delivered,
        (SELECT COUNT(*) FROM messages mx WHERE mx.chat_id=c.id AND mx.id>mem.last_read_id AND mx.sender_id<>?1 AND mx.type NOT IN ('system','deleted')) AS unread,
        (SELECT COUNT(*) FROM members mt WHERE mt.chat_id=c.id AND mt.user_id<>?1 AND mt.typing_until>?2) AS typing
      FROM members mem
      JOIN chats c ON c.id=mem.chat_id
      LEFT JOIN users o ON c.is_group=0 AND o.id=(SELECT m2.user_id FROM members m2 WHERE m2.chat_id=c.id AND m2.user_id<>?1 LIMIT 1)
      LEFT JOIN messages lm ON lm.id=(SELECT MAX(id) FROM messages WHERE chat_id=c.id)
      LEFT JOIN users su ON su.id=lm.sender_id
      WHERE mem.user_id=?1
      ORDER BY c.last_msg_at DESC LIMIT 100`).bind(me.id, t).all();
    const chats = r.results.map((c) => {
      c.other_seen = c.other_blocked_me ? 0 : showSeen(c.other_seen, c.other_privacy, c.other_has_me);
      if (c.other_blocked_me) c.other_avatar = null;
      delete c.other_privacy; delete c.other_has_me; delete c.other_blocked_me;
      return c;
    });
    return J({ chats, now: t });
  }

  if (m === 'POST' && p === 'chats/direct') {
    const b = await body();
    const other = b.user_id
      ? await DB.prepare('SELECT id,deleted FROM users WHERE id=?').bind(parseInt(b.user_id)).first()
      : await DB.prepare('SELECT id,deleted FROM users WHERE username=?').bind(cleanUsername(b.username)).first();
    if (!other) return err('No one has that username.');
    if (other.id === me.id) return err("That's your own username.");
    if (other.deleted) return err('This account was deleted.');
    const key = [me.id, other.id].sort((a, c) => a - c).join(':');
    const found = await DB.prepare('SELECT id FROM chats WHERE dm_key=?').bind(key).first();
    if (found) {
      await DB.prepare('INSERT OR IGNORE INTO members (chat_id,user_id,joined_at) VALUES (?,?,?)').bind(found.id, me.id, t).run();
      return J({ id: found.id });
    }
    const r = await DB.prepare('INSERT INTO chats (is_group,dm_key,created_by,created_at,last_msg_at) VALUES (0,?,?,?,?)').bind(key, me.id, t, t).run();
    const id = r.meta.last_row_id;
    await DB.batch([
      DB.prepare('INSERT OR IGNORE INTO members (chat_id,user_id,joined_at) VALUES (?,?,?)').bind(id, me.id, t),
      DB.prepare('INSERT OR IGNORE INTO members (chat_id,user_id,joined_at) VALUES (?,?,?)').bind(id, other.id, t),
    ]);
    return J({ id });
  }

  if (m === 'POST' && p === 'chats/group') {
    const b = await body();
    const name = String(b.name || '').trim().slice(0, 50);
    if (!name) return err('Give the group a name.');
    const ids = [...new Set((b.user_ids || []).map((x) => parseInt(x)).filter((x) => x && x !== me.id))].slice(0, 50);
    let users = [];
    if (ids.length) {
      const r = await DB.prepare(`SELECT id FROM users WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all();
      users = r.results;
    }
    const cr = await DB.prepare('INSERT INTO chats (is_group,name,created_by,created_at,last_msg_at) VALUES (1,?,?,?,?)').bind(name, me.id, t, t).run();
    const id = cr.meta.last_row_id;
    const stmts = [me, ...users].map((u) => DB.prepare('INSERT OR IGNORE INTO members (chat_id,user_id,joined_at) VALUES (?,?,?)').bind(id, u.id, t));
    stmts.push(DB.prepare("INSERT INTO messages (chat_id,sender_id,type,body,created_at) VALUES (?,?,'system',?,?)")
      .bind(id, me.id, `${me.display_name} created the group "${name}"`, t));
    await DB.batch(stmts);
    return J({ id });
  }

  // ---------- /chats/:id/... ----------
  if (parts[0] === 'chats' && /^\d+$/.test(parts[1] || '')) {
    const id = parseInt(parts[1]);
    const sub = parts[2] || '';
    const member = await DB.prepare('SELECT m.last_read_id, c.is_group, c.dm_key FROM members m JOIN chats c ON c.id=m.chat_id WHERE m.chat_id=? AND m.user_id=?')
      .bind(id, me.id).first();
    if (!member) return err('You are not in this chat.', 403);
    const otherId = member.is_group ? null : +String(member.dm_key).split(':').find((x) => +x !== me.id);

    if (m === 'GET' && sub === '') {
      const chat = await DB.prepare('SELECT id,is_group,name,created_by FROM chats WHERE id=?').bind(id).first();
      const r = await DB.prepare(`SELECT u.id,u.username,u.display_name,u.avatar_key,u.last_seen,u.seen_privacy,u.public_key,u.deleted,
          EXISTS(SELECT 1 FROM padis p WHERE p.owner_id=u.id AND p.padi_id=?2) AS has_me,
          (SELECT nickname FROM padis p WHERE p.owner_id=?2 AND p.padi_id=u.id) AS nickname
        FROM members m JOIN users u ON u.id=m.user_id WHERE m.chat_id=?1 ORDER BY u.display_name`).bind(id, me.id).all();
      let blocked_by_me = false, blocked_me = false;
      if (otherId) {
        const bl = await DB.prepare('SELECT EXISTS(SELECT 1 FROM blocks WHERE blocker_id=?1 AND blocked_id=?2) AS a, EXISTS(SELECT 1 FROM blocks WHERE blocker_id=?2 AND blocked_id=?1) AS b')
          .bind(me.id, otherId).first();
        blocked_by_me = !!bl.a; blocked_me = !!bl.b;
      }
      const members = r.results.map((u) => ({
        id: u.id, username: u.username, display_name: u.display_name, nickname: u.nickname, public_key: u.public_key, deleted: !!u.deleted,
        avatar_key: blocked_me && u.id === otherId ? null : u.avatar_key,
        last_seen: u.id === me.id ? u.last_seen : blocked_me && u.id === otherId ? 0 : showSeen(u.last_seen, u.seen_privacy, u.has_me),
      }));
      return J({ chat, members, blocked_by_me, blocked_me, now: t });
    }

    if (m === 'GET' && sub === 'messages') {
      const after = parseInt(url.searchParams.get('after') || '0');
      const before = parseInt(url.searchParams.get('before') || '0');
      const since = parseInt(url.searchParams.get('since') || '0') || t;
      let q;
      if (after) q = DB.prepare(MSG_SELECT + ' WHERE m.chat_id=? AND m.id>? ORDER BY m.id ASC LIMIT 200').bind(id, after);
      else if (before) q = DB.prepare(MSG_SELECT + ' WHERE m.chat_id=? AND m.id<? ORDER BY m.id DESC LIMIT 50').bind(id, before);
      else q = DB.prepare(MSG_SELECT + ' WHERE m.chat_id=? ORDER BY m.id DESC LIMIT 50').bind(id);
      const stmts = [
        q,
        DB.prepare('SELECT user_id, last_read_id, MAX(delivered_id, last_read_id) AS delivered_id FROM members WHERE chat_id=? AND user_id<>?').bind(id, me.id),
        DB.prepare('SELECT u.display_name FROM members m JOIN users u ON u.id=m.user_id WHERE m.chat_id=? AND m.user_id<>? AND m.typing_until>?').bind(id, me.id, t),
        DB.prepare('SELECT message_id FROM deletions WHERE chat_id=? AND at>?').bind(id, since),
      ];
      if (otherId)
        stmts.push(DB.prepare(`SELECT u.last_seen,u.seen_privacy,
            EXISTS(SELECT 1 FROM padis p WHERE p.owner_id=u.id AND p.padi_id=?2) AS has_me,
            EXISTS(SELECT 1 FROM blocks b WHERE b.blocker_id=u.id AND b.blocked_id=?2) AS bl
          FROM users u WHERE u.id=?1`).bind(otherId, me.id));
      const res = await DB.batch(stmts);
      let rows = res[0].results;
      if (!after) rows = rows.reverse();
      const o = otherId ? res[4].results[0] : null;
      const reads = res[1].results;
      return J({
        messages: rows,
        reads,
        read_upto: reads.length ? Math.min(...reads.map((x) => x.last_read_id)) : 0,
        delivered_upto: reads.length ? Math.min(...reads.map((x) => x.delivered_id)) : 0,
        typing: res[2].results.map((x) => x.display_name),
        deleted: res[3].results.map((x) => x.message_id),
        seen: o ? (o.bl ? 0 : showSeen(o.last_seen, o.seen_privacy, o.has_me)) : 0,
        now: t,
      });
    }

    if (m === 'POST' && sub === 'messages' && !parts[3]) {
      if (otherId) {
        const bl = await DB.prepare('SELECT (SELECT deleted FROM users WHERE id=?2) AS gone, EXISTS(SELECT 1 FROM blocks WHERE (blocker_id=?1 AND blocked_id=?2) OR (blocker_id=?2 AND blocked_id=?1)) AS bl').bind(me.id, otherId).first();
        if (bl.gone) return err('This account was deleted.');
        if (bl.bl) return err("You can't send messages in this chat.");
      }
      const b = await body();
      let type = 'text', mediaKey = null;
      const text = isEnvelope(b.body) ? String(b.body).slice(0, 120000) : String(b.body || '').trim().slice(0, 4000);
      const stmts = [];
      if (b.type === 'image') {
        let mime, data;
        if (b.enc_data) {
          if (!B64.test(b.enc_data) || b.enc_data.length > 1800000) return err('That image is too large.');
          mime = 'application/octet-stream'; data = b.enc_data;
        } else {
          const img = parseImage(b.data);
          if (img.error) return err(img.error);
          mime = img.mime; data = img.b64;
        }
        type = 'image';
        mediaKey = randHex(16);
        stmts.push(DB.prepare('INSERT INTO media (key,mime,data,created_at) VALUES (?,?,?,?)').bind(mediaKey, mime, data, t));
      } else if (!text) return err('Type a message first.');
      const replyTo = parseInt(b.reply_to) || 0;
      stmts.push(DB.prepare('INSERT INTO messages (chat_id,sender_id,type,body,media_key,reply_to,created_at) VALUES (?,?,?,?,?,(SELECT id FROM messages WHERE id=? AND chat_id=?),?)')
        .bind(id, me.id, type, text, mediaKey, replyTo, id, t));
      stmts.push(DB.prepare('UPDATE chats SET last_msg_at=? WHERE id=?').bind(t, id));
      const res = await DB.batch(stmts);
      const msgId = res[stmts.length - 2].meta.last_row_id;
      const [msg] = await DB.batch([
        DB.prepare(MSG_SELECT + ' WHERE m.id=?').bind(msgId),
        DB.prepare('UPDATE members SET last_read_id=?, typing_until=0 WHERE chat_id=? AND user_id=?').bind(msgId, id, me.id),
      ]);
      waitUntil(pushToChat(DB, id, me.id, url.origin));
      return J({ message: msg.results[0] });
    }

    // Delete a message for everyone: /chats/:id/messages/:mid/delete
    if (m === 'POST' && sub === 'messages' && /^\d+$/.test(parts[3] || '') && parts[4] === 'delete') {
      const mid = +parts[3];
      const msg = await DB.prepare('SELECT sender_id,type,media_key FROM messages WHERE id=? AND chat_id=?').bind(mid, id).first();
      if (!msg || msg.sender_id !== me.id) return err('You can only delete your own messages.');
      if (msg.type === 'deleted' || msg.type === 'system') return J({ ok: true });
      const stmts = [
        DB.prepare("UPDATE messages SET type='deleted', body='', media_key=NULL WHERE id=?").bind(mid),
        DB.prepare('INSERT INTO deletions (chat_id,message_id,at) VALUES (?,?,?)').bind(id, mid, t),
      ];
      if (msg.media_key) stmts.push(DB.prepare('DELETE FROM media WHERE key=?').bind(msg.media_key));
      await DB.batch(stmts);
      return J({ ok: true });
    }

    if (m === 'POST' && sub === 'typing') {
      await DB.prepare('UPDATE members SET typing_until=? WHERE chat_id=? AND user_id=?').bind(t + 5000, id, me.id).run();
      return J({ ok: true });
    }

    if (m === 'POST' && sub === 'read') {
      const b = await body();
      const last = parseInt(b.last_id || 0);
      if (last > member.last_read_id)
        await DB.prepare('UPDATE members SET last_read_id=? WHERE chat_id=? AND user_id=? AND last_read_id<?').bind(last, id, me.id, last).run();
      return J({ ok: true });
    }

    if (m === 'POST' && sub === 'members') {
      if (!member.is_group) return err('You can only add people to groups.');
      const b = await body();
      const u = b.user_id
        ? await DB.prepare('SELECT id,display_name FROM users WHERE id=?').bind(parseInt(b.user_id)).first()
        : await DB.prepare('SELECT id,display_name FROM users WHERE username=?').bind(cleanUsername(b.username)).first();
      if (!u) return err('No one has that username.');
      const r = await DB.prepare('INSERT OR IGNORE INTO members (chat_id,user_id,joined_at) VALUES (?,?,?)').bind(id, u.id, t).run();
      if (!r.meta.changes) return err('They are already in the group.');
      await DB.batch([
        DB.prepare("INSERT INTO messages (chat_id,sender_id,type,body,created_at) VALUES (?,?,'system',?,?)").bind(id, me.id, `${me.display_name} added ${u.display_name}`, t),
        DB.prepare('UPDATE chats SET last_msg_at=? WHERE id=?').bind(t, id),
      ]);
      return J({ ok: true });
    }

    if (m === 'POST' && sub === 'leave') {
      if (!member.is_group) return err('You can only leave groups.');
      await DB.batch([
        DB.prepare('DELETE FROM members WHERE chat_id=? AND user_id=?').bind(id, me.id),
        DB.prepare("INSERT INTO messages (chat_id,sender_id,type,body,created_at) VALUES (?,?,'system',?,?)").bind(id, me.id, `${me.display_name} left`, t),
      ]);
      return J({ ok: true });
    }
  }

  return err('Not found', 404);
}
