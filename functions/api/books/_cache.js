/* A source's answer to the same question is kept for a few days in Cloudflare's cache (empty answers for a day),
   so asking again doesn't reach the source. Keyed under this site's own address. */
export async function cached(ctx, src, fn, q, days) {
  const key = new Request(new URL(`/__cache/books/${src}?q=${encodeURIComponent(q)}`, ctx.request.url).href);
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const hit = cache && await cache.match(key).catch(() => null);
  if (hit) return hit.json();
  const list = await fn(q);
  if (cache) ctx.waitUntil(cache.put(key, new Response(JSON.stringify(list), {
    headers: { "content-type": "application/json", "cache-control": `max-age=${(list.length ? days : 1) * 86400}` } })).catch(() => {}));
  return list;
}
