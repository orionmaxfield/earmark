/* A source's answer to the same question is kept for a few days in Cloudflare's cache (empty answers for a day),
   so asking again doesn't reach the source. Keyed under this site's own address. */
// meter (optional) counts the outside calls this made: 1 for an answer from the cache, 3 for one from the source
export async function cached(ctx, src, fn, q, days, meter) {
  const key = new Request(new URL(`/__cache/books/${src}?q=${encodeURIComponent(q)}`, ctx.request.url).href);
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const hit = cache && await cache.match(key).catch(() => null);
  if (meter) meter.calls += hit ? 1 : 3;
  if (hit) return hit.json();
  const list = await fn(q);
  if (cache) ctx.waitUntil(cache.put(key, new Response(JSON.stringify(list), {
    headers: { "content-type": "application/json", "cache-control": `max-age=${(list.length ? days : 1) * 86400}` } })).catch(() => {}));
  return list;
}
