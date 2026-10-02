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

async function newSession(DB, userId, device) {
  const token = randHex(32);
  await DB.prepare('INSERT INTO sessions (token,user_id,created_at,device,last_active) VALUES (?,?,?,?,?)')
    .bind(token, userId, now(), String(device || 'Unknown device').slice(0, 60), now()).run();
  return token;
}

async function getUser(DB, req) {
  const h = req.headers.get('authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token) return null;
  const u = await DB.prepare(
    'SELECT u.id,u.username,u.display_name,u.last_seen,u.about,u.avatar_key,u.seen_privacy,u.public_key,u.enc_priv,u.yarn_id,u.keep_archived,u.silence_unknown,u.created_at,s.last_active AS s_active FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND u.deleted=0'
  ).bind(token).first();
  return u ? { ...u, token } : null;
}

const cleanUsername = (v) => String(v || '').trim().toLowerCase().replace(/^@/, '');
const meOut = (u) => ({
  id: u.id, username: u.username, display_name: u.display_name,
  about: u.about || '', avatar_key: u.avatar_key || null, seen_privacy: u.seen_privacy || 'everyone',
  public_key: u.public_key || null,
  yarn_id: u.yarn_id || null,
  keep_archived: u.keep_archived === undefined || u.keep_archived === null ? true : !!u.keep_archived,
  silence_unknown: !!u.silence_unknown,
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

// Full profile of someone I'm already connected with (callers must check connectedTo first)
async function profileOf(DB, me, id) {
  const u = await DB.prepare(`SELECT u.id,u.yarn_id,u.display_name,u.about,u.avatar_key,u.last_seen,u.seen_privacy,u.public_key,u.deleted,
      (SELECT nickname FROM padis WHERE owner_id=?1 AND padi_id=u.id) AS nickname,
      EXISTS(SELECT 1 FROM padis WHERE owner_id=?1 AND padi_id=u.id) AS is_padi,
      EXISTS(SELECT 1 FROM padis WHERE owner_id=u.id AND padi_id=?1) AS has_me,
      EXISTS(SELECT 1 FROM blocks WHERE blocker_id=?1 AND blocked_id=u.id) AS blocked,
      EXISTS(SELECT 1 FROM blocks WHERE blocker_id=u.id AND blocked_id=?1) AS blocked_me
    FROM users u WHERE u.id=?2`).bind(me.id, id).first();
  if (!u) return null;
  return {
    id: u.id, username: null, yarn_id: u.deleted ? null : u.yarn_id || null, display_name: u.display_name, about: u.about || '',
    avatar_key: u.avatar_key || null, nickname: u.nickname || null,
    is_padi: !!u.is_padi, mutual: !!(u.is_padi && u.has_me), blocked: !!u.blocked,
    public_key: u.public_key || null, deleted: !!u.deleted,
    last_seen: u.blocked_me ? 0 : showSeen(u.last_seen, u.seen_privacy, u.has_me),
    avatar_key: u.blocked_me ? null : u.avatar_key || null,
  };
}


/* ---------- Schema upgrades: run automatically, safe to run again ---------- */
const SCHEMA_VERSION = 10;
let SCHEMA_OK = false;
async function ensureSchema(DB) {
  if (SCHEMA_OK) return;
  await DB.prepare('CREATE TABLE IF NOT EXISTS config (k TEXT PRIMARY KEY, v TEXT NOT NULL)').run();
  const v = await DB.prepare("SELECT v FROM config WHERE k='schema'").first();
  if (v && +v.v >= SCHEMA_VERSION) { SCHEMA_OK = true; return; }
  const cols = [
    ['users', 'yarn_id', 'TEXT'], ['users', 'link_token', 'TEXT'],
    ['users', 'keep_archived', 'INTEGER NOT NULL DEFAULT 1'], ['users', 'silence_unknown', 'INTEGER NOT NULL DEFAULT 0'],
    ['members', 'archived', 'INTEGER NOT NULL DEFAULT 0'], ['messages', 'hidden_for', 'INTEGER'], ['calls', 'silent', 'INTEGER NOT NULL DEFAULT 0'],
  ];
  for (const [tb, col, def] of cols) {
    const info = (await DB.prepare(`PRAGMA table_info(${tb})`).all()).results || [];
    if (!info.some((c) => c.name === col)) { try { await DB.prepare(`ALTER TABLE ${tb} ADD COLUMN ${col} ${def}`).run(); } catch {} }
  }
  for (const q of [
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_yarn_id ON users(yarn_id)',
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_link ON users(link_token)',
    'CREATE INDEX IF NOT EXISTS idx_messages_media ON messages(media_key)',
    'CREATE INDEX IF NOT EXISTS idx_vibes_media ON vibes(media_key)',
    'CREATE INDEX IF NOT EXISTS idx_members_chat_user ON members(chat_id, user_id)',
    'CREATE TABLE IF NOT EXISTS rate_limits (k TEXT NOT NULL, win INTEGER NOT NULL, n INTEGER NOT NULL DEFAULT 0, exp INTEGER NOT NULL, PRIMARY KEY (k, win))',
    'CREATE TABLE IF NOT EXISTS reports (id INTEGER PRIMARY KEY AUTOINCREMENT, reporter_id INTEGER NOT NULL, target_id INTEGER NOT NULL, chat_id INTEGER, reason TEXT NOT NULL, details TEXT, content TEXT, created_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT \'open\')',
  ]) await DB.prepare(q).run();
  await DB.prepare("INSERT INTO config (k,v) VALUES ('schema',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(String(SCHEMA_VERSION)).run();
  SCHEMA_OK = true;
}

/* ---------- Yarn IDs: random 12-digit contact addresses ---------- */
function randomDigits(n) {
  const out = [];
  while (out.length < n) {
    const buf = new Uint8Array(32);
    crypto.getRandomValues(buf);
    for (const b of buf) if (b < 250 && out.length < n) out.push(b % 10); // reject 250-255 so every digit is equally likely
  }
  return out.join('');
}
const cleanYarnId = (v) => String(v || '').replace(/[\s\-.]/g, '');
const fmtYarnId = (id) => (id ? String(id).replace(/(\d{4})(?=\d)/g, '$1 ') : null);
async function assignYarnId(DB, userId) {
  for (let i = 0; i < 8; i++) {
    try { await DB.prepare('UPDATE users SET yarn_id=? WHERE id=? AND yarn_id IS NULL').bind(randomDigits(12), userId).run(); }
    catch {} // a clash with an existing ID fails the unique index; just try another
    const row = await DB.prepare('SELECT yarn_id FROM users WHERE id=?').bind(userId).first();
    if (row && row.yarn_id) return row.yarn_id;
  }
  throw new Error('Could not create a Yarn ID. Please try again.');
}
async function backfillYarnIds(DB) {
  const r = await DB.prepare('SELECT id FROM users WHERE yarn_id IS NULL AND deleted=0 LIMIT 25').all();
  for (const u of r.results || []) { try { await assignYarnId(DB, u.id); } catch {} }
}
function randToken(bytes = 18) {
  const a = new Uint8Array(bytes); crypto.getRandomValues(a);
  return b64url(a);
}

/* ---------- Lookup tickets: proof that a metered lookup happened (signed, short-lived, tied to the viewer) ---------- */
async function serverSecret(DB) {
  let row = await DB.prepare("SELECT v FROM config WHERE k='ticket_secret'").first();
  if (!row) { await DB.prepare("INSERT OR IGNORE INTO config (k,v) VALUES ('ticket_secret',?)").bind(randToken(32)).run(); row = await DB.prepare("SELECT v FROM config WHERE k='ticket_secret'").first(); }
  return row.v;
}
async function hmac(secret, text) {
  const key = await crypto.subtle.importKey('raw', TE.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, TE.encode(text))));
}
async function makeTicket(DB, viewerId, targetId, t) {
  const exp = t + 30 * 60000;
  return `${targetId}.${exp}.${await hmac(await serverSecret(DB), `${viewerId}.${targetId}.${exp}`)}`;
}
async function readTicket(DB, viewerId, ticket, t) {
  const [target, exp, sig] = String(ticket || '').split('.');
  if (!/^\d+$/.test(target || '') || !/^\d+$/.test(exp || '') || +exp < t || !sig) return null;
  const want = await hmac(await serverSecret(DB), `${viewerId}.${target}.${exp}`);
  return want === sig ? +target : null;
}

/* ---------- Who counts as "connected" (share a chat, or I saved them as a padi) ---------- */
async function connectedTo(DB, meId, otherId) {
  if (!otherId || otherId === meId) return false;
  const r = await DB.prepare(`SELECT (EXISTS(SELECT 1 FROM members x JOIN members y ON y.chat_id=x.chat_id WHERE x.user_id=?1 AND y.user_id=?2)
      OR EXISTS(SELECT 1 FROM padis WHERE owner_id=?1 AND padi_id=?2)) AS ok`).bind(meId, otherId).first();
  return !!(r && r.ok);
}
// A target the caller may act on: either already connected, or reached through a valid lookup ticket
async function reachable(DB, me, b, t) {
  if (b.ticket) { const id = await readTicket(DB, me.id, b.ticket, t); return id ? { id, viaTicket: true } : null; }
  const id = parseInt(b.user_id);
  return (await connectedTo(DB, me.id, id)) ? { id, viaTicket: false } : null;
}
const blockedEither = async (DB, a, b) => !!(await DB.prepare('SELECT 1 FROM blocks WHERE (blocker_id=?1 AND blocked_id=?2) OR (blocker_id=?2 AND blocked_id=?1)').bind(a, b).first());
const hasBlocked = async (DB, blocker, blocked) => !!(await DB.prepare('SELECT 1 FROM blocks WHERE blocker_id=? AND blocked_id=?').bind(blocker, blocked).first());

/* ---------- Rate limits (per account and per network, enforced here on the server) ---------- */
const envInt = (env, k, d) => { const v = parseInt(env[k]); return Number.isFinite(v) && v >= 0 ? v : d; };
async function ipKey(req) { return 'ip:' + (await sha256Hex('yarn-rl|' + (req.headers.get('cf-connecting-ip') || 'unknown'))).slice(0, 20); }
async function rateCheck(DB, t, rules, bump = true) {
  for (const r of rules) {
    const win = Math.floor(t / r.ms);
    const row = await DB.prepare('SELECT n FROM rate_limits WHERE k=? AND win=?').bind(r.k, win).first();
    if (row && row.n >= r.max) return r;
  }
  if (bump) for (const r of rules) {
    const win = Math.floor(t / r.ms);
    await DB.prepare('INSERT INTO rate_limits (k,win,n,exp) VALUES (?,?,1,?) ON CONFLICT(k,win) DO UPDATE SET n=n+1').bind(r.k, win, (win + 1) * r.ms).run();
  }
  if (Math.random() < 0.02) await DB.prepare('DELETE FROM rate_limits WHERE exp<?').bind(t).run();
  return null;
}
async function rateBump(DB, t, rules) {
  for (const r of rules) {
    const win = Math.floor(t / r.ms);
    await DB.prepare('INSERT INTO rate_limits (k,win,n,exp) VALUES (?,?,1,?) ON CONFLICT(k,win) DO UPDATE SET n=n+1').bind(r.k, win, (win + 1) * r.ms).run();
  }
}
const HOUR = 3600000;
function lookupRules(env, me, ip, t) {
  const young = t - (me.created_at || 0) < 86400000; // brand-new accounts get half the allowance
  const lim = (k, d) => Math.max(1, Math.floor(envInt(env, k, d) / (young ? 2 : 1)));
  return {
    all: [
      { k: `lk:u:${me.id}:h`, ms: HOUR, max: lim('LOOKUP_LIMIT_HOUR', 30) },
      { k: `lk:u:${me.id}:d`, ms: 86400000, max: lim('LOOKUP_LIMIT_DAY', 100) },
      { k: `lk:${ip}:h`, ms: HOUR, max: envInt(env, 'LOOKUP_IP_LIMIT_HOUR', 300) }, // high: many people can share one network
    ],
    miss: [
      { k: `lkm:u:${me.id}:h`, ms: HOUR, max: lim('LOOKUP_MISS_LIMIT_HOUR', 10) },
      { k: `lkm:${ip}:h`, ms: HOUR, max: envInt(env, 'LOOKUP_MISS_IP_LIMIT_HOUR', 60) },
    ],
  };
}
function newChatRules(env, me, ip, t) {
  const young = t - (me.created_at || 0) < 86400000;
  return [
    { k: `nc:u:${me.id}:d`, ms: 86400000, max: Math.max(1, Math.floor(envInt(env, 'NEW_CHAT_LIMIT_DAY', 40) / (young ? 2 : 1))) },
    { k: `nc:${ip}:d`, ms: 86400000, max: envInt(env, 'NEW_CHAT_IP_LIMIT_DAY', 400) },
  ];
}
const TOO_MANY = 'Too many lookups right now. Please wait a while and try again.';
// The minimal card shown after a lookup: name and photo only
async function minimalProfile(DB, me, u, t) {
  const blockedMe = await hasBlocked(DB, u.id, me.id);
  const padi = await DB.prepare('SELECT 1 FROM padis WHERE owner_id=? AND padi_id=?').bind(me.id, u.id).first();
  return { id: u.id, display_name: u.display_name, avatar_key: blockedMe ? null : u.avatar_key || null, is_padi: !!padi, ticket: await makeTicket(DB, me.id, u.id, t) };
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
        WHERE m.chat_id=? AND ps.user_id<>? AND m.archived=0 AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.blocker_id=ps.user_id AND b.blocked_id=?)`)
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

// Videos and voice notes are encrypted on the phone, then stored in pieces (the database keeps up to ~2 MB per row)
const BLOB_TYPES = ['video', 'voice'];
const delBlob = (DB, key) => [
  DB.prepare('DELETE FROM blob_chunks WHERE key=?').bind(key),
  DB.prepare('DELETE FROM blobs WHERE key=?').bind(key),
];

/* ---------- Yarn AI: web search + model chain ---------- */
const AI_CHITCHAT = /^(hi+|hello+|hey+|hola|yo|sup|thanks?( you)?|thank u|thx|ok(ay)?|cool|nice|lol|lmao|wow|good (morning|afternoon|evening|night)|how far|how are you|wetin dey|you dey|bye|goodnight)\b[\s!.?,]*(\w+[\s!.?]*)?$/i;
const AI_FRESH = /\b(today|tonight|right now|currently|current|latest|recent(ly)?|news|breaking|this (week|month|year|weekend)|yesterday|tomorrow|202[4-9]|203\d|price|prices|rate|rates|exchange|naira|dollar|cedi|score|scores|fixture|fixtures|result|results|weather|forecast|who (is|are|won|wins)|president|governor|minister|ceo|election|trending|released?|launch(ed)?|stock|stocks|crypto|bitcoin|fuel|petrol|diesel|salary|jamb|waec|neco|schedule|opening hours|near me|how much|when (is|does|will|did)|where (can|do|to)|best .{2,40} in|top \d+|reviews?|vs\.?|versus|update|law|policy|tax|cbn|inec|nysc|visa|flight|ticket)\b/i;
const AI_TRANSFORM = /^(please |pls |abeg |kindly )?(translate|rewrite|rephrase|paraphrase|proofread|correct|fix|shorten|summari[sz]e|improve|polish|format|continue|write (me )?(a |an |the |my )?\w*( \w+)? ?(poem|song|story|joke|caption|bio|speech|prayer|letter|email|message|text|cv|resume|apology|toast|essay|script|slogan|tweet|post)|tell me a (joke|story|riddle)|code|debug|solve|calculate|what is \d|\d+\s*[-+*/x×÷^]\s*\d+)/i;
function shouldSearch(q) {
  const t = String(q || '').trim();
  if (t.length < 8 || AI_CHITCHAT.test(t)) return false;
  if (AI_FRESH.test(t)) return true;
  if (AI_TRANSFORM.test(t)) return false;
  const words = t.split(/\s+/).length;
  return words >= 3 && (/\?\s*$/.test(t) || /^(what|who|whom|whose|when|where|why|how|which|is|are|was|were|does|do|did|can|could|will|tell me|explain|give me|list|compare|define|meaning of|difference)\b/i.test(t));
}
function searchQuery(msgs) {
  const users = msgs.filter((m) => m.role === 'user');
  const last = (users[users.length - 1] || { content: '' }).content.trim();
  const prev = users.length > 1 ? users[users.length - 2].content.trim() : '';
  const q = last.split(/\s+/).length < 5 && prev ? prev.slice(0, 140) + ' ' + last : last;
  return q.replace(/\s+/g, ' ').slice(0, 300);
}
async function sha256Hex(text) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return [...h].map((x) => x.toString(16).padStart(2, '0')).join('');
}
// Live web search through Tavily. Results are cached for 3 hours under a hash (the question text itself is never stored).
async function webSearch(env, DB, q, t) {
  const key = 'web:' + (await sha256Hex(q.toLowerCase()));
  const hit = await DB.prepare('SELECT data FROM ai_cache WHERE k=? AND at>?').bind(key, t - 3 * 3600000).first();
  if (hit) { try { return JSON.parse(hit.data); } catch {} }
  const news = /\b(news|latest|breaking|headline|happened|today)\b/i.test(q);
  const r = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + env.TAVILY_API_KEY },
    body: JSON.stringify({ query: q, search_depth: 'basic', max_results: 5, topic: news ? 'news' : 'general', include_answer: false }),
    signal: AbortSignal.timeout(9000),
  });
  if (!r.ok) throw new Error('search ' + r.status);
  const d = await r.json();
  const results = (d.results || []).slice(0, 5)
    .map((x) => ({ title: String(x.title || '').slice(0, 120), url: String(x.url || ''), content: String(x.content || '').replace(/\s+/g, ' ').slice(0, 650) }))
    .filter((x) => /^https?:\/\//.test(x.url) && x.content);
  if (!results.length) return null;
  await DB.prepare('INSERT INTO ai_cache (k,data,at) VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET data=excluded.data, at=excluded.at').bind(key, JSON.stringify(results), t).run();
  if (Math.random() < 0.05) await DB.prepare('DELETE FROM ai_cache WHERE at<?').bind(t - 86400000).run();
  return results;
}
function aiSystem(me, t, results, canImages) {
  const when = new Date(t).toLocaleString('en-NG', { timeZone: 'Africa/Lagos', dateStyle: 'full', timeStyle: 'short' });
  let sys = `You are Yarn AI, a smart, honest and friendly assistant inside Yarn, a private chat app used mostly in Nigeria. The user is ${me.display_name}. Right now it is ${when} (Lagos time).\n\n`
    + `HOW TO ANSWER\n`
    + `- Accuracy comes first. Never invent facts, names, numbers, quotes, links or sources. If you are not sure, say so plainly.\n`
    + `- Think carefully before answering maths, logic, code and multi-step questions, and show the key steps.\n`
    + `- Be direct. Lead with the answer, then give useful detail. Keep simple answers short; go deeper only when the question needs it.\n`
    + `- Use short paragraphs, **bold** for key terms, and bullet or numbered lists when they help. Use code blocks for code.\n`
    + `- Assume a Nigerian context when it fits: ₦ for money, Nigerian places, laws and examples. If the user writes in Nigerian Pidgin, reply in Pidgin.\n`
    + `- You can only see this conversation, not the user's chats, contacts or files. ${canImages ? 'The app (not you) creates pictures when the user says "draw ..." or taps the 🎨 button, so if they want a picture, tell them to do that.' : 'Image creation is not available right now.'}\n`;
  if (results && results.length) {
    sys += `\nLIVE WEB RESULTS (fetched just now, newer than your training data):\n`
      + results.map((x, i) => `[${i + 1}] ${x.title}\n${x.url}\n${x.content}`).join('\n\n')
      + `\n\nUse these results to answer. Prefer them over your own memory when they conflict. Cite the sources you use with their number like [1] or [2] right after the claim. If the results disagree or do not answer the question, say that honestly instead of guessing. Do not print the list of links yourself; the app shows them.`;
  } else {
    sys += `\nNo live web results are available for this message. If the question depends on recent events, current prices, rates, scores, or anything you cannot verify, say you can't check live information right now and give your best general knowledge clearly marked as possibly outdated.`;
  }
  return sys;
}
function aiChain(env) {
  const big = [], small = [];
  if (env.AI_API_KEY) {
    const base = env.AI_API_URL || 'https://api.groq.com/openai/v1';
    String(env.AI_API_MODELS || 'openai/gpt-oss-120b,llama-3.3-70b-versatile').split(',').map((x) => x.trim()).filter(Boolean)
      .forEach((model) => big.push({ kind: 'openai', base, key: env.AI_API_KEY, model }));
    String(env.AI_API_FALLBACK || 'llama-3.1-8b-instant').split(',').map((x) => x.trim()).filter(Boolean)
      .forEach((model) => small.push({ kind: 'openai', base, key: env.AI_API_KEY, model }));
  }
  if (env.AI) {
    big.push({ kind: 'cf', model: env.AI_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8-fast' });
    small.push({ kind: 'cf', model: '@cf/meta/llama-3.1-8b-instruct-fast' }, { kind: 'cf', model: '@cf/meta/llama-3.2-3b-instruct' });
  }
  return [...big, ...small];
}
async function openStream(env, c, messages) {
  if (c.kind === 'cf') return env.AI.run(c.model, { messages, stream: true, max_tokens: 1200 });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const body = { model: c.model, messages, stream: true, max_tokens: 1400, temperature: 0.5 };
    if (/gpt-oss/i.test(c.model)) body.reasoning_effort = 'low';
    const r = await fetch(c.base.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + c.key }, body: JSON.stringify(body), signal: ctrl.signal,
    });
    if (!r.ok || !r.body) throw new Error('provider ' + r.status);
    return r.body;
  } finally { clearTimeout(timer); }
}
// Reads a streamed reply (OpenAI-style or Cloudflare-style) and hands over each piece of text
async function pumpStream(readable, onPiece) {
  const reader = readable.getReader(), dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += typeof value === 'string' ? value : dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let piece = '';
      try { const j = JSON.parse(data); piece = j.response ?? j.choices?.[0]?.delta?.content ?? ''; } catch {}
      if (typeof piece === 'string' && piece) await onPiece(piece);
    }
  }
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
    await ensureSchema(env.DB);
    return await route(request, env.DB, parts, waitUntil, env);
  } catch (e) {
    return err('Server error: ' + e.message, 500);
  }
}

