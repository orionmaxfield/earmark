/* Daily use of paid features (reading a screenshot), so their cost can't run away: a limit per person and one for
   everyone together, both per UTC day. A slot is taken before the paid call and given back when the call never
   happened (the service was down or busy), so a failed attempt doesn't use up someone's day. */
export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS usage (
     email TEXT NOT NULL, day TEXT NOT NULL, kind TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (email, day, kind))`,
];
const today = () => new Date().toISOString().slice(0, 10);

// { ok, mine, all } — ok false when either limit is already reached (nothing is taken then)
export async function takeSlot(db, email, kind, perPerson, perDay) {
  const day = today();
  const row = await db.prepare(`SELECT
      COALESCE((SELECT n FROM usage WHERE email = ?1 AND day = ?2 AND kind = ?3), 0) AS mine,
      COALESCE((SELECT SUM(n) FROM usage WHERE day = ?2 AND kind = ?3), 0) AS everyone`).bind(email, day, kind).first();
  if (row.mine >= perPerson || row.everyone >= perDay) return { ok: false, mine: row.mine, all: row.everyone >= perDay };
  await db.prepare(`INSERT INTO usage (email, day, kind, n) VALUES (?1, ?2, ?3, 1)
    ON CONFLICT (email, day, kind) DO UPDATE SET n = n + 1`).bind(email, day, kind).run();
  return { ok: true, mine: row.mine + 1 };
}
export async function giveBack(db, email, kind) {
  await db.prepare("UPDATE usage SET n = MAX(0, n - 1) WHERE email = ?1 AND day = ?2 AND kind = ?3").bind(email, today(), kind).run();
}
