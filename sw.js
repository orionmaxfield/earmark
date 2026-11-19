/* Earmark service worker — the app opens, and logging works, with no signal.

   The site sits behind a Cloudflare Access login. When a tester's login expires, requests are
   redirected to the Access login page. Those responses are handed straight to the browser so it
   shows the login as normal; they are never cached and never shown as if they were the app.

   - Pages: network first (so a fresh deploy and the login both show up), falling back to the
     cached app when offline or on a very slow connection.
   - App files, icons and fonts: from the cache, refreshed in the background.
   - Book covers: the shelf's covers are kept on the device, so it works offline.
   - Book search and sync (/api/, which asks Audible, Open Library and Google Books): always the network; the app says so when offline.
   - Streak reminders: when the phone lets this worker run while the app is closed (Periodic Background Sync,
     installed Chrome/Android apps only), it shows today's reminder from the small plan the page saved.
   A new version waits until the page's "Update available — tap to refresh" is tapped. */
const SHELL = "earmark-shell-v1", RUNTIME = "earmark-runtime-v1", COVERS = "earmark-covers";
const SCOPE = self.registration.scope;
const INDEX = new URL("./", SCOPE).href;
const FONT_CSS = "https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap";
const PRECACHE = ["./", "manifest.webmanifest", "icons/favicon-32.png", "icons/favicon-16.png", "icons/favicon.ico",
  "icons/apple-touch-icon.png", "icons/icon-192.png", "icons/icon-512.png", "icons/icon-512-maskable.png",
  "icons/earmark-mark.png", "icons/earmark-wordmark.png"].map(u => new URL(u, SCOPE).href);
const APP_MARK = 'id="s-home"';
const API = new URL("api/", SCOPE).pathname;   // only a page containing the app's home screen is ever cached as the app

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
  if (url.origin === self.location.origin && url.pathname.startsWith(API)) return;   // sync always goes to the server, never a cache
  if (req.mode === "navigate") { e.respondWith(page(req)); return; }
  if (url.origin === self.location.origin) { e.respondWith(fromCache(req)); return; }
  if (/^fonts\.(googleapis|gstatic)\.com$/.test(url.hostname)) { e.respondWith(fromCache(req, RUNTIME)); return; }
  if (/^covers\.openlibrary\.org$|^books\.google\.com$|^books\.googleusercontent\.com$|^m\.media-amazon\.com$/.test(url.hostname)) { e.respondWith(cover(req)); return; }
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

// covers of books on the shelf are saved by the page; search-result covers aren't kept
async function cover(req) {
  const hit = await (await caches.open(COVERS)).match(req.url);
  if (hit) return hit;
  try { return await fetch(req); } catch (err) { return Response.error(); }
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

/* ---- streak reminders ----
   The page works out who needs a reminder and when (index.html, RM.plan) and saves a short plan: one entry for
   each of the next few days, {day:"2026-11-19", time:"20:00", title, body}. This worker only reads it. Nothing
   is fetched and nothing is sent. */
const REM_DB = "earmark-reminders", REM_TAG = "earmark-streak-reminder";
const remKv = (mode, fn) => new Promise(res => {
  try {
    const r = indexedDB.open(REM_DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onerror = r.onblocked = () => res(null);
    r.onsuccess = () => {
      const db = r.result;
      try {
        const tx = db.transaction("kv", mode), q = fn(tx.objectStore("kv"));
        tx.oncomplete = () => { db.close(); res(q ? q.result : null); };
        tx.onerror = tx.onabort = () => { db.close(); res(null); };
      } catch (err) { db.close(); res(null); }
    };
  } catch (err) { res(null); }
});
/* REMINDER-PICK:START (the same rule as RM.pick in index.html; tests/reminders.test.js checks the two agree) */
// the entry to show at this moment: its day's time has come (in the phone's timezone now), the day isn't over, and it wasn't shown
function remPick(entries, now, shownDay) {
  const at = (day, h, mi) => { const [y, m, d] = day.split("-").map(Number); return new Date(y, m - 1, d, h, mi, 0, 0); };
  const e = (Array.isArray(entries) ? entries : []).find(x => {
    if (!x || !/^\d{4}-\d{2}-\d{2}$/.test(x.day)) return false;
    const t = /^(\d{1,2}):(\d{2})/.exec(String(x.time || "")), ok = t && +t[1] < 24 && +t[2] < 60, h = ok ? +t[1] : 20, mi = ok ? +t[2] : 0;
    const end = at(x.day, 0, 0); end.setDate(end.getDate() + 1);
    return now >= at(x.day, h, mi) && now < end;
  });
  return e && e.day !== shownDay ? e : null;
}
/* REMINDER-PICK:END */
async function remindIfDue() {
  if (!self.Notification || Notification.permission !== "granted") return;
  const plan = await remKv("readonly", s => s.get("plan"));
  if (!plan || !plan.on) return;
  const shown = await remKv("readonly", s => s.get("shown"));
  const e = remPick(plan.entries, new Date(), shown && shown.day);
  if (!e) return;
  // Earmark is open and in view: its own card on Home is the reminder
  const open = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  if (open.some(c => c.visibilityState === "visible")) return;
  await remKv("readwrite", s => s.put({ day: e.day, at: Date.now() }, "shown"));
  await self.registration.showNotification(String(e.title || "Keep your streak going"), { body: String(e.body || ""), icon: "icons/icon-192.png", tag: REM_TAG });
}
self.addEventListener("periodicsync", e => { if (e.tag === REM_TAG) e.waitUntil(remindIfDue()); });
// tapping a reminder opens Earmark (or brings it forward if it is already open)
self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const c = open.find(c => c.url.startsWith(SCOPE));
    if (c && "focus" in c) return c.focus();
    return self.clients.openWindow(SCOPE);
  })());
});
