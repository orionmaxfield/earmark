import { json } from "../_middleware.js";
import { configure, isDown, audibleSearch, openLibrarySearch, googleSearch } from "./_sources.js";
import { relevant } from "./_match.js";

/* GET /api/books/search?q=…  Sources in order: Audible's catalog (exact runtimes), then Open Library, then Google
   Books (page counts, so the app estimates the length). The first source with relevant results answers. A source
   that's down or limiting us is skipped. Each source's answer to a search is kept for a few days, so the same
   search doesn't reach it again. */
const CHAIN = [["audible", audibleSearch, 7], ["openlibrary", openLibrarySearch, 3], ["googlebooks", googleSearch, 3]];   // days a search's answer is kept

async function cached(ctx, src, fn, q, days) {
  const key = new Request(new URL(`/__cache/books/${src}?q=${encodeURIComponent(q)}`, ctx.request.url).href);
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const hit = cache && await cache.match(key).catch(() => null);
  if (hit) return hit.json();
  const list = await fn(q);
  if (cache) ctx.waitUntil(cache.put(key, new Response(JSON.stringify(list), {
    headers: { "content-type": "application/json", "cache-control": `max-age=${(list.length ? days : 1) * 86400}` } })).catch(() => {}));
  return list;
}

export async function onRequestGet(ctx) {
  configure(ctx.env);
  const q = (new URL(ctx.request.url).searchParams.get("q") || "").trim().toLowerCase().replace(/\s+/g, " ").slice(0, 120);
  if (q.length < 2) return json({ results: [], source: null, tried: [] });
  const tried = [];
  for (const [src, fn, days] of CHAIN) {
    if (isDown(src)) { tried.push({ src, skipped: true }); continue; }
    try {
      const list = relevant(await cached(ctx, src, fn, q, days), q);
      tried.push({ src, results: list.length });
      if (list.length) return json({ results: list.slice(0, 25), source: src, tried });
    } catch (err) { tried.push({ src, error: err.message }); }
  }
  // nothing anywhere: "no matches" if a source answered, "search isn't working" if none could be reached
  return json({ results: [], source: null, tried, unavailable: tried.every(t => t.skipped || t.error) });
}
