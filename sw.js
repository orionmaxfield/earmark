/* Earmark service worker — the app opens, and logging works, with no signal.

   The site sits behind a Cloudflare Access login. When a tester's login expires, requests are
   redirected to the Access login page. Those responses are handed straight to the browser so it
   shows the login as normal; they are never cached and never shown as if they were the app.

   - Pages: network first (so a fresh deploy and the login both show up), falling back to the
     cached app when offline or on a very slow connection.
   - App files, icons and fonts: from the cache, refreshed in the background.
   - Book covers: kept on the device once seen, so the shelf works offline.
   - Book search (Open Library, Google Books): always the network; the app says so when offline.
   A new version waits until the page's "Update available — tap to refresh" is tapped. */
const SHELL = "earmark-shell-v1", RUNTIME = "earmark-runtime-v1", COVERS = "earmark-covers";
const SCOPE = self.registration.scope;
const INDEX = new URL("./", SCOPE).href;
const FONT_CSS = "https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap";
const PRECACHE = ["./", "manifest.webmanifest", "icons/favicon-32.png", "icons/favicon-16.png", "icons/favicon.ico",
  "icons/apple-touch-icon.png", "icons/icon-192.png", "icons/icon-512.png", "icons/icon-512-maskable.png",
  "icons/earmark-mark.png", "icons/earmark-wordmark.png"].map(u => new URL(u, SCOPE).href);
const APP_MARK = 'id="s-home"';   // only a page containing the app's home screen is ever cached as the app

const isAccess = url => /(^|\.)cloudflareaccess\.com\b|\/cdn-cgi\/access\//.test(url);
// keep a response only if it is a real answer from our own site: no redirects, no login page
const keepable = res => !!res && res.ok && res.type === "basic" && !res.redirected && !isAccess(res.url)
  && new URL(res.url).origin === self.location.origin;
const timeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);

self.addEventListener("install", e => {
  e.waitUntil((async () => {
    const shell = await caches.open(SHELL);
    await Promise.all(PRECACHE.map(async u => {
      try {
        const res = await fetch(u, { cache: "no-cache", redirect: "manual", credentials: "same-origin" });
        if (!keepable(res)) return;
        if (u === INDEX && !(await res.clone().text()).includes(APP_MARK)) return;
        await shell.put(u, res);
      } catch (err) { /* offline or logged out: cached on a later visit */ }
    }));
    // the font, so the app looks right offline
    try {
      const runtime = await caches.open(RUNTIME), css = await fetch(FONT_CSS);
      if (css.ok) {
        const text = await css.clone().text();
        await runtime.put(FONT_CSS, css);
        await Promise.all([...text.matchAll(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/g)].map(async m => {
          try { const f = await fetch(m[1]); if (f.ok) await runtime.put(m[1], f); } catch (err) {}
        }));
      }
    } catch (err) {}
  })());
});

self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (![SHELL, RUNTIME, COVERS].includes(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener("message", e => {
  if (e.data === "skip-waiting") self.skipWaiting();
  if (e.data === "check-update") e.waitUntil(checkForUpdate(e.source));
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (isAccess(url.href)) return;                                   // the login flow is never touched
  if (req.mode === "navigate") { e.respondWith(page(req)); return; }
  if (url.origin === self.location.origin) { e.respondWith(fromCache(req)); return; }
  if (/^fonts\.(googleapis|gstatic)\.com$/.test(url.hostname)) { e.respondWith(fromCache(req, RUNTIME)); return; }
  if (/^covers\.openlibrary\.org$|^books\.google\.com$|^books\.googleusercontent\.com$/.test(url.hostname)) { e.respondWith(cover(req)); return; }
  // everything else, such as book search, goes straight to the network
});

async function page(req) {
  const shell = await caches.open(SHELL);
  try {
    const res = await timeout(fetch(req), 4000);
    // a redirect (the Access login) goes to the browser untouched and is never cached
    if (res.type === "opaqueredirect" || res.redirected || isAccess(res.url)) return res;
    if (keepable(res) && /text\/html/.test(res.headers.get("content-type") || "")) {
      const copy = res.clone();
      copy.text().then(text => { if (text.includes(APP_MARK)) shell.put(INDEX, new Response(text, { headers: { "content-type": "text/html; charset=utf-8" } })); }).catch(() => {});
    }
    return res;
  } catch (err) {
    // no signal (or a very slow one): open the app from the cache
    return (await shell.match(INDEX)) || (await shell.match(req)) || Response.error();
  }
}

async function fromCache(req, name = SHELL) {
  const cache = await caches.open(name), hit = await cache.match(req, { ignoreSearch: name === SHELL });
  const refresh = fetch(req).then(res => {
    if (name === SHELL ? keepable(res) : (res.ok || res.type === "opaque")) cache.put(req, res.clone());
    return res;
  });
  if (hit) { refresh.catch(() => {}); return hit; }
  try { return await refresh; } catch (err) { return Response.error(); }
}

async function cover(req) {
  const cache = await caches.open(COVERS), hit = await cache.match(req.url);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res.ok || res.type === "opaque") cache.put(req.url, res.clone());
    return res;
  } catch (err) { return Response.error(); }
}

// a new deploy of the page: keep it for the next open, and tell the page so it can offer a refresh
async function checkForUpdate(client) {
  try {
    const res = await fetch(INDEX, { cache: "no-store", redirect: "manual", credentials: "same-origin" });
    if (!keepable(res)) return;
    const text = await res.text();
    if (!text.includes(APP_MARK)) return;
    const shell = await caches.open(SHELL), old = await shell.match(INDEX), before = old ? await old.text() : null;
    if (before === text) return;
    await shell.put(INDEX, new Response(text, { headers: { "content-type": "text/html; charset=utf-8" } }));
    if (before != null && client) client.postMessage({ type: "update-available" });
  } catch (err) {}
}
