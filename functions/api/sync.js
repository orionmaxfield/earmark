import { json, touchUser } from "./_middleware.js";

/* POST /api/sync
   Body: { since: the last change number this device saw,
           changes: [{ kind, id, updated, deleted, data }] }   (at most 500)
   Each change is saved only if it's newer than what's stored for that record:
     - a later `updated` time wins;
     - a deletion always wins, and a deleted record stays deleted;
     - medals merge instead: the higher level from any device is kept, so levels never go down.
   Every saved write gets the next change number for this account. The reply holds every record
   whose change number is above `since`, plus the stored version of each record that was sent
   (so a device whose change lost learns what won), and `latest`, the number to send next time.
   Devices decide what's new by these numbers, never by their own clocks.
   The account row is created by the first request that sends changes; one that only reads leaves a
   deleted account deleted (its reply has created: null, so the device knows). */

const KINDS = new Set(["book", "session", "settings", "past-hours", "medal", "profile"]);
const MAX_BATCH = 500, PAGE = 1000, MAX_RECORD = 64 * 1024;
const ID = /^[A-Za-z0-9_.:-]{1,100}$/;
const keyOf = (kind, id) => `${kind}|${id}`;

// levels never go down: keep the higher level, and the earliest date each level was earned
function mergeMedal(a, b) {
  const at = [], aa = Array.isArray(a && a.at) ? a.at : [], bb = Array.isArray(b && b.at) ? b.at : [];
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
    const d = [aa[i], bb[i]].filter(x => typeof x === "string" && x).sort()[0];
    at[i] = d || null;
  }
  return { lv: Math.max(+(a && a.lv) || 0, +(b && b.lv) || 0), at };
}
const parse = t => { try { return JSON.parse(t); } catch { return null; } };
const out = r => ({ kind: r.kind, id: r.id, updated: r.updated, deleted: !!r.deleted, data: r.deleted ? null : parse(r.data), change: r.change });

export async function onRequestPost({ request, env, data }) {
  const email = data.email, db = env.DB, now = Date.now();
  let body;
  try { body = await request.json(); } catch { return json({ error: "That request couldn't be read." }, 400); }
  const since = Number.isSafeInteger(body && body.since) && body.since > 0 ? body.since : 0;
  const changes = Array.isArray(body && body.changes) ? body.changes : [];
  if (changes.length > MAX_BATCH) return json({ error: `Send at most ${MAX_BATCH} changes at a time.` }, 413);

  // check every change before saving any
  const incoming = new Map();
  for (const c of changes) {
    if (!c || !KINDS.has(c.kind) || typeof c.id !== "string" || !ID.test(c.id)) return json({ error: "A change has an unknown kind or id." }, 400);
    const deleted = c.deleted ? 1 : 0;
    if (!deleted && (!c.data || typeof c.data !== "object" || Array.isArray(c.data))) return json({ error: "A change has no data." }, 400);
    const text = deleted ? null : JSON.stringify(c.data);
    if (text && text.length > MAX_RECORD) return json({ error: "A record is too large." }, 413);
    // never later than the server's own clock, so a device whose clock runs ahead can't make its changes win later edits
    const updated = Math.min(Number.isFinite(c.updated) && c.updated > 0 ? Math.floor(c.updated) : 0, now);
    incoming.set(keyOf(c.kind, c.id), { kind: c.kind, id: c.id, updated, deleted, text });
  }
  const sentKeys = JSON.stringify([...incoming.keys()]);

  if (incoming.size) {
    await db.prepare(`INSERT INTO users (email, created, last_seen, seq) VALUES (?1, ?2, ?2, 0)
      ON CONFLICT (email) DO UPDATE SET last_seen = excluded.last_seen`).bind(email, new Date(now).toISOString()).run();
    const stored = new Map();
    const { results } = await db.prepare(`SELECT kind, id, data, updated, deleted FROM records
      WHERE email = ?1 AND kind || '|' || id IN (SELECT value FROM json_each(?2))`).bind(email, sentKeys).all();
    results.forEach(r => stored.set(keyOf(r.kind, r.id), r));
    const writes = [];
    for (const [k, c] of incoming) {
      const old = stored.get(k);
      if (!old) { writes.push(c); continue; }
      if (old.deleted) continue;                      // deleted stays deleted
      if (c.deleted) { writes.push(c); continue; }    // a deletion always wins
      if (c.kind === "medal") {
        const merged = JSON.stringify(mergeMedal(parse(old.data), parse(c.text)));
        if (merged !== old.data) writes.push({ ...c, text: merged, updated: Math.max(old.updated, c.updated) });
        continue;
      }
      if (c.updated > old.updated) writes.push(c);
    }
    if (writes.length) {
      // one transaction: reserve this many change numbers, then write every record with its own.
      // The same rules are checked again in SQL, so a write from another device that landed meanwhile isn't overwritten.
      await db.batch([
        db.prepare("UPDATE users SET seq = seq + ?2 WHERE email = ?1").bind(email, writes.length),
        db.prepare(`INSERT INTO records (email, kind, id, data, updated, deleted, change)
          SELECT ?1, json_extract(j.value, '$[0]'), json_extract(j.value, '$[1]'), json_extract(j.value, '$[2]'),
                 json_extract(j.value, '$[3]'), json_extract(j.value, '$[4]'),
                 (SELECT seq FROM users WHERE email = ?1) - ?3 + 1 + j.key
          FROM json_each(?2) AS j WHERE true
          ON CONFLICT (email, kind, id) DO UPDATE SET
            data = excluded.data, updated = excluded.updated, deleted = excluded.deleted, change = excluded.change
          WHERE records.deleted = 0 AND (excluded.deleted = 1 OR excluded.updated > records.updated
            OR (excluded.kind = 'medal' AND COALESCE(json_extract(excluded.data, '$.lv'), 0) >= COALESCE(json_extract(records.data, '$.lv'), 0)))`)
          .bind(email, JSON.stringify(writes.map(w => [w.kind, w.id, w.text, w.updated, w.deleted])), writes.length),
      ]);
    }
  } else await touchUser(db, email).run();

  // everything changed since `since`, oldest first, a page at a time
  const page = (await db.prepare(`SELECT kind, id, data, updated, deleted, change FROM records
    WHERE email = ?1 AND change > ?2 ORDER BY change LIMIT ?3`).bind(email, since, PAGE + 1).all()).results;
  const more = page.length > PAGE;
  if (more) page.length = PAGE;
  const latest = page.length ? page[page.length - 1].change : since;
  const records = new Map(page.map(r => [keyOf(r.kind, r.id), r]));
  if (incoming.size) {
    const { results } = await db.prepare(`SELECT kind, id, data, updated, deleted, change FROM records
      WHERE email = ?1 AND kind || '|' || id IN (SELECT value FROM json_each(?2))`).bind(email, sentKeys).all();
    results.forEach(r => records.set(keyOf(r.kind, r.id), r));
  }
  const user = await db.prepare("SELECT created FROM users WHERE email = ?1").bind(email).first();
  return json({ email, created: user ? user.created : null, now, latest, more, records: [...records.values()].map(out) });
}
