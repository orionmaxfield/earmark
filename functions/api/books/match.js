import { json } from "../_middleware.js";
import { configure, isDown, openLibrarySearch, googleSearch } from "./_sources.js";
import { matchKey, plain } from "./_match.js";
import { saveBooks, findBooks, fromRow, cleanIsbn } from "./_library.js";
import { cached } from "./_cache.js";

/* POST /api/books/match  { items: [{ t, author, isbn }] }  (at most 20)
   Books by title and author (and ISBN when there is one), for imports from Goodreads, StoryGraph and Libby, which
   have no Audible ASIN. Each is looked for in Earmark's book table (confirmed books only), then Open Library, then
   Google Books (a cover, and a page count for an estimate). A result is taken only when its title and author
   match, never just the first hit. Searches are cached like book search, and what's
   found is saved to the table.
   The answer lines up with the items: { books: [shape or null, …], retry: [indexes], sources }. Each request stays
   under the platform's limit on outside calls: a source is only tried while there's room for 3 more (cache read, the
   call, cache write; an answer from the cache uses 1), and books there was no room left to look for come back in
   `retry`, for the app to send again. */
const MAX = 20, CALLS = 45, PER_TRY = 3;
const str = (v, n) => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : null);
const titlePart = k => k.split("|")[0], last = s => (s || "").split(" ").pop();

// the result that is this book: the same title and first author, or the same title and author surname
function best(list, t, author) {
  const k = matchKey(t, author), au = last(k.split("|")[1]);
  return list.find(b => matchKey(b.t, b.author) === k)
    || list.find(b => { const bk = matchKey(b.t, b.author); return titlePart(bk) === titlePart(k) && (!au || last(bk.split("|")[1]) === au); })
    || null;
}

export async function onRequestPost(ctx) {
  const { request, env } = ctx;
  configure(env);
  let body; try { body = await request.json(); } catch { return json({ error: "That request couldn't be read." }, 400); }
  const raw = Array.isArray(body && body.items) ? body.items : [];
  if (raw.length > MAX) return json({ error: `Ask for at most ${MAX} books at a time.` }, 413);
  const items = raw.map(x => ({ t: str(x && x.t, 200), author: str(x && x.author, 200), isbn: cleanIsbn(x && x.isbn) }));
  const keys = items.map(x => (x.t ? matchKey(x.t, x.author) : null));
  const db = env.DB, out = items.map(() => null), sources = {}, save = { openlibrary: [], googlebooks: [] }, retry = [];

  const rows = (await findBooks(db, { isbns: items.map(x => x.isbn).filter(Boolean), keys: keys.filter(Boolean) })).filter(r => r.confirmed);
  items.forEach((x, i) => { const r = (x.isbn && rows.find(r => r.isbn === x.isbn)) || rows.find(r => r.match_key === keys[i]); if (r) out[i] = fromRow(r); });

  const CHAIN = [["openlibrary", openLibrarySearch, 3], ["googlebooks", googleSearch, 3]];
  const meter = { calls: 0 };
  for (let i = 0; i < items.length; i++) {
    const x = items[i];
    if (!x.t || out[i]) continue;   // the table already has it
    const q = `${titlePart(keys[i])} ${plain(String(x.author || "").split(",")[0])}`.trim().slice(0, 120);
    for (const [src, fn, days] of CHAIN) {
      if (isDown(src)) continue;
      if (meter.calls + PER_TRY > CALLS) { retry.push(i); break; }
      try {
        const b = best(await cached(ctx, src, fn, q, days, meter), x.t, x.author);
        if (b) { out[i] = b; save[src].push(b); sources[src] = (sources[src] || 0) + 1; break; }
      } catch (err) { sources[src + "Error"] = err.message; }
    }
  }
  for (const [src, list] of Object.entries(save)) if (list.length) await saveBooks(db, list, src).catch(err => console.error("saving matched books", err));
  return json({ books: out, retry, sources });
}
