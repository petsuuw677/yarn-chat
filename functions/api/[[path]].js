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
      (SELECT nickname FROM padis WHERE owner_id=?1 AND padi_id=u.id) AS
