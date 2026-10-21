/* Earmark: import your Audible library. The source of the bookmark on audible-import.html, which fills in
   EARMARK_ORIGIN with its own address.
   Runs on your Audible library page, where you're already signed in on Audible's own site. It reads your
   library list a page at a time (title, author, narrator, series, ASIN, length, finished), the same pages you
   can scroll through yourself, and hands the list to the Earmark window it opened, in your browser. Earmark
   shows it for review before anything is saved. It never sees, asks for or sends your password, and sends
   nothing anywhere else. */
(function () {
  var E = "EARMARK_ORIGIN", V = 1;
  if (!/^www\.audible\.(com|ca|co\.uk|com\.au|de|fr|it|es|co\.jp|in|com\.br)$/.test(location.hostname)) {
    alert("Earmark: open your Audible library first (audible.com, then Library), then click this bookmark again.");
    return;
  }
  // clicked again while it runs: show the panel; after it has finished, start over
  var prev = window.__earmarkImport;
  if (prev && !prev.done) { prev.show(); return; }
  if (prev) prev.host.remove();

  // the Earmark window opens now, while the click still counts, so the browser doesn't block it
  var win = window.open(E + "/?import=audible", "earmark-import");
  var books = null, sent = false, ready = false;

  /* a small panel in the corner, kept apart from Audible's own styles */
  var host = document.createElement("div"), root = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;
  host.style.cssText = "position:fixed;z-index:2147483647;right:16px;bottom:16px";
  root.innerHTML = "<style>" +
    ".p{width:300px;background:#0B1E3A;color:#fff;font:14px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;padding:14px 16px;border-radius:12px;border:1px solid rgba(255,255,255,.14);box-shadow:0 18px 48px rgba(0,0,0,.42)}" +
    "b{display:block;font-size:15px;margin-bottom:4px}p{margin:0;color:#A9B6C9}" +
    "button{margin:10px 8px 0 0;min-height:36px;padding:6px 12px;border:0;border-radius:8px;font-weight:600;font-size:14px;font-family:inherit;cursor:pointer}" +
    ".go{background:linear-gradient(135deg,#34F9B2,#00C0CA);color:#06162C}.alt{background:rgba(255,255,255,.08);color:#fff}" +
    ".x{position:absolute;top:6px;right:6px;margin:0;min-height:28px;width:28px;padding:0;background:transparent;color:#A9B6C9;font-size:18px}" +
    "</style><div class='p'><button class='x' aria-label='Close'>×</button><b>Earmark</b><p class='m'></p><div class='b'></div></div>";
  document.body.appendChild(host);
  var msg = root.querySelector(".m"), btns = root.querySelector(".b");
  root.querySelector(".x").onclick = function () { host.remove(); };
  var run = window.__earmarkImport = { host: host, done: false, show: function () { if (!host.isConnected) document.body.appendChild(host); } };
  function say(text, buttons) {
    msg.textContent = text; btns.innerHTML = "";
    (buttons || []).forEach(function (b, i) {
      var el = document.createElement("button"); el.className = i ? "alt" : "go"; el.textContent = b[0]; el.onclick = b[1]; btns.appendChild(el);
    });
  }

  /* ---- reading one library page ---- */
  var clean = function (s) { return String(s || "").replace(/\s+/g, " ").trim(); };
  var txt = function (el) { return el ? clean(el.textContent) : ""; };
  var hidden = function (el) { return !el || !!el.closest(".bc-pub-hidden,[hidden],[aria-hidden='true']"); };
  // "16h 10m", "16 hrs and 10 mins", "45m left", "1 hr"
  var LEN = /^(?:(?:length|länge|durée|duración|durata)\s*:?\s*)?(?:(\d+)\s*(?:h|hrs?|hours?|std\.?|heures?)\b)?\s*(?:and|und|et|y|e)?\s*(?:(\d+)\s*(?:m|mins?|minutes?|min\.?)\b)?\s*(left|übrig|restantes?|rimanenti)?$/i;
  function parseLen(s) {
    var m = LEN.exec(clean(s)); if (!m || (!m[1] && !m[2])) return null;
    return { min: (+m[1] || 0) * 60 + (+m[2] || 0), left: !!m[3] };
  }
  var FINISHED = /^(finished|terminé|beendet|abgeschlossen|terminado|completato|finalizado)$/i;
  function row(r) {
    var asin = r.id.replace("adbl-library-content-row-", "");
    if (!/^[A-Z0-9]{10}$/.test(asin)) return null;
    if (r.querySelector("a[href*='/podcast/'],a[href*='/podcasts/']")) return null;
    var title = txt(r.querySelector(".bc-size-headline3")) || txt(r.querySelector("a[href*='/pd/']")) || clean((r.querySelector("img[alt]") || {}).alt);
    if (!title) return null;
    var names = function (k) { return Array.prototype.map.call(r.querySelectorAll("." + k + " a"), txt).filter(Boolean); };
    var seriesEl = r.querySelector(".seriesLabel"), seriesName = seriesEl ? txt(seriesEl.querySelector("a")) : "";
    var num = seriesEl ? /(?:book|buch|livre|libro|tome|band)\s*([\d.]+)/i.exec(txt(seriesEl)) : null;
    // finished, listening (time left) or not started; the length when Audible shows it
    var finished = false, left = null, total = null;
    var fin = r.querySelector("[id^='time-remaining-finished']");
    if (fin && !hidden(fin)) finished = true;
    var bar = r.querySelector("[role='progressbar'][aria-valuenow]");
    if (bar && +bar.getAttribute("aria-valuenow") >= 100) finished = true;
    var leaves = r.querySelectorAll("span,div,p,li");
    for (var i = 0; i < leaves.length; i++) {
      var el = leaves[i]; if (el.children.length || hidden(el) || el.closest("button,a")) continue;
      var t = txt(el); if (!t || t.length > 40) continue;
      if (FINISHED.test(t)) finished = true;
      var len = parseLen(t); if (len) { if (len.left) left = len.min; else if (total == null) total = len.min; }
    }
    var img = r.querySelector("img[src*='media-amazon'],img[src*='images-amazon']");
    var cover = img ? img.getAttribute("src").replace(/\._[^.\/]+_\.(jpg|png)$/i, "._SL500_.$1") : null;
    return {
      asin: asin, t: title, author: names("authorLabel").join(", ") || null, narrator: names("narratorLabel").join(", ") || null,
      series: seriesName || null, num: num ? +num[1] || null : null, minutes: total, left: finished ? null : left,
      finished: finished, listening: !finished && left != null, cover: cover && /^https:\/\//.test(cover) ? cover : null,
    };
  }
  function lastPage(doc) {
    var n = 0;
    Array.prototype.forEach.call(doc.querySelectorAll(".pagingElements a, .pagingElements button, [data-value]"), function (a) {
      var v = +(a.getAttribute("data-value") || txt(a)); if (v > n && v < 1000 && a.closest(".pagingElements")) n = v;
    });
    return n;
  }

  /* ---- every page of the library, a little apart ---- */
  var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  async function readAll() {
    var all = [], seen = {}, last = 0;
    for (var page = 1; page <= 200; page++) {
      say("Reading your Audible library… page " + page + (last ? " of " + last : "") + (all.length ? " (" + all.length + " books)" : ""));
      // signed out, the library redirects to Amazon's sign-in page: taken as "sign in first", never followed
      var res = await fetch(location.origin + "/library/titles?page=" + page + "&pageSize=50", { credentials: "include", redirect: "manual" });
      if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400) || /\/(ap\/)?signin|\/sign-in/i.test(res.url)) throw new Error("signin");
      if (!res.ok) throw new Error("http " + res.status);
      var doc = new DOMParser().parseFromString(await res.text(), "text/html");
      if (page === 1) last = lastPage(doc);
      var fresh = 0;
      Array.prototype.forEach.call(doc.querySelectorAll("[id^='adbl-library-content-row-']"), function (r) {
        var b = row(r); if (b && !seen[b.asin]) { seen[b.asin] = 1; all.push(b); fresh++; }
      });
      if (!fresh || (last && page >= last)) break;
      await wait(400);
    }
    return all;
  }

  function payload() { return { type: "earmark-audible-library", v: V, from: location.origin, readAt: new Date().toISOString(), books: books }; }
  function send() {
    if (sent || !books || !ready || !win || win.closed) return;
    win.postMessage(payload(), E);
  }
  function saveFile() {
    var a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(payload())], { type: "application/json" }));
    a.download = "earmark-audible-library.json"; document.body.appendChild(a); a.click(); a.remove();
    say("Saved earmark-audible-library.json to your downloads. In Earmark, go to Settings › Import books, tap Choose that file, and pick it.");
  }
  function reopen() { win = window.open(E + "/?import=audible", "earmark-import"); waiting(); }
  function waiting() {
    say("Found " + books.length + " books. Waiting for Earmark to open… If it asks you to sign in, sign in there.", [["Open Earmark", reopen], ["Save as a file", saveFile]]);
  }
  // Earmark says it's ready (and again until it has the list), then that it has it
  window.addEventListener("message", function (e) {
    if (e.origin !== E || !e.data || (win && e.source !== win)) return;
    if (e.data.earmark === "ready") { ready = true; send(); }
    if (e.data.earmark === "received") {
      sent = true;
      say("Sent " + books.length + " books to Earmark. Check them there and tap Add. You can close this.", [["Close", function () { host.remove(); }]]);
    }
  });

  readAll().finally(function () { run.done = true; }).then(function (list) {
    if (!list.length) {
      say("Couldn't find any books on your library pages. Make sure you're signed in and can see your Library, then try again. You can also use the complete history import in Earmark instead.");
      return;
    }
    books = list;
    if (!win) say("Found " + list.length + " books. Your browser blocked the Earmark window.", [["Open Earmark", reopen], ["Save as a file", saveFile]]);
    else { waiting(); send(); }
  }).catch(function (err) {
    if (err && err.message === "signin") say("Sign in to Audible in this tab as you normally do, open your Library, then click the bookmark again. Earmark never sees your password.");
    else say("Couldn't read your library just now (" + (err && err.message || "error") + "). Try again in a minute.");
  });
})();
