import { json } from "../_middleware.js";
import { configure, isDown, audibleSearch, openLibrarySearch } from "./_sources.js";
import { matchKey, plain } from "./_match.js";
import { saveBooks, findBooks, fromRow, cleanIsbn } from "./_library.js";
import { cached } from "./_cache.js";

/* POST /api/books/match  { items: [{ t, author, isbn }] }  (at most 20)
   Books by title and author (and ISBN when there is one), for imports from Goodreads, StoryGraph and Libby, which
   have no Audible ASIN. Each is looked for in Earmark's book table (confirmed books only), then in Audible's catalog
   (an exact runtime), then in Open Library (a page count, for an estimate). A result is taken only when its title
   and author match, never just the first hit. Searches are cached like book search, and what's found is saved to
   the table. The answer lines up with the items: { books: [shape or null, …], sources }.
   At most 20 a request keeps each request under the platform's limit on outside calls. */
const MAX = 20;
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
  const db = env.DB, out = items.map(() => null), sources = {}, save = { audible: [], openlibrary: [] };

  const rows = (await findBooks(db, { isbns: items.map(x => x.isbn).filter(Boolean), keys: keys.filter(Boolean) })).filter(r => r.confirmed);
  items.forEach((x, i) => { const r = (x.isbn && rows.find(r => r.isbn === x.isbn)) || rows.find(r => r.match_key === keys[i]); if (r) out[i] = fromRow(r); });

  for (let i = 0; i < items.length; i++) {
    const x = items[i];
    if (!x.t || (out[i] && out[i].minutes)) continue;
    const q = `${titlePart(keys[i])} ${plain(String(x.author || "").split(",")[0])}`.trim().slice(0, 120);
    if (!isDown("audible")) {
      try {
        const b = best(await cached(ctx, "audible", audibleSearch, q, 7), x.t, x.author);
        if (b) { out[i] = { ...(out[i] || {}), ...b }; save.audible.push(b); sources.audible = (sources.audible || 0) + 1; continue; }
      } catch (err) { sources.audibleError = err.message; }
    }
    if (!out[i] && !isDown("openlibrary")) {
      try {
        const b = best(await cached(ctx, "openlibrary", openLibrarySearch, q, 3), x.t, x.author);
        if (b) { out[i] = b; save.openlibrary.push(b); sources.openlibrary = (sources.openlibrary || 0) + 1; }
      } catch (err) { sources.openlibraryError = err.message; }
    }
  }
  for (const [src, list] of Object.entries(save)) if (list.length) await saveBooks(db, list, src).catch(err => console.error("saving matched books", err));
  return json({ books: out, sources });
}