async function route(req, DB, parts, waitUntil = (p) => p, env = {}) {
  const m = req.method;
  const url = new URL(req.url);
  const p = parts.join('/');
  const body = async () => { try { return await req.json(); } catch { return {}; } };
  const t = now();

  // ---------- Images: profile photos are public; chat and vibe media only for people allowed to see them ----------
  const canReadMedia = async (viewerId, key) => !!(await DB.prepare(`SELECT 1 FROM messages m JOIN members mb ON mb.chat_id=m.chat_id AND mb.user_id=?2
        WHERE m.media_key=?1 AND (m.hidden_for IS NULL OR m.hidden_for<>?2)
      UNION ALL SELECT 1 FROM vibes v WHERE v.media_key=?1 AND v.expires_at>?3 AND (v.user_id=?2 OR (
        EXISTS(SELECT 1 FROM padis WHERE owner_id=?2 AND padi_id=v.user_id) AND EXISTS(SELECT 1 FROM padis WHERE owner_id=v.user_id AND padi_id=?2)
        AND NOT EXISTS(SELECT 1 FROM blocks WHERE (blocker_id=?2 AND blocked_id=v.user_id) OR (blocker_id=v.user_id AND blocked_id=?2))))
      LIMIT 1`).bind(key, viewerId, t).first());
  if (m === 'GET' && parts[0] === 'media' && parts[1]) {
    const avatar = await DB.prepare('SELECT 1 FROM users WHERE avatar_key=? AND deleted=0').bind(parts[1]).first();
    if (!avatar) {
      const viewer = await getUser(DB, req);
      if (!viewer || !(await canReadMedia(viewer.id, parts[1]))) return new Response('Not found', { status: 404 });
    }
    const row = await DB.prepare('SELECT mime,data FROM media WHERE key=?').bind(parts[1]).first();
    if (!row) return new Response('Not found', { status: 404 });
    const bin = Uint8Array.from(atob(row.data), (c) => c.charCodeAt(0));
    return new Response(bin, { headers: { 'content-type': row.mime, 'cache-control': (avatar ? 'public' : 'private') + ', max-age=31536000, immutable' } });
  }

  // ---------- Big files (videos, voice notes): encrypted, and only for people allowed to see them ----------
  if (m === 'GET' && parts[0] === 'blob' && parts[1]) {
    const viewer = await getUser(DB, req);
    if (!viewer || !(await canReadMedia(viewer.id, parts[1]))) return err('Not found', 404);
    const cache = { 'cache-control': 'private, max-age=31536000, immutable' };
    if (parts[2] === undefined) {
      const b = await DB.prepare('SELECT chunks,size FROM blobs WHERE key=? AND done=1').bind(parts[1]).first();
      if (!b) return err('Not found', 404);
      return new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json', ...cache } });
    }
    const row = await DB.prepare('SELECT data FROM blob_chunks WHERE key=? AND n=?').bind(parts[1], parseInt(parts[2])).first();
    if (!row) return new Response('Not found', { status: 404 });
    return new Response(row.data, { headers: { 'content-type': 'text/plain', ...cache } });
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
    const yarnId = await assignYarnId(DB, id);
    const token = await newSession(DB, id, b.device);
    return J({ token, user: meOut({ id, username, display_name: display, public_key: b.public_key, yarn_id: yarnId, keep_archived: 1, silence_unknown: 0 }), enc_priv: b.enc_priv });
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
    if (!u.yarn_id) u.yarn_id = await assignYarnId(DB, u.id);
    const token = await newSession(DB, u.id, b.device);
    return J({ token, user: meOut(u), enc_priv: u.enc_priv || null });
  }

  // ---------- Everything below needs login ----------
  const me = await getUser(DB, req);
  if (!me) return err('Please log in.', 401);
  if (t - me.last_seen > 60000 || t - (me.s_active || 0) > 60000)
    await DB.batch([
      DB.prepare('UPDATE users SET last_seen=? WHERE id=?').bind(t, me.id),
      DB.prepare('UPDATE sessions SET last_active=? WHERE token=?').bind(t, me.token),
    ]);

  // ---------- Devices (logged-in sessions) ----------
  if (m === 'GET' && p === 'sessions') {
    const r = await DB.prepare('SELECT rowid AS id, device, created_at, last_active, token=? AS current FROM sessions WHERE user_id=? ORDER BY current DESC, last_active DESC').bind(me.token, me.id).all();
    return J({ sessions: r.results.map((x) => ({ ...x, current: !!x.current })), now: t });
  }
  if (m === 'POST' && p === 'sessions/revoke') {
    const b = await body();
    const all = !!b.others;
    const where = all ? 'user_id=? AND token<>?' : 'user_id=? AND rowid=? AND token<>?';
    const args = all ? [me.id, me.token] : [me.id, parseInt(b.id), me.token];
    await DB.batch([
      DB.prepare(`DELETE FROM push_subs WHERE token IN (SELECT token FROM sessions WHERE ${where})`).bind(...args),
      DB.prepare(`DELETE FROM sessions WHERE ${where}`).bind(...args),
    ]);
    return J({ ok: true });
  }

  if (m === 'GET' && p === 'me') {
    if (!me.yarn_id) me.yarn_id = await assignYarnId(DB, me.id);
    waitUntil(backfillYarnIds(DB).catch(() => {})); // gives IDs to older accounts that haven't signed in since the upgrade
    return J({ user: meOut(me), enc_priv: me.enc_priv || null });
  }

  // ---------- Find people by exact Yarn ID or profile link (metered) ----------
  if (m === 'GET' && p === 'users/lookup') {
    const id = cleanYarnId(url.searchParams.get('id'));
    if (!/^\d{12}$/.test(id)) return err('A Yarn ID has 12 digits. Check it and try again.');
    const rules = lookupRules(env, me, await ipKey(req), t);
    if (await rateCheck(DB, t, rules.miss, false)) return err(TOO_MANY, 429);
    if (await rateCheck(DB, t, rules.all)) return err(TOO_MANY, 429);
    if (id === me.yarn_id) return err("That's your own Yarn ID.");
    const u = await DB.prepare('SELECT id,display_name,avatar_key FROM users WHERE yarn_id=? AND deleted=0').bind(id).first();
    if (!u) { await rateBump(DB, t, rules.miss); return err('No account found with that Yarn ID. Check the number and try again.', 404); }
    return J({ user: await minimalProfile(DB, me, u, t) });
  }
  if (m === 'GET' && parts[0] === 'link' && parts[1]) {
    const tok = String(parts[1]);
    const rules = lookupRules(env, me, await ipKey(req), t);
    if (await rateCheck(DB, t, rules.miss, false)) return err(TOO_MANY, 429);
    if (await rateCheck(DB, t, rules.all)) return err(TOO_MANY, 429);
    const u = /^[A-Za-z0-9_-]{16,64}$/.test(tok) ? await DB.prepare('SELECT id,display_name,avatar_key FROM users WHERE link_token=? AND deleted=0').bind(tok).first() : null;
    if (!u) { await rateBump(DB, t, rules.miss); return err('This profile link is not valid any more. It may have been replaced. Ask for a new one.', 404); }
    if (u.id === me.id) return J({ self: true, user: { id: me.id, display_name: me.display_name, avatar_key: me.avatar_key || null } });
    return J({ user: await minimalProfile(DB, me, u, t) });
  }

  // ---------- My shareable profile link ----------
  if (p === 'profile/link' && m === 'GET') {
    const row = await DB.prepare('SELECT link_token FROM users WHERE id=?').bind(me.id).first();
    return J({ token: (row && row.link_token) || null });
  }
  if (p === 'profile/link' && m === 'POST') {
    const b = await body();
    if (b.action === 'off') { await DB.prepare('UPDATE users SET link_token=NULL WHERE id=?').bind(me.id).run(); return J({ token: null }); }
    for (let i = 0; i < 5; i++) {
      const tok = randToken(18);
      try { await DB.prepare('UPDATE users SET link_token=? WHERE id=?').bind(tok, me.id).run(); return J({ token: tok }); } catch {}
    }
    return err('Could not make a new link. Please try again.');
  }

  // ---------- Report someone (only the content the reporter chose to include) ----------
  if (m === 'POST' && p === 'reports') {
    const b = await body();
    const tgt = await reachable(DB, me, b, t);
    if (!tgt || tgt.id === me.id) return err('Could not send this report.');
    if (await rateCheck(DB, t, [{ k: `rp:u:${me.id}:d`, ms: 86400000, max: envInt(env, 'REPORT_LIMIT_DAY', 20) }])) return err('You have sent a lot of reports today. Please try again tomorrow.', 429);
    const reason = ['spam', 'harassment', 'scam', 'inappropriate', 'impersonation', 'other'].includes(b.reason) ? b.reason : 'other';
    const items = (Array.isArray(b.items) ? b.items : []).slice(0, 30).map((x) => ({
      id: parseInt(x.id) || null, type: String(x.type || 'text').slice(0, 12), from: String(x.from || '').slice(0, 60), at: parseInt(x.at) || null, text: String(x.text || '').slice(0, 2000),
    }));
    let chatId = parseInt(b.chat_id) || null;
    if (chatId && !(await DB.prepare('SELECT 1 FROM members WHERE chat_id=? AND user_id=?').bind(chatId, me.id).first())) chatId = null;
    const stmts = [DB.prepare('INSERT INTO reports (reporter_id,target_id,chat_id,reason,details,content,created_at) VALUES (?,?,?,?,?,?,?)')
      .bind(me.id, tgt.id, chatId, reason, String(b.details || '').slice(0, 1000), JSON.stringify(items), t)];
    if (b.block) stmts.push(DB.prepare('INSERT OR IGNORE INTO blocks (blocker_id,blocked_id,created_at) VALUES (?,?,?)').bind(me.id, tgt.id, t));
    await DB.batch(stmts);
    return J({ ok: true });
  }

  // ---------- Upload big files in pieces ----------
  if (m === 'POST' && p === 'blob/start') {
    const b = await body();
    const chunks = parseInt(b.chunks), size = parseInt(b.size);
    if (!chunks || chunks < 1 || chunks > 12 || !size || size > 23000000) return err('That file is too large. The limit is 16 MB.');
    const used = await DB.prepare('SELECT COALESCE(SUM(size),0) AS s FROM blobs WHERE owner_id=? AND created_at>?').bind(me.id, t - DAY).first();
    if (used.s + size > 200000000) return err('Daily upload limit reached. Try again tomorrow.');
    if (Math.random() < 0.05) {
      await DB.batch([
        DB.prepare('DELETE FROM blob_chunks WHERE key IN (SELECT key FROM blobs WHERE done=0 AND created_at<?)').bind(t - DAY),
        DB.prepare('DELETE FROM blobs WHERE done=0 AND created_at<?').bind(t - DAY),
      ]);
    }
    const key = randHex(16);
    await DB.prepare('INSERT INTO blobs (key,owner_id,size,chunks,done,created_at) VALUES (?,?,?,?,0,?)').bind(key, me.id, size, chunks, t).run();
    return J({ key });
  }
  if (m === 'POST' && parts[0] === 'blob' && parts[1] && /^\d+$/.test(parts[2] || '')) {
    const bl = await DB.prepare('SELECT owner_id,chunks FROM blobs WHERE key=?').bind(parts[1]).first();
    const n = parseInt(parts[2]);
    if (!bl || bl.owner_id !== me.id || n >= bl.chunks) return err('Upload not found.', 404);
    const data = await req.text();
    if (!data || data.length > 1950000) return err('Piece too large.');
    await DB.prepare('INSERT OR REPLACE INTO blob_chunks (key,n,data) VALUES (?,?,?)').bind(parts[1], n, data).run();
    const c = await DB.prepare('SELECT COUNT(*) AS c FROM blob_chunks WHERE key=?').bind(parts[1]).first();
    if (c.c >= bl.chunks) await DB.prepare('UPDATE blobs SET done=1 WHERE key=?').bind(parts[1]).run();
    return J({ ok: true, done: c.c >= bl.chunks });
  }

  // ---------- Yarn AI (Cloudflare Workers AI; chats are kept on the user's device, never stored here) ----------
  const AI_LIMIT = parseInt(env.AI_DAILY_LIMIT || '40');
  const today = new Date(t).toISOString().slice(0, 10);
  const IMG_LIMIT = parseInt(env.AI_IMAGE_LIMIT || '10');
  if (m === 'GET' && p === 'ai/usage') {
    const [u, im] = await DB.batch([
      DB.prepare('SELECT count FROM ai_usage WHERE user_id=? AND day=?').bind(me.id, today),
      DB.prepare('SELECT count FROM ai_usage WHERE user_id=? AND day=?').bind(me.id, 'img:' + today),
    ]);
    const chain = aiChain(env);
    return J({ enabled: chain.length > 0, web: !!env.TAVILY_API_KEY, images: !!env.AI, engine: chain[0] ? chain[0].model : null, used: u.results[0]?.count || 0, limit: AI_LIMIT, img_used: im.results[0]?.count || 0, img_limit: IMG_LIMIT });
  }
  // Create an image from a description
  if (m === 'POST' && p === 'ai/image') {
    if (!env.AI) return err('Yarn AI is not switched on yet. The app owner needs to add the Workers AI binding.', 503);
    const b = await body();
    const prompt = String(b.prompt || '').trim().slice(0, 600);
    if (prompt.length < 3) return err('Describe the image you want me to create.');
    if (/\b(nude|nudes|naked|nsfw|porn\w*|sex|sexy|sexual|explicit|topless|bottomless|lingerie|xxx|hentai|erotic\w*|fetish|gore|gory|beheading|dismember\w*|mutilat\w*)\b/i.test(prompt))
      return err("Yarn AI can't create that kind of image. Try describing something else. 🙏");
    const dayKey = 'img:' + today;
    const used = await DB.prepare('SELECT count FROM ai_usage WHERE user_id=? AND day=?').bind(me.id, dayKey).first();
    if (used && used.count >= IMG_LIMIT) return err(`You've made today's ${IMG_LIMIT} images. More tomorrow! 🎨`, 429);
    await DB.prepare('INSERT INTO ai_usage (user_id,day,count) VALUES (?,?,1) ON CONFLICT(user_id,day) DO UPDATE SET count=count+1').bind(me.id, dayKey).run();
    try {
      const out = await env.AI.run(env.AI_IMAGE_MODEL || '@cf/black-forest-labs/flux-1-schnell', { prompt, steps: 4 });
      if (out && out.image) return J({ image: 'data:image/jpeg;base64,' + out.image });
    } catch {}
    try {
      const png = await env.AI.run('@cf/bytedance/stable-diffusion-xl-lightning', { prompt });
      if (png) return new Response(png, { headers: { 'content-type': 'image/png', 'cache-control': 'no-store' } });
    } catch {}
    await DB.prepare('UPDATE ai_usage SET count=MAX(count-1,0) WHERE user_id=? AND day=?').bind(me.id, dayKey).run();
    return err("Couldn't create that image right now. Please try again in a minute.", 503);
  }
  if (m === 'POST' && p === 'ai/chat') {
    const chain = aiChain(env);
    if (!chain.length) return err('Yarn AI is not switched on yet. The app owner needs to add the AI key or the Workers AI binding.', 503);
    const b = await body();
    let msgs = (Array.isArray(b.messages) ? b.messages : []).slice(-16)
      .filter((x) => x && ['user', 'assistant'].includes(x.role) && typeof x.content === 'string' && x.content.trim())
      .map((x) => ({ role: x.role, content: x.content.slice(0, 4000) }));
    if (!msgs.length || msgs[msgs.length - 1].role !== 'user') return err('Ask a question first.');
    let total = 0;
    const keep = [];
    for (let k = msgs.length - 1; k >= 0; k--) { total += msgs[k].content.length; if (total > 9000 && keep.length) break; keep.unshift(msgs[k]); }
    msgs = keep;
    while (msgs.length && msgs[0].role !== 'user') msgs.shift();
    const used = await DB.prepare('SELECT count FROM ai_usage WHERE user_id=? AND day=?').bind(me.id, today).first();
    if (used && used.count >= AI_LIMIT) return err(`You've used today's ${AI_LIMIT} Yarn AI messages. They reset tomorrow. 🌙`, 429);
    await DB.prepare('INSERT INTO ai_usage (user_id,day,count) VALUES (?,?,1) ON CONFLICT(user_id,day) DO UPDATE SET count=count+1').bind(me.id, today).run();
    const wantWeb = b.web !== false && !!env.TAVILY_API_KEY;
    const WEB_LIMIT = parseInt(env.AI_SEARCH_LIMIT || '8');
    const { readable, writable } = new TransformStream();
    const w = writable.getWriter(), enc = new TextEncoder();
    const send = (o) => w.write(enc.encode('data: ' + (typeof o === 'string' ? o : JSON.stringify(o)) + '\n\n'));
    waitUntil((async () => {
      let sent = 0, results = null, notice = null;
      try {
        const q = searchQuery(msgs);
        if (wantWeb && shouldSearch(q)) {
          const wk = 'web:' + today;
          const wu = await DB.prepare('SELECT count FROM ai_usage WHERE user_id=? AND day=?').bind(me.id, wk).first();
          if (!wu || wu.count < WEB_LIMIT) {
            await send({ status: 'searching' });
            await DB.prepare('INSERT INTO ai_usage (user_id,day,count) VALUES (?,?,1) ON CONFLICT(user_id,day) DO UPDATE SET count=count+1').bind(me.id, wk).run();
            try { results = await webSearch(env, DB, q, t); } catch {}
            if (results) await send({ sources: results.map(({ title, url }) => ({ title, url })) });
            else notice = "I couldn't search the web for this one, so the answer may be out of date.";
          } else notice = "You've used today's web searches, so this answer comes from my own knowledge and may be out of date.";
        }
        const messages = [{ role: 'system', content: aiSystem(me, t, results, !!env.AI) }, ...msgs];
        for (const c of chain) {
          try {
            const stream = await openStream(env, c, messages);
            await pumpStream(stream, async (piece) => { sent += piece.length; await send({ response: piece }); });
            if (sent) { await send({ model: c.model }); break; }
          } catch { if (sent) break; }
        }
        if (!sent) {
          await DB.prepare('UPDATE ai_usage SET count=MAX(count-1,0) WHERE user_id=? AND day=?').bind(me.id, today).run();
          await send({ error: 'Yarn AI is busy right now. Please try again in a minute.' });
        } else if (notice) await send({ notice });
      } catch {} finally { try { await send('[DONE]'); await w.close(); } catch {} }
    })());
    return new Response(readable, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' } });
  }

  // ---------- Calls: 1-to-1 voice & video (WebRTC; audio/video flow phone-to-phone, encrypted) ----------
  if (m === 'GET' && p === 'calls/ice') {
    const stun = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];
    if (env.TURN_KEY_ID && env.TURN_KEY_API_TOKEN) {
      try {
        const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
          method: 'POST',
          headers: { authorization: 'Bearer ' + env.TURN_KEY_API_TOKEN, 'content-type': 'application/json' },
          body: JSON.stringify({ ttl: 86400 }),
        });
        if (r.ok) {
          const d = await r.json();
          const list = (d.iceServers || []).map((x) => ({ ...x, urls: [].concat(x.urls).filter((u) => !/:53(\?|$)/.test(u)) })).filter((x) => x.urls.length);
          if (list.length) return J({ iceServers: list, relay: true });
        }
      } catch {}
    }
    return J({ iceServers: stun, relay: false });
  }
  if (m === 'POST' && p === 'calls/start') {
    const b = await body();
    const chatId = parseInt(b.chat_id), kind = b.kind === 'video' ? 'video' : 'audio';
    const ch = await DB.prepare('SELECT c.is_group, c.dm_key FROM members m JOIN chats c ON c.id=m.chat_id WHERE m.chat_id=? AND m.user_id=?').bind(chatId, me.id).first();
    if (!ch) return err('Chat not found.');
    if (ch.is_group) return err('Calls work in 1-to-1 chats for now.');
    const other = +String(ch.dm_key).split(':').find((x) => +x !== me.id);
    const callee = await DB.prepare('SELECT deleted, silence_unknown FROM users WHERE id=?').bind(other).first();
    if (!callee || callee.deleted) return err('This account was deleted.');
    if (await hasBlocked(DB, me.id, other)) return err('You blocked this person. Unblock them to call.');
    // silent=2: they blocked the caller (never rings, never revealed). silent=1: they silence calls from people they haven't saved.
    let silent = 0;
    if (await hasBlocked(DB, other, me.id)) silent = 2;
    else if (callee.silence_unknown && !(await DB.prepare('SELECT 1 FROM padis WHERE owner_id=? AND padi_id=?').bind(other, me.id).first())) silent = 1;
    const r = await DB.prepare("INSERT INTO calls (chat_id,caller_id,callee_id,kind,status,created_at,silent) VALUES (?,?,?,?,'ringing',?,?)").bind(chatId, me.id, other, kind, t, silent).run();
    if (!silent) waitUntil(pushToUser(DB, other, url.origin));
    return J({ id: r.meta.last_row_id });
  }
  if (parts[0] === 'calls' && /^\d+$/.test(parts[1] || '')) {
    const cid = parseInt(parts[1]), sub = parts[2] || '';
    const call = await DB.prepare('SELECT * FROM calls WHERE id=?').bind(cid).first();
    if (!call || (call.caller_id !== me.id && call.callee_id !== me.id)) return err('Call not found.', 404);
    if (m === 'POST' && sub === 'signal') {
      const b = await body();
      if (!['offer', 'answer', 'ice'].includes(b.type)) return err('Bad signal.');
      const data = JSON.stringify(b.data || null);
      if (data.length > 60000) return err('Signal too large.');
      await DB.prepare('INSERT INTO call_signals (call_id,from_id,type,data,created_at) VALUES (?,?,?,?,?)').bind(cid, me.id, b.type, data, t).run();
      return J({ ok: true });
    }
    if (m === 'GET' && sub === 'signals') {
      const after = parseInt(url.searchParams.get('after') || '0');
      const r = await DB.prepare('SELECT id,type,data FROM call_signals WHERE call_id=? AND from_id<>? AND id>? ORDER BY id LIMIT 100').bind(cid, me.id, after).all();
      return J({ status: call.status, signals: r.results.map((x) => ({ id: x.id, type: x.type, data: JSON.parse(x.data) })) });
    }
    if (m === 'POST' && sub === 'answer') {
      if (call.callee_id !== me.id || call.status !== 'ringing' || call.silent === 2) return err('This call has ended.');
      await DB.prepare("UPDATE calls SET status='active', answered_at=? WHERE id=?").bind(t, cid).run();
      return J({ ok: true });
    }
    if (m === 'POST' && sub === 'end') {
      if (['ended', 'missed', 'declined'].includes(call.status)) return J({ ok: true });
      const b = await body();
      const status = call.status === 'active' ? 'ended' : me.id === call.callee_id && b.reason !== 'timeout' ? 'declined' : 'missed';
      const label = call.kind === 'video' ? 'video call' : 'voice call';
      const secs = call.answered_at ? Math.round((t - call.answered_at) / 1000) : 0;
      const text = status === 'ended' ? `📞 ${label[0].toUpperCase() + label.slice(1)} · ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`
        : status === 'declined' ? `📵 Declined ${label}` : `📵 Missed ${label}`;
      const hidden = call.silent === 2 ? call.callee_id : null; // a blocked caller's attempt is never shown to the person who blocked them
      const stmts = [
        DB.prepare('UPDATE calls SET status=?, ended_at=? WHERE id=?').bind(status, t, cid),
        DB.prepare('DELETE FROM call_signals WHERE call_id=?').bind(cid),
        DB.prepare("INSERT INTO messages (chat_id,sender_id,type,body,created_at,hidden_for) VALUES (?,?,'system',?,?,?)").bind(call.chat_id, call.caller_id, text, t, hidden),
      ];
      if (!hidden) stmts.push(DB.prepare('UPDATE chats SET last_msg_at=? WHERE id=?').bind(t, call.chat_id));
      await DB.batch(stmts);
      return J({ ok: true, status });
    }
  }

  // ---------- Push notifications ----------
  if (m === 'GET' && p === 'push/key') return J({ key: (await vapidKeys(DB)).pub });
  if (m === 'POST' && p === 'push/subscribe') {
    const b = await body();
    const ep = String(b.endpoint || ''), k = b.keys || {};
    if (!/^https:\/\//.test(ep) || ep.length > 1000) return err('Invalid subscription.');
    await DB.prepare('INSERT INTO push_subs (endpoint,user_id,p256dh,auth,created_at,token) VALUES (?,?,?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id, p256dh=excluded.p256dh, auth=excluded.auth, token=excluded.token')
      .bind(ep, me.id, String(k.p256dh || ''), String(k.auth || ''), t, me.token).run();
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
        (SELECT COUNT(*) FROM messages mx WHERE mx.chat_id=c.id AND mx.id>mem.last_read_id AND mx.sender_id<>?1 AND mx.type IN ('text','image','video','voice') AND (mx.hidden_for IS NULL OR mx.hidden_for<>?1)) AS unread
      FROM members mem JOIN chats c ON c.id=mem.chat_id
      JOIN messages m ON m.id=(SELECT MAX(id) FROM messages mx WHERE mx.chat_id=c.id AND mx.sender_id<>?1 AND mx.type IN ('text','image','video','voice') AND (mx.hidden_for IS NULL OR mx.hidden_for<>?1))
      JOIN users u ON u.id=m.sender_id
      WHERE mem.user_id=?1 AND mem.archived=0 AND m.id>mem.last_read_id
      ORDER BY m.id DESC LIMIT 5`).bind(me.id).all();
    await DB.prepare('UPDATE members SET delivered_id=(SELECT COALESCE(MAX(id),0) FROM messages WHERE chat_id=members.chat_id AND (hidden_for IS NULL OR hidden_for<>?1)) WHERE user_id=?1 AND delivered_id<(SELECT COALESCE(MAX(id),0) FROM messages WHERE chat_id=members.chat_id AND (hidden_for IS NULL OR hidden_for<>?1))').bind(me.id).run();
    const inc = await DB.prepare(`SELECT (SELECT json_object('id',cl.id,'kind',cl.kind,'chat_id',cl.chat_id,'caller_id',cl.caller_id,'display_name',cu.display_name,'username',NULL,'avatar_key',cu.avatar_key,
        'nick',(SELECT nickname FROM padis pp WHERE pp.owner_id=?1 AND pp.padi_id=cl.caller_id))
      FROM calls cl JOIN users cu ON cu.id=cl.caller_id WHERE cl.callee_id=?1 AND cl.status='ringing' AND cl.silent=0 AND cl.created_at>?2 ORDER BY cl.id DESC LIMIT 1) AS c`).bind(me.id, t - 45000).first();
    return J({ messages: r.results, call: inc && inc.c ? JSON.parse(inc.c) : null });
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
      DB.prepare("DELETE FROM media WHERE key IN (SELECT media_key FROM vibes WHERE user_id=? AND type='image')").bind(me.id),
      DB.prepare("DELETE FROM blob_chunks WHERE key IN (SELECT media_key FROM vibes WHERE user_id=? AND type='video')").bind(me.id),
      DB.prepare("DELETE FROM blobs WHERE key IN (SELECT media_key FROM vibes WHERE user_id=? AND type='video')").bind(me.id),
      DB.prepare('DELETE FROM vibes WHERE user_id=?').bind(me.id),
      DB.prepare('DELETE FROM media WHERE key=?').bind(me.avatar_key || '-'),
      DB.prepare("UPDATE users SET username=?,display_name='Deleted account',about='',avatar_key=NULL,pass_hash='',salt='',enc_priv=NULL,seen_privacy='nobody',link_token=NULL,deleted=1 WHERE id=?")
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
    const keep = b.keep_archived !== undefined ? (b.keep_archived ? 1 : 0) : (me.keep_archived === null || me.keep_archived === undefined ? 1 : me.keep_archived);
    const silence = b.silence_unknown !== undefined ? (b.silence_unknown ? 1 : 0) : me.silence_unknown || 0;
    if (!display) return err('Enter your name.');
    await DB.prepare('UPDATE users SET display_name=?,about=?,seen_privacy=?,keep_archived=?,silence_unknown=? WHERE id=?').bind(display, about, privacy, keep, silence, me.id).run();
    return J({ user: meOut({ ...me, display_name: display, about, seen_privacy: privacy, keep_archived: keep, silence_unknown: silence }) });
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
      DB.prepare('DELETE FROM push_subs WHERE user_id=? AND token IS NOT NULL AND token<>?').bind(me.id, me.token),
      DB.prepare('DELETE FROM sessions WHERE user_id=? AND token<>?').bind(me.id, me.token),
    ]);
    return J({ ok: true });
  }

  // ---------- Someone's full profile: only if we're already connected (shared chat or saved padi) ----------
  if (m === 'GET' && parts[0] === 'users' && /^\d+$/.test(parts[1] || '')) {
    const id = +parts[1];
    if (id !== me.id && !(await connectedTo(DB, me.id, id))) return err('User not found.', 404);
    const user = await profileOf(DB, me, id);
    if (!user) return err('User not found.', 404);
    return J({ user });
  }

  // ---------- Padis (saved contacts) ----------
  if (m === 'GET' && p === 'padis') {
    const r = await DB.prepare(`SELECT u.id,u.yarn_id,u.display_name,u.about,u.avatar_key,u.last_seen,u.seen_privacy,u.public_key,p.nickname,
        EXISTS(SELECT 1 FROM padis b WHERE b.owner_id=u.id AND b.padi_id=?1) AS mutual
      FROM padis p JOIN users u ON u.id=p.padi_id WHERE p.owner_id=?1
      ORDER BY LOWER(COALESCE(p.nickname,u.display_name))`).bind(me.id).all();
    const padis = r.results.map((u) => ({
      id: u.id, username: null, yarn_id: u.yarn_id || null, display_name: u.display_name, about: u.about || '', avatar_key: u.avatar_key,
      nickname: u.nickname, mutual: !!u.mutual, last_seen: showSeen(u.last_seen, u.seen_privacy, u.mutual), public_key: u.public_key,
    }));
    return J({ padis, now: t });
  }
  if (m === 'POST' && p === 'padis') {
    const b = await body();
    const tgt = await reachable(DB, me, b, t);
    const id = tgt ? tgt.id : 0;
    if (!id || id === me.id) return err('Add padis using their Yarn ID or profile link.');
    if (!(await DB.prepare('SELECT 1 FROM users WHERE id=? AND deleted=0').bind(id).first())) return err('User not found.');
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
    const r = await DB.prepare('SELECT u.id,NULL AS username,u.display_name,u.avatar_key FROM blocks b JOIN users u ON u.id=b.blocked_id WHERE b.blocker_id=? ORDER BY b.created_at DESC')
      .bind(me.id).all();
    return J({ users: r.results });
  }
  if (m === 'POST' && p === 'blocks') {
    const b = await body();
    const tgt = await reachable(DB, me, b, t);
    const id = tgt ? tgt.id : 0;
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
        DB.prepare("DELETE FROM media WHERE key IN (SELECT media_key FROM vibes WHERE expires_at<? AND type='image')").bind(t),
        DB.prepare("DELETE FROM blob_chunks WHERE key IN (SELECT media_key FROM vibes WHERE expires_at<? AND type='video')").bind(t),
        DB.prepare("DELETE FROM blobs WHERE key IN (SELECT media_key FROM vibes WHERE expires_at<? AND type='video')").bind(t),
        DB.prepare('DELETE FROM vibe_views WHERE vibe_id IN (SELECT id FROM vibes WHERE expires_at<?)').bind(t),
        DB.prepare('DELETE FROM vibes WHERE expires_at<?').bind(t),
      ]);
    }
    const [mine, feed] = await DB.batch([
      DB.prepare(`SELECT v.id,v.type,v.body,v.bg,v.media_key,v.created_at,
          (SELECT COUNT(*) FROM vibe_views vv WHERE vv.vibe_id=v.id) AS views
        FROM vibes v WHERE v.user_id=? AND v.expires_at>? ORDER BY v.id`).bind(me.id, t),
      DB.prepare(`SELECT v.id,v.user_id,v.type,v.body,v.bg,v.media_key,v.created_at,u.display_name,NULL AS username,u.avatar_key,u.public_key AS owner_key,p.nickname,
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
    if (b.type === 'video') {
      const bl = await DB.prepare('SELECT owner_id,done FROM blobs WHERE key=?').bind(String(b.blob_key || '')).first();
      if (!bl || bl.owner_id !== me.id || !bl.done) return err('The upload did not finish. Please try again.');
      type = 'video'; key = String(b.blob_key);
    } else if (b.type === 'image') {
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
    const v = await DB.prepare('SELECT id,user_id,type,media_key FROM vibes WHERE id=? AND expires_at>?').bind(vid, t).first();
    if (!v) return err('This vibe has expired.', 404);
    if (m === 'POST' && parts[2] === 'view') {
      if (v.user_id !== me.id && (await canSeeVibes(DB, me.id, v.user_id)))
        await DB.prepare('INSERT OR IGNORE INTO vibe_views (vibe_id,viewer_id,viewed_at) VALUES (?,?,?)').bind(vid, me.id, t).run();
      return J({ ok: true });
    }
    if (v.user_id !== me.id) return err('That is not your vibe.', 403);
    if (m === 'GET' && parts[2] === 'viewers') {
      const r = await DB.prepare('SELECT u.id,NULL AS username,u.display_name,u.avatar_key,vv.viewed_at FROM vibe_views vv JOIN users u ON u.id=vv.viewer_id WHERE vv.vibe_id=? ORDER BY vv.viewed_at DESC')
        .bind(vid).all();
      return J({ viewers: r.results });
    }
    if (m === 'POST' && parts[2] === 'delete') {
      const stmts = [
        DB.prepare('DELETE FROM vibe_views WHERE vibe_id=?').bind(vid),
        DB.prepare('DELETE FROM vibes WHERE id=?').bind(vid),
      ];
      if (v.media_key) {
        if (v.type === 'video') stmts.push(...delBlob(DB, v.media_key));
        else stmts.push(DB.prepare('DELETE FROM media WHERE key=?').bind(v.media_key));
      }
      await DB.batch(stmts);
      return J({ ok: true });
    }
  }

  // ---------- Chats ----------
  if (m === 'GET' && p === 'chats') {
    await DB.prepare('UPDATE members SET delivered_id=(SELECT COALESCE(MAX(id),0) FROM messages WHERE chat_id=members.chat_id AND (hidden_for IS NULL OR hidden_for<>?1)) WHERE user_id=?1 AND delivered_id<(SELECT COALESCE(MAX(id),0) FROM messages WHERE chat_id=members.chat_id AND (hidden_for IS NULL OR hidden_for<>?1))').bind(me.id).run();
    const r = await DB.prepare(`
      SELECT c.id, c.is_group, c.name, c.last_msg_at,
        o.id AS other_id, o.display_name AS other_name, NULL AS other_username, o.yarn_id AS other_yarn_id, o.last_seen AS other_seen, mem.archived AS archived,
        o.avatar_key AS other_avatar, o.seen_privacy AS other_privacy,
        EXISTS(SELECT 1 FROM padis p WHERE p.owner_id=o.id AND p.padi_id=?1) AS other_has_me,
        EXISTS(SELECT 1 FROM blocks bl WHERE bl.blocker_id=o.id AND bl.blocked_id=?1) AS other_blocked_me,
        (SELECT nickname FROM padis p WHERE p.owner_id=?1 AND p.padi_id=o.id) AS other_nick,
        lm.id AS last_id, lm.type AS last_type, lm.body AS last_body, lm.sender_id AS last_sender,
        su.display_name AS last_sender_name, su.public_key AS last_sender_key, o.deleted AS other_deleted,
        (SELECT MIN(mm.last_read_id) FROM members mm WHERE mm.chat_id=c.id AND mm.user_id<>?1) AS others_read,
        (SELECT MIN(MAX(mm.delivered_id, mm.last_read_id)) FROM members mm WHERE mm.chat_id=c.id AND mm.user_id<>?1) AS others_delivered,
        (SELECT COUNT(*) FROM messages mx WHERE mx.chat_id=c.id AND mx.id>mem.last_read_id AND mx.sender_id<>?1 AND mx.type NOT IN ('system','deleted') AND (mx.hidden_for IS NULL OR mx.hidden_for<>?1)) AS unread,
        (SELECT COUNT(*) FROM members mt WHERE mt.chat_id=c.id AND mt.user_id<>?1 AND mt.typing_until>?2 AND mt.user_id NOT IN (SELECT blocked_id FROM blocks WHERE blocker_id=?1)) AS typing
      FROM members mem
      JOIN chats c ON c.id=mem.chat_id
      LEFT JOIN users o ON c.is_group=0 AND o.id=(SELECT m2.user_id FROM members m2 WHERE m2.chat_id=c.id AND m2.user_id<>?1 LIMIT 1)
      LEFT JOIN messages lm ON lm.id=(SELECT MAX(id) FROM messages WHERE chat_id=c.id AND (hidden_for IS NULL OR hidden_for<>?1))
      LEFT JOIN users su ON su.id=lm.sender_id
      WHERE mem.user_id=?1
      ORDER BY c.last_msg_at DESC LIMIT 100`).bind(me.id, t).all();
    const inc = await DB.prepare(`SELECT (SELECT json_object('id',cl.id,'kind',cl.kind,'chat_id',cl.chat_id,'caller_id',cl.caller_id,'display_name',cu.display_name,'username',NULL,'avatar_key',cu.avatar_key,
        'nick',(SELECT nickname FROM padis pp WHERE pp.owner_id=?1 AND pp.padi_id=cl.caller_id))
      FROM calls cl JOIN users cu ON cu.id=cl.caller_id WHERE cl.callee_id=?1 AND cl.status='ringing' AND cl.silent=0 AND cl.created_at>?2 ORDER BY cl.id DESC LIMIT 1) AS c`).bind(me.id, t - 45000).first();
    const chats = r.results.map((c) => {
      c.other_seen = c.other_blocked_me ? 0 : showSeen(c.other_seen, c.other_privacy, c.other_has_me);
      if (c.other_blocked_me) c.other_avatar = null;
      c.other_yarn_id = c.other_deleted ? null : c.other_yarn_id;
      c.archived = !!c.archived;
      delete c.other_privacy; delete c.other_has_me; delete c.other_blocked_me;
      return c;
    });
    return J({ chats, now: t, incoming: inc && inc.c ? JSON.parse(inc.c) : null });
  }

  if (m === 'POST' && p === 'chats/direct') {
    const b = await body();
    const tgt = await reachable(DB, me, b, t);
    if (!tgt) return err('Start a chat using their Yarn ID or profile link.', 404);
    const other = await DB.prepare('SELECT id,deleted FROM users WHERE id=?').bind(tgt.id).first();
    if (!other || other.deleted) return err('No account found with that Yarn ID.');
    if (other.id === me.id) return err("That's your own Yarn ID.");
    const key = [me.id, other.id].sort((a, c) => a - c).join(':');
    const found = await DB.prepare('SELECT id FROM chats WHERE dm_key=?').bind(key).first();
    if (found) {
      await DB.prepare('INSERT OR IGNORE INTO members (chat_id,user_id,joined_at) VALUES (?,?,?)').bind(found.id, me.id, t).run();
      return J({ id: found.id });
    }
    // Starting a conversation with someone new is limited per account and per network. No approval is needed.
    if (!(await connectedTo(DB, me.id, other.id)) && (await rateCheck(DB, t, newChatRules(env, me, await ipKey(req), t))))
      return err("You've started a lot of new chats today. Please try again later.", 429);
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
    const users = [], seen = new Set([me.id]);
    for (const uid of ids) {
      if (seen.has(uid)) continue;
      if ((await connectedTo(DB, me.id, uid)) && !(await hasBlocked(DB, uid, me.id)) && (await DB.prepare('SELECT 1 FROM users WHERE id=? AND deleted=0').bind(uid).first())) { users.push({ id: uid }); seen.add(uid); }
    }
    // People found by Yarn ID or profile link (signed lookup tickets); adding someone new counts toward the new-contact limit
    for (const tk of (Array.isArray(b.tickets) ? b.tickets : []).slice(0, 50)) {
      const uid = await readTicket(DB, me.id, tk, t);
      if (!uid || seen.has(uid) || (await hasBlocked(DB, uid, me.id)) || !(await DB.prepare('SELECT 1 FROM users WHERE id=? AND deleted=0').bind(uid).first())) continue;
      if (!(await connectedTo(DB, me.id, uid)) && (await rateCheck(DB, t, newChatRules(env, me, await ipKey(req), t)))) return err("You've added a lot of new people today. Please try again later.", 429);
      users.push({ id: uid }); seen.add(uid);
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
      const r = await DB.prepare(`SELECT u.id,CASE WHEN u.id=?2 THEN u.username END AS username,u.display_name,u.avatar_key,u.last_seen,u.seen_privacy,u.public_key,u.deleted,
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
      const arch = await DB.prepare('SELECT archived FROM members WHERE chat_id=? AND user_id=?').bind(id, me.id).first();
      return J({ chat, members, blocked_by_me, blocked_me: false, archived: !!(arch && arch.archived), now: t });
    }

    if (m === 'GET' && sub === 'messages') {
      const after = parseInt(url.searchParams.get('after') || '0');
      const before = parseInt(url.searchParams.get('before') || '0');
      const since = parseInt(url.searchParams.get('since') || '0') || t;
      let q;
      const vis = ' AND (m.hidden_for IS NULL OR m.hidden_for<>?)';
      if (after) q = DB.prepare(MSG_SELECT + ' WHERE m.chat_id=? AND m.id>?' + vis + ' ORDER BY m.id ASC LIMIT 200').bind(id, after, me.id);
      else if (before) q = DB.prepare(MSG_SELECT + ' WHERE m.chat_id=? AND m.id<?' + vis + ' ORDER BY m.id DESC LIMIT 50').bind(id, before, me.id);
      else q = DB.prepare(MSG_SELECT + ' WHERE m.chat_id=?' + vis + ' ORDER BY m.id DESC LIMIT 50').bind(id, me.id);
      const stmts = [
        q,
        DB.prepare('SELECT user_id, last_read_id, MAX(delivered_id, last_read_id) AS delivered_id FROM members WHERE chat_id=? AND user_id<>?').bind(id, me.id),
        DB.prepare('SELECT u.display_name FROM members m JOIN users u ON u.id=m.user_id WHERE m.chat_id=? AND m.user_id<>? AND m.typing_until>? AND m.user_id NOT IN (SELECT blocked_id FROM blocks WHERE blocker_id=?)').bind(id, me.id, t, me.id),
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
      let hiddenFor = null;
      if (otherId) {
        const o = await DB.prepare('SELECT deleted FROM users WHERE id=?').bind(otherId).first();
        if (!o || o.deleted) return err('This account was deleted.');
        if (await hasBlocked(DB, me.id, otherId)) return err('You blocked this person. Unblock them to send messages.');
        // If they blocked me, the message is kept on my side only. It is never delivered or shown to them.
        if (await hasBlocked(DB, otherId, me.id)) hiddenFor = otherId;
      }
      const b = await body();
      let type = 'text', mediaKey = null;
      const text = isEnvelope(b.body) ? String(b.body).slice(0, 120000) : String(b.body || '').trim().slice(0, 4000);
      const stmts = [];
      if (BLOB_TYPES.includes(b.type)) {
        const bl = await DB.prepare('SELECT owner_id,done FROM blobs WHERE key=?').bind(String(b.blob_key || '')).first();
        if (!bl || bl.owner_id !== me.id || !bl.done) return err('The upload did not finish. Please try again.');
        type = b.type; mediaKey = String(b.blob_key);
      } else if (b.type === 'image') {
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
      stmts.push(DB.prepare('INSERT INTO messages (chat_id,sender_id,type,body,media_key,reply_to,created_at,hidden_for) VALUES (?,?,?,?,?,(SELECT id FROM messages WHERE id=? AND chat_id=?),?,?)')
        .bind(id, me.id, type, text, mediaKey, replyTo, id, t, hiddenFor));
      const msgIdx = stmts.length - 1;
      if (!hiddenFor) {
        stmts.push(DB.prepare('UPDATE chats SET last_msg_at=? WHERE id=?').bind(t, id));
        // People who turned off "Keep chats archived" get this chat back in their main list
        stmts.push(DB.prepare('UPDATE members SET archived=0 WHERE chat_id=? AND user_id<>? AND archived=1 AND user_id IN (SELECT id FROM users WHERE keep_archived=0)').bind(id, me.id));
      }
      const res = await DB.batch(stmts);
      const msgId = res[msgIdx].meta.last_row_id;
      const [msg] = await DB.batch([
        DB.prepare(MSG_SELECT + ' WHERE m.id=?').bind(msgId),
        DB.prepare('UPDATE members SET last_read_id=?, typing_until=0 WHERE chat_id=? AND user_id=?').bind(msgId, id, me.id),
      ]);
      if (!hiddenFor) waitUntil(pushToChat(DB, id, me.id, url.origin));
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
      if (msg.media_key) {
        if (BLOB_TYPES.includes(msg.type)) stmts.push(...delBlob(DB, msg.media_key));
        else stmts.push(DB.prepare('DELETE FROM media WHERE key=?').bind(msg.media_key));
      }
      await DB.batch(stmts);
      return J({ ok: true });
    }

    if (m === 'POST' && sub === 'archive') {
      const b = await body();
      await DB.prepare('UPDATE members SET archived=? WHERE chat_id=? AND user_id=?').bind(b.archived ? 1 : 0, id, me.id).run();
      return J({ ok: true, archived: !!b.archived });
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
      const tgt = await reachable(DB, me, b, t);
      const u = tgt ? await DB.prepare('SELECT id,display_name FROM users WHERE id=? AND deleted=0').bind(tgt.id).first() : null;
      if (!u || (await hasBlocked(DB, u.id, me.id))) return err("Couldn't add this person.");
      if (tgt.viaTicket && !(await connectedTo(DB, me.id, u.id)) && (await rateCheck(DB, t, newChatRules(env, me, await ipKey(req), t))))
        return err("You've added a lot of new people today. Please try again later.", 429);
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
