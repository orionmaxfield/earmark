import { json } from "../_middleware.js";
import { configure, isDown, audibleSearch, openLibrarySearch, googleSearch } from "./_sources.js";
import { relevant, matchKey } from "./_match.js";
import { saveBooks, findInLibrary } from "./_library.js";
import { cached } from "./_cache.js";

/* GET /api/books/search?q=…  Sources in order: Earmark's own book table, then Audible's catalog (exact runtimes),
   then Open Library, then Google Books (page counts, so the app estimates the length). When the table already has
   plenty of matches, no one else is asked; otherwise the first outside source with relevant results answers, after
   the table's own matches, and what it found is saved to the table. A source
   that's down or limiting us is skipped. Each source's answer to a search is kept for a few days, so the same
   search doesn't reach it again. */
const CHAIN = [["audible", audibleSearch, 7], ["openlibrary", openLibrarySearch, 3], ["googlebooks", googleSearch, 3]];   // days a search's answer is kept

export async function onRequestGet(ctx) {
  configure(ctx.env);
  const q = (new URL(ctx.request.url).searchParams.get("q") || "").trim().toLowerCase().replace(/\s+/g, " ").slice(0, 120);
  if (q.length < 2) return json({ results: [], source: null, tried: [] });
  const db = ctx.env.DB, tried = [];
  let own = [];
  try { own = await findInLibrary(db, q); tried.push({ src: "library", results: own.length }); } catch (err) { tried.push({ src: "library", error: err.message }); }
  if (own.length >= 8) return json({ results: own.slice(0, 25), source: "library", tried });
  for (const [src, fn, days] of CHAIN) {
    if (isDown(src)) { tried.push({ src, skipped: true }); continue; }
    try {
      const list = relevant(await cached(ctx, src, fn, q, days), q);
      tried.push({ src, results: list.length });
      if (!list.length) continue;
      ctx.waitUntil(saveBooks(db, list, src).catch(err => console.error("saving looked-up books", err)));   // the library grows
      // the table's books first; one the source also found gets anything the table didn't have yet (runtime, cover…)
      const ids = b => [b.asin, b.isbn, matchKey(b.t, b.author)].filter(Boolean), byId = new Map();
      list.forEach(b => ids(b).forEach(k => { if (!byId.has(k)) byId.set(k, b); }));
      const merged = own.map(b => { const x = ids(b).map(k => byId.get(k)).find(Boolean); return x ? { ...x, ...Object.fromEntries(Object.entries(b).filter(([, v]) => v != null && v !== "")), fromLibrary: true } : b; });
      const have = new Set(own.flatMap(ids));
      const more = list.filter(b => !ids(b).some(k => have.has(k)));
      return json({ results: [...merged, ...more].slice(0, 25), source: own.length ? `library+${src}` : src, tried });
    } catch (err) { tried.push({ src, error: err.message }); }
  }
  if (own.length) return json({ results: own, source: "library", tried });
  // nothing anywhere: "no matches" if a source answered, "search isn't working" if none could be reached
  return json({ results: [], source: null, tried, unavailable: tried.filter(t => t.src !== "library").every(t => t.skipped || t.error) });
}
