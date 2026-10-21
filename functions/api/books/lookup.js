import { json } from "../_middleware.js";
import { configure, isDown, audibleByAsins, audnexusBook } from "./_sources.js";
import { saveBooks, findBooks, fromRow, cleanAsin } from "./_library.js";

/* POST /api/books/lookup  { asins: [...] }  (at most 100)
   Books by Audible ASIN, for imports: from Earmark's book table first; any it doesn't know (or knows without a
   runtime or cover) from Audible's catalog, 50 at a time; any still missing from Audnexus, a few per request and
   spaced out. What's found is saved, so the next import of the same books is answered from the table. */
const AUDNEXUS_PER_REQUEST = 5;   // Audnexus is a community service: a few per request, spaced out

export async function onRequestPost({ request, env }) {
  configure(env);
  let body; try { body = await request.json(); } catch { return json({ error: "That request couldn't be read." }, 400); }
  const asins = [...new Set((Array.isArray(body && body.asins) ? body.asins : []).map(cleanAsin).filter(Boolean))];
  if (asins.length > 100) return json({ error: "Ask for at most 100 books at a time." }, 413);
  const found = new Map(), complete = b => b.minutes && b.cover;
  (await findBooks(env.DB, { asins })).forEach(r => { if (r.asin) found.set(r.asin, fromRow(r)); });
  const sources = {};
  let need = asins.filter(a => !found.has(a) || !complete(found.get(a)));
  for (let i = 0; i < need.length && !isDown("audible"); i += 50) {
    try {
      const got = await audibleByAsins(need.slice(i, i + 50));
      sources.audible = (sources.audible || 0) + got.length;
      if (got.length) { await saveBooks(env.DB, got, "audible"); got.forEach(b => found.set(b.asin, { ...found.get(b.asin), ...b })); }
    } catch (err) { sources.audibleError = err.message; break; }
  }
  need = asins.filter(a => !found.has(a) || !complete(found.get(a))).slice(0, AUDNEXUS_PER_REQUEST);
  for (const a of need) {
    if (isDown("audnexus")) break;
    try { const b = await audnexusBook(a); if (b) { sources.audnexus = (sources.audnexus || 0) + 1; await saveBooks(env.DB, [b], "audnexus"); found.set(a, { ...found.get(a), ...b }); } }
    catch (err) { sources.audnexusError = err.message; break; }
  }
  return json({ books: Object.fromEntries([...found].filter(([a]) => asins.includes(a))), missing: asins.filter(a => !found.has(a)), sources });
}
