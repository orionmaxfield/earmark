import { json } from "../_middleware.js";
import { configure, openLibrarySearch, googleSearch, openLibraryByIsbn, googleByIsbn } from "./_sources.js";

/* GET /api/books/probe: tries each book source once, from Earmark's server, and reports what came back.
   For checking which sources this deployment can reach. Signed-in only, like everything under /api/. */
const ISBN = "9780593135204";   // Project Hail Mary

async function trial(name, fn) {
  const t0 = Date.now();
  try {
    const out = await fn();
    const list = Array.isArray(out) ? out : out ? [out] : [];
    return { source: name, reachable: true, ms: Date.now() - t0, results: list.length,
      sample: list.slice(0, 2).map(b => ({ title: b.t, author: b.author, narrator: b.narrator || null, series: b.series ? `${b.series}${b.num ? " #" + b.num : ""}` : null,
        runtimeMinutes: b.minutes ?? null, pages: b.pages ?? null, cover: b.cover, asin: b.asin || null, isbn: b.isbn || null })) };
  } catch (err) {
    return { source: name, reachable: false, ms: Date.now() - t0, error: err.message };
  }
}

export async function onRequestGet({ env }) {
  configure(env);
  const checks = await Promise.all([
    trial("Open Library: search \"project hail mary\"", () => openLibrarySearch("project hail mary")),
    trial("Google Books: search \"project hail mary\"", () => googleSearch("project hail mary")),
    trial("Open Library: by ISBN", () => openLibraryByIsbn(ISBN)),
    trial("Google Books: by ISBN", () => googleByIsbn(ISBN)),
  ]);
  return json({ checkedAt: new Date().toISOString(), checks });
}
