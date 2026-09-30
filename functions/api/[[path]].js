// Chat app API — Cloudflare Pages Function. Needs a D1 binding named DB.

const J = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
const err = (msg, status = 400) => J({ error: msg }, status);
const now = () => Date.now();

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
    'SELECT u.id,u.username,u.display_name,u.last_seen FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?'
  ).bind(token).first();
  return u ? { ...u, token } : null;
}

const cleanUsername = (v) => String(v || '').trim().toLowerCase().replace(/^@/, '');

export async function onRequest({ request, env, params }) {
  try {
    if (!env.DB) return err('Database not connected. Add a D1 binding named DB.', 500);
    const parts = Array.isArray(params.path) ? params.path : params.path ? [params.path] : [];
    return await route(request, env.DB, parts);
  } catch (e) {
    return err('Server error: ' + e.message, 500);
  }
}

async function route(req, DB, parts) {
  const m = req.method;
  const url = new URL(req.url);
  const p = parts.join('/');
  const body = async () => {
    try { return await req.json(); } catch { return {}; }
  };
  const t = now();

  // ---------- Images (public, by random key) ----------
  if (m === 'GET' && parts[0] === 'media' && parts[1]) {
    const row = await DB.prepare('SELECT mime,data FROM media WHERE key=?').bind(parts[1]).first();
    if (!row) return new Response('Not found', { status: 404 });
    const bin = Uint8Array.from(atob(row.data), (c) => c.charCodeAt(0));
    return new Response(bin, {
      headers: { 'content-type': row.mime, 'cache-control': 'public, max-age=31536000, immutable' },
    });
  }

  // ---------- Register ----------
  if (m === 'POST' && p === 'register') {
    const b = await body();
    const username = cleanUsername(b.username);
    const display = String(b.display_name || '').trim().slice(0, 40) || username;
    const password = String(b.password || '');
    if (!/^[a-z0-9_]{3,20}$/.test(username)) return err('Username must be 3 to 20 letters, numbers or underscores.');
    if (password.length < 6) return err('Password must be at least 6 characters.');
    if (await DB.prepare('SELECT 1 FROM users WHERE username=?').bind(username).first()) return err('That username is taken.');
    const salt = randHex(16);
    const hash = await hashPass(password, salt);
    const r = await DB.prepare(
      'INSERT INTO users (username,display_name,pass_hash,salt,created_at,last_seen) VALUES (?,?,?,?,?,?)'
    ).bind(username, display, hash, salt, t, t).run();
    const id = r.meta.last_row_id;
    const token = await newSession(DB, id);
    return J({ token, user: { id, username, display_name: display } });
  }

  // ---------- Login ----------
  if (m === 'POST' && p === 'login') {
    const b = await body();
    const username = cleanUsername(b.username);
    const u = await DB.prepare('SELECT * FROM users WHERE username=?').bind(username).first();
    if (!u || (await hashPass(String(b.password || ''), u.salt)) !== u.pass_hash) return err('Wrong username or password.', 401);
    const token = await newSession(DB, u.id);
    return J({ token, user: { id: u.id, username: u.username, display_name: u.display_name } });
  }

  // ---------- Everything below needs login ----------
  const me = await getUser(DB, req);
  if (!me) return err('Please log in.', 401);
  // Update "last seen" at most once a minute (saves database writes)
  if (t - me.last_seen > 60000) await DB.prepare('UPDATE users SET last_seen=? WHERE id=?').bind(t, me.id).run();

  if (m === 'GET' && p === 'me') return J({ user: { id: me.id, username: me.username, display_name: me.display_name } });

  if (m === 'POST' && p === 'logout') {
    await DB.prepare('DELETE FROM sessions WHERE token=?').bind(me.token).run();
    return J({ ok: true });
  }

  if (m === 'POST' && p === 'profile') {
    const b = await body();
    const display = String(b.display_name || '').trim().slice(0, 40);
    if (!display) return err('Enter a name.');
    await DB.prepare('UPDATE users SET display_name=? WHERE id=?').bind(display, me.id).run();
    return J({ user: { id: me.id, username: me.username, display_name: display } });
  }

  // Search users by username
  if (m === 'GET' && p === 'users') {
    const q = cleanUsername(url.searchParams.get('q')).replace(/[%_]/g, '');
    if (q.length < 2) return J({ users: [] });
    const r = await DB.prepare(
      'SELECT id,username,display_name FROM users WHERE username LIKE ? AND id<>? ORDER BY username LIMIT 15'
    ).bind(q + '%', me.id).all();
    return J({ users: r.results });
  }

  // List my chats
  if (m === 'GET' && p === 'chats') {
    const r = await DB.prepare(`
      SELECT c.id, c.is_group, c.name, c.last_msg_at,
        (SELECT u.display_name FROM members m2 JOIN users u ON u.id=m2.user_id WHERE m2.chat_id=c.id AND m2.user_id<>?1 LIMIT 1) AS other_name,
        (SELECT u.username FROM members m2 JOIN users u ON u.id=m2.user_id WHERE m2.chat_id=c.id AND m2.user_id<>?1 LIMIT 1) AS other_username,
        (SELECT u.last_seen FROM members m2 JOIN users u ON u.id=m2.user_id WHERE m2.chat_id=c.id AND m2.user_id<>?1 LIMIT 1) AS other_seen,
        lm.id AS last_id, lm.type AS last_type, lm.body AS last_body, lm.sender_id AS last_sender,
        su.display_name AS last_sender_name,
        (SELECT COUNT(*) FROM messages mx WHERE mx.chat_id=c.id AND mx.id>mem.last_read_id AND mx.sender_id<>?1 AND mx.type<>'system') AS unread
      FROM members mem
      JOIN chats c ON c.id=mem.chat_id
      LEFT JOIN messages lm ON lm.id=(SELECT MAX(id) FROM messages WHERE chat_id=c.id)
      LEFT JOIN users su ON su.id=lm.sender_id
      WHERE mem.user_id=?1
      ORDER BY c.last_msg_at DESC LIMIT 100`).bind(me.id).all();
    return J({ chats: r.results, now: t });
  }

  // Start (or reopen) a 1-to-1 chat
  if (m === 'POST' && p === 'chats/direct') {
    const b = await body();
    const other = await DB.prepare('SELECT id FROM users WHERE username=?').bind(cleanUsername(b.username)).first();
    if (!other) return err('No one has that username.');
    if (other.id === me.id) return err("That's your own username.");
    const key = [me.id, other.id].sort((a, c) => a - c).join(':');
    const found = await DB.prepare('SELECT id FROM chats WHERE dm_key=?').bind(key).first();
    if (found) return J({ id: found.id });
    const r = await DB.prepare(
      'INSERT INTO chats (is_group,dm_key,created_by,created_at,last_msg_at) VALUES (0,?,?,?,?)'
    ).bind(key, me.id, t, t).run();
    const id = r.meta.last_row_id;
    await DB.batch([
      DB.prepare('INSERT OR IGNORE INTO members (chat_id,user_id,joined_at) VALUES (?,?,?)').bind(id, me.id, t),
      DB.prepare('INSERT OR IGNORE INTO members (chat_id,user_id,joined_at) VALUES (?,?,?)').bind(id, other.id, t),
    ]);
    return J({ id });
  }

  // Create a group
  if (m === 'POST' && p === 'chats/group') {
    const b = await body();
    const name = String(b.name || '').trim().slice(0, 50);
    if (!name) return err('Give the group a name.');
    const names = [...new Set((b.usernames || []).map(cleanUsername).filter(Boolean))].slice(0, 50);
    let users = [];
    if (names.length) {
      const r = await DB.prepare(
        `SELECT id FROM users WHERE username IN (${names.map(() => '?').join(',')})`
      ).bind(...names).all();
      users = r.results;
    }
    const cr = await DB.prepare(
      'INSERT INTO chats (is_group,name,created_by,created_at,last_msg_at) VALUES (1,?,?,?,?)'
    ).bind(name, me.id, t, t).run();
    const id = cr.meta.last_row_id;
    const stmts = [me, ...users].map((u) =>
      DB.prepare('INSERT OR IGNORE INTO members (chat_id,user_id,joined_at) VALUES (?,?,?)').bind(id, u.id, t)
    );
    stmts.push(
      DB.prepare("INSERT INTO messages (chat_id,sender_id,type,body,created_at) VALUES (?,?,'system',?,?)")
        .bind(id, me.id, `${me.display_name} created the group "${name}"`, t)
    );
    await DB.batch(stmts);
    return J({ id });
  }

  // ---------- /chats/:id/... ----------
  if (parts[0] === 'chats' && /^\d+$/.test(parts[1] || '')) {
    const id = parseInt(parts[1]);
    const sub = parts[2] || '';
    const member = await DB.prepare('SELECT last_read_id FROM members WHERE chat_id=? AND user_id=?').bind(id, me.id).first();
    if (!member) return err('You are not in this chat.', 403);

    // Chat details + members
    if (m === 'GET' && sub === '') {
      const chat = await DB.prepare('SELECT id,is_group,name,created_by FROM chats WHERE id=?').bind(id).first();
      const r = await DB.prepare(
        'SELECT u.id,u.username,u.display_name,u.last_seen FROM members m JOIN users u ON u.id=m.user_id WHERE m.chat_id=? ORDER BY u.display_name'
      ).bind(id).all();
      return J({ chat, members: r.results, now: t });
    }

    // Get messages
    if (m === 'GET' && sub === 'messages') {
      const after = parseInt(url.searchParams.get('after') || '0');
      const before = parseInt(url.searchParams.get('before') || '0');
      const base =
        'SELECT m.id,m.sender_id,m.type,m.body,m.media_key,m.created_at,u.display_name AS sender_name FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.chat_id=?';
      let rows;
      if (after) rows = (await DB.prepare(base + ' AND m.id>? ORDER BY m.id ASC LIMIT 200').bind(id, after).all()).results;
      else if (before) rows = (await DB.prepare(base + ' AND m.id<? ORDER BY m.id DESC LIMIT 50').bind(id, before).all()).results.reverse();
      else rows = (await DB.prepare(base + ' ORDER BY m.id DESC LIMIT 50').bind(id).all()).results.reverse();
      const o = await DB.prepare(
        'SELECT MIN(m.last_read_id) AS read_upto, MAX(u.last_seen) AS seen FROM members m JOIN users u ON u.id=m.user_id WHERE m.chat_id=? AND m.user_id<>?'
      ).bind(id, me.id).first();
      return J({ messages: rows, read_upto: o?.read_upto || 0, seen: o?.seen || 0, now: t });
    }

    // Send a message
    if (m === 'POST' && sub === 'messages') {
      const b = await body();
      let type = 'text', text = String(b.body || '').trim().slice(0, 4000), mediaKey = null;
      const stmts = [];
      if (b.type === 'image') {
        const mt = /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(b.data || '');
        if (!mt) return err('That image type is not supported.');
        if (mt[2].length > 1500000) return err('That image is too large.');
        type = 'image';
        mediaKey = randHex(16);
        stmts.push(DB.prepare('INSERT INTO media (key,mime,data,created_at) VALUES (?,?,?,?)').bind(mediaKey, mt[1], mt[2], t));
      } else if (!text) return err('Type a message first.');
      stmts.push(
        DB.prepare('INSERT INTO messages (chat_id,sender_id,type,body,media_key,created_at) VALUES (?,?,?,?,?,?)')
          .bind(id, me.id, type, text, mediaKey, t)
      );
      stmts.push(DB.prepare('UPDATE chats SET last_msg_at=? WHERE id=?').bind(t, id));
      const res = await DB.batch(stmts);
      const msgId = res[stmts.length - 2].meta.last_row_id;
      await DB.prepare('UPDATE members SET last_read_id=? WHERE chat_id=? AND user_id=? AND last_read_id<?').bind(msgId, id, me.id, msgId).run();
      return J({
        message: { id: msgId, sender_id: me.id, type, body: text, media_key: mediaKey, created_at: t, sender_name: me.display_name },
      });
    }

    // Mark as read
    if (m === 'POST' && sub === 'read') {
      const b = await body();
      const last = parseInt(b.last_id || 0);
      if (last > member.last_read_id)
        await DB.prepare('UPDATE members SET last_read_id=? WHERE chat_id=? AND user_id=? AND last_read_id<?').bind(last, id, me.id, last).run();
      return J({ ok: true });
    }

    // Add someone to a group
    if (m === 'POST' && sub === 'members') {
      const chat = await DB.prepare('SELECT is_group FROM chats WHERE id=?').bind(id).first();
      if (!chat.is_group) return err('You can only add people to groups.');
      const b = await body();
      const u = await DB.prepare('SELECT id,display_name FROM users WHERE username=?').bind(cleanUsername(b.username)).first();
      if (!u) return err('No one has that username.');
      const r = await DB.prepare('INSERT OR IGNORE INTO members (chat_id,user_id,joined_at) VALUES (?,?,?)').bind(id, u.id, t).run();
      if (!r.meta.changes) return err('They are already in the group.');
      await DB.batch([
        DB.prepare("INSERT INTO messages (chat_id,sender_id,type,body,created_at) VALUES (?,?,'system',?,?)")
          .bind(id, me.id, `${me.display_name} added ${u.display_name}`, t),
        DB.prepare('UPDATE chats SET last_msg_at=? WHERE id=?').bind(t, id),
      ]);
      return J({ ok: true });
    }

    // Leave a group
    if (m === 'POST' && sub === 'leave') {
      const chat = await DB.prepare('SELECT is_group FROM chats WHERE id=?').bind(id).first();
      if (!chat.is_group) return err('You can only leave groups.');
      await DB.batch([
        DB.prepare('DELETE FROM members WHERE chat_id=? AND user_id=?').bind(id, me.id),
        DB.prepare("INSERT INTO messages (chat_id,sender_id,type,body,created_at) VALUES (?,?,'system',?,?)")
          .bind(id, me.id, `${me.display_name} left`, t),
      ]);
      return J({ ok: true });
    }
  }

  return err('Not found', 404);
}
