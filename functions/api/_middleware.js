/* Every request under /api/ comes through here first.

   The site sits behind Cloudflare Access, which signs each request with a token in the
   Cf-Access-Jwt-Assertion header. The token is checked properly here (its signature against
   Access's public keys, its audience, issuer and expiry) and the email inside it becomes the
   account. Nothing the app sends about who it is is ever trusted. A request without a valid
   token gets 401. Every query the endpoints run is limited to this verified email.

   Settings (Pages › Settings › Variables and Secrets, for Production and Preview):
     ACCESS_TEAM_DOMAIN  the Access team domain, e.g. myteam.cloudflareaccess.com
     ACCESS_AUD          the Access application's Audience (AUD) tag; several, comma separated,
                         when previews have their own Access application
   Binding: DB          the D1 database. Its tables are created on the first request. */

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
     email TEXT PRIMARY KEY,
     created TEXT NOT NULL,
     last_seen TEXT NOT NULL,
     seq INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS records (
     email TEXT NOT NULL,
     kind TEXT NOT NULL,
     id TEXT NOT NULL,
     data TEXT,
     updated INTEGER NOT NULL,
     deleted INTEGER NOT NULL DEFAULT 0,
     change INTEGER NOT NULL,
     PRIMARY KEY (email, kind, id))`,
  `CREATE INDEX IF NOT EXISTS records_by_change ON records (email, change)`,
];
let schemaReady = null;   // once per worker instance
function ensureSchema(db) {
  if (!schemaReady) schemaReady = db.batch(SCHEMA.map(s => db.prepare(s))).catch(err => { schemaReady = null; throw err; });
  return schemaReady;
}

export const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});

/* ---- Access token check ---- */
const b64url = s => {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - s.length % 4) % 4));
  return Uint8Array.from(b, c => c.charCodeAt(0));
};
const part = s => JSON.parse(new TextDecoder().decode(b64url(s)));
// "myteam.cloudflareaccess.com" or "https://myteam.cloudflareaccess.com/" → "https://myteam.cloudflareaccess.com"
const teamOrigin = d => new URL(/^https?:\/\//.test(d) ? d : `https://${d}`).origin;

let keyCache = { origin: null, at: 0, keys: new Map() };
async function signingKey(origin, kid) {
  const fresh = keyCache.origin === origin && Date.now() - keyCache.at < 60 * 60 * 1000;
  // fetch the keys when they're old, or when a new key appears (Access rotates them); at most once a minute
  if (!fresh || (!keyCache.keys.has(kid) && Date.now() - keyCache.at > 60 * 1000)) {
    const res = await fetch(`${origin}/cdn-cgi/access/certs`);
    if (!res.ok) throw new Error(`Access keys: ${res.status}`);
    const { keys = [] } = await res.json(), map = new Map();
    for (const k of keys) {
      if (k.kty !== "RSA" || !k.kid) continue;
      map.set(k.kid, await crypto.subtle.importKey("jwk", { kty: "RSA", n: k.n, e: k.e, alg: "RS256", ext: true },
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]));
    }
    keyCache = { origin, at: Date.now(), keys: map };
  }
  return keyCache.keys.get(kid) || null;
}

/* ACCESS_AUD: one Audience tag, or several (production and preview each have their own Access
   application). Separated by commas; spaces, line breaks and quotes around them are ignored. */
export const audiences = v => String(v || "").split(/[,;\s]+/).map(a => a.replace(/^["']+|["']+$/g, "")).filter(Boolean);

// { email } (verified, lowercased), or { reason } saying why the token was refused
async function verifiedEmail(request, env) {
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return { reason: "no-token" };
  const [h, p, s] = token.split(".");
  if (!h || !p || !s) return { reason: "bad-token" };
  let header, claims;
  try { header = part(h); claims = part(p); } catch { return { reason: "bad-token" }; }
  if (header.alg !== "RS256" || !header.kid) return { reason: "bad-token" };
  const origin = teamOrigin(env.ACCESS_TEAM_DOMAIN);
  const key = await signingKey(origin, header.kid);
  if (!key) return { reason: "unknown-key" };
  let ok = false;
  try { ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64url(s), new TextEncoder().encode(`${h}.${p}`)); } catch { ok = false; }
  if (!ok) return { reason: "bad-signature" };
  const now = Date.now() / 1000;
  const allowed = audiences(env.ACCESS_AUD);
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.some(a => allowed.includes(a))) return { reason: "wrong-audience" };
  if (typeof claims.exp !== "number" || claims.exp <= now) return { reason: "expired" };
  if (typeof claims.nbf === "number" && claims.nbf > now + 60) return { reason: "not-yet-valid" };
  if (typeof claims.iss !== "string" || claims.iss.replace(/\/+$/, "") !== origin) return { reason: "wrong-issuer" };
  const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
  return /^[^@\s]+@[^@\s]+$/.test(email) ? { email } : { reason: "no-email" };
}

export async function onRequest(context) {
  const { request, env } = context;
  if (!env.DB || !audiences(env.ACCESS_AUD).length || !env.ACCESS_TEAM_DOMAIN) return json({ error: "Sync isn't set up on the server yet." }, 503);
  let check;
  try { check = await verifiedEmail(request, env); } catch (err) { return json({ error: "Couldn't check your sign-in. Try again." }, 503); }
  // the reason (e.g. "wrong-audience") helps tell a sign-in that expired from a setting that's wrong; it reveals nothing about any account
  if (!check.email) return json({ error: "Sign in again to sync.", reason: check.reason }, 401);
  const email = check.email;
  context.data.email = email;
  try {
    await ensureSchema(env.DB);
    // the account row: created on the first request, last seen on every one
    await env.DB.prepare(`INSERT INTO users (email, created, last_seen, seq) VALUES (?1, ?2, ?2, 0)
      ON CONFLICT (email) DO UPDATE SET last_seen = excluded.last_seen`).bind(email, new Date().toISOString()).run();
    return await context.next();
  } catch (err) {
    console.error(err);
    return json({ error: "Something went wrong on the server." }, 500);
  }
}
