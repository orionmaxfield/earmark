import { plain, matchKey, relevant } from "./_match.js";

/* Earmark's own book table: what's known about books (never about people), filled from every lookup, every book
   added by hand and every import, so the library grows. A book is one row, found by ASIN first, then ISBN, then
   title and author. A better source fills in and corrects what a weaker one left (Audible and Audnexus over Open
   Library and Google Books, over imports, over books typed in). Books that only came from people (typed in, or
   imported without a catalog confirming them) are kept but never shown in search, so a private title someone typed
   can't appear for anyone else; a catalog finding the same book later makes it visible. */
export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS books (
     ref TEXT PRIMARY KEY,
     asin TEXT, isbn TEXT, title TEXT NOT NULL, author TEXT, narrator TEXT, series TEXT, series_pos REAL,
     runtime_min INTEGER, cover TEXT, year INTEGER, subjects TEXT,
     source TEXT NOT NULL, rank INTEGER NOT NULL, confirmed INTEGER NOT NULL DEFAULT 0,
     match_key TEXT NOT NULL, search TEXT NOT NULL, updated INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS books_asin ON books (asin)`,
  `CREATE INDEX IF NOT EXISTS books_isbn ON books (isbn)`,
  `CREATE INDEX IF NOT EXISTS books_match ON books (match_key)`,
];
export const RANK = { audible: 4, audnexus: 4, openlibrary: 2, googlebooks: 2, import: 1, manual: 0 };
const CONFIRMS = 2;   // rank from which a book is shown in search

export const cleanAsin = v => (/^[A-Z0-9]{10}$/.test(String(v || "").trim().toUpperCase()) ? String(v).trim().toUpperCase() : null);
export const cleanIsbn = v => { const s = String(v || "").replace(/[^0-9Xx]/g, "").toUpperCase(); return s.length === 10 || s.length === 13 ? s : null; };
const str = (v, n = 300) => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : null);
const posNum = (v, max) => { const n = +v; return isFinite(n) && n > 0 && n <= max ? n : null; };

// a book from any source (or from the app) → a row's fields
function toRow(b, source) {
  const t = str(b.t); if (!t) return null;
  const author = str(b.author), cover = typeof b.cover === "string" && /^https:\/\/[^\s"<>]{4,500}$/.test(b.cover) ? b.cover : null;
  return { asin: cleanAsin(b.asin), isbn: cleanIsbn(b.isbn), title: t, author, narrator: str(b.narrator), series: str(b.series), series_pos: posNum(b.num, 10000),
    runtime_min: posNum(Math.round(+b.minutes || 0), 20000), cover, year: posNum(b.year, 3000), subjects: Array.isArray(b.subjects) ? b.subjects.slice(0, 12).join(" | ").slice(0, 600) : null,
    source, rank: RANK[source] ?? 0, match_key: matchKey(t, author) };
}
// the better source's value where it has one, otherwise whichever is known. What people sent never changes a book a
// catalog has confirmed, and when a catalog confirms a book that only people had sent, the catalog's version replaces theirs.
function mergeRows(old, row) {
  if (old.confirmed && row.rank < CONFIRMS) return { ...old };
  if (!old.confirmed && row.rank >= CONFIRMS) return { ...old, ...row, match_key: matchKey(row.title, row.author) };
  const better = row.rank >= old.rank, out = { ...old };
  for (const k of ["asin", "isbn", "title", "author", "narrator", "series", "series_pos", "runtime_min", "cover", "year", "subjects"]) {
    if (row[k] != null && (better || old[k] == null)) out[k] = row[k];
  }
  if (better) { out.source = row.source; out.rank = row.rank; }
  out.match_key = matchKey(out.title, out.author);
  return out;
}

/* save books: one read to find what's already there, one write for all of them */
export async function saveBooks(db, books, source) {
  const rows = books.map(b => toRow(b, source)).filter(Boolean).slice(0, 500);
  if (!rows.length) return 0;
  const asins = [...new Set(rows.map(r => r.asin).filter(Boolean))], isbns = [...new Set(rows.map(r => r.isbn).filter(Boolean))], keys = [...new Set(rows.map(r => r.match_key))];
  const { results } = await db.prepare(`SELECT * FROM books WHERE asin IN (SELECT value FROM json_each(?1)) OR isbn IN (SELECT value FROM json_each(?2))
    OR match_key IN (SELECT value FROM json_each(?3))`).bind(JSON.stringify(asins), JSON.stringify(isbns), JSON.stringify(keys)).all();
  const byRef = new Map(results.map(r => [r.ref, r]));
  const find = r => (r.asin && results.find(x => x.asin === r.asin)) || (r.isbn && results.find(x => x.isbn === r.isbn))
    || results.filter(x => x.match_key === r.match_key && (!r.asin || !x.asin) && (!r.isbn || !x.isbn || x.isbn === r.isbn)).sort((a, b) => b.rank - a.rank)[0];
  const out = new Map(), now = Date.now();
  for (const r of rows) {
    const hit = find(r);
    const ref = hit ? hit.ref : r.asin ? `asin:${r.asin}` : r.isbn ? `isbn:${r.isbn}` : `key:${r.match_key}`;
    const prev = out.get(ref) || byRef.get(ref);
    const row = prev ? mergeRows(prev, r) : { ...r };
    row.ref = ref; row.confirmed = Math.max(prev ? prev.confirmed || 0 : 0, r.rank >= CONFIRMS ? 1 : 0); row.updated = now;
    row.search = plain([row.title, row.author, row.series].filter(Boolean).join(" "));
    out.set(ref, row); if (!byRef.has(ref)) { byRef.set(ref, row); results.push(row); }
  }
  const cols = ["ref", "asin", "isbn", "title", "author", "narrator", "series", "series_pos", "runtime_min", "cover", "year", "subjects", "source", "rank", "confirmed", "match_key", "search", "updated"];
  await db.prepare(`INSERT INTO books (${cols.join(", ")}) SELECT ${cols.map((c, i) => `json_extract(j.value, '$[${i}]')`).join(", ")} FROM json_each(?1) AS j WHERE true
    ON CONFLICT (ref) DO UPDATE SET ${cols.slice(1).map(c => `${c} = excluded.${c}`).join(", ")}`)
    .bind(JSON.stringify([...out.values()].map(r => cols.map(c => r[c] ?? null)))).run();
  return out.size;
}

// a row → the shape search results have
export const fromRow = r => ({ t: r.title, author: r.author, narrator: r.narrator, series: r.series, num: r.series_pos, minutes: r.runtime_min, cover: r.cover, year: r.year,
  subjects: r.subjects ? r.subjects.split(" | ") : [], asin: r.asin, isbn: r.isbn, src: r.source, key: r.asin || r.isbn || r.ref, fromLibrary: true });

/* books in the table that match a search (only ones a catalog has confirmed) */
export async function findInLibrary(db, q) {
  const words = plain(q).split(" ").filter(w => w.length > 1 || /\d/.test(w)).slice(0, 6);
  if (!words.length) return [];
  const { results } = await db.prepare(`SELECT * FROM books WHERE confirmed = 1 AND ${words.map((_, i) => `search LIKE ?${i + 1}`).join(" AND ")} ORDER BY rank DESC, runtime_min IS NULL LIMIT 40`)
    .bind(...words.map(w => `%${w.replace(/[%_]/g, "")}%`)).all();
  const seen = new Set();   // one row per book, the best source first
  return relevant(results.map(fromRow), q).filter(b => { const k = matchKey(b.t, b.author); if (seen.has(k)) return false; seen.add(k); return true; });
}

/* known books by ASIN, ISBN or title and author */
export async function findBooks(db, { asins = [], isbns = [], keys = [] }) {
  const { results } = await db.prepare(`SELECT * FROM books WHERE asin IN (SELECT value FROM json_each(?1)) OR isbn IN (SELECT value FROM json_each(?2))
    OR (match_key IN (SELECT value FROM json_each(?3)) AND confirmed = 1)`).bind(JSON.stringify(asins), JSON.stringify(isbns), JSON.stringify(keys)).all();
  return results;
}
