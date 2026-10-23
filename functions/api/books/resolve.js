import { json } from "../_middleware.js";

/* GET /api/books/resolve?url=…  Where a shortened share link points, for Paste a link.
   Only known Amazon and Audible link shorteners are asked, and only for the address they redirect to: the reply's
   Location header, never a page. As soon as the address is on an Audible or Amazon site it's returned without being
   opened, so Audible's own pages are never requested. At most a few redirects. */
const SHORT = /^(a\.co|amzn\.to|amzn\.eu|amzn\.asia|amzn\.com|adbl\.co)$/i;
const BOOK_SITE = /(^|\.)(audible|amazon)\.(com|ca|co\.uk|com\.au|de|fr|it|es|co\.jp|in|com\.br|com\.mx|nl)$/i;
const UA = "Earmark/0.13 (audiobook listening tracker; share links)";

export async function onRequestGet({ request }) {
  let url;
  try { url = new URL(new URL(request.url).searchParams.get("url") || ""); } catch { return json({ error: "That isn't a link." }, 400); }
  for (let hop = 0; hop < 4; hop++) {
    if (BOOK_SITE.test(url.hostname)) return json({ url: url.href });
    if (url.protocol !== "https:" && url.protocol !== "http:") break;
    if (!SHORT.test(url.hostname)) return json({ error: "Earmark only follows Amazon and Audible share links." }, 400);
    let res;
    try {
      const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 5000);
      res = await fetch(url.href, { method: "GET", redirect: "manual", headers: { "user-agent": UA }, signal: ctl.signal });
      clearTimeout(timer);
    } catch { return json({ error: "That link couldn't be reached." }, 502); }
    const next = res.headers.get("location");
    if (res.body) res.body.cancel().catch(() => {});   // the page itself is never read
    if (!(res.status >= 300 && res.status < 400) || !next) break;
    try { url = new URL(next, url); } catch { break; }
  }
  return json({ error: "That link doesn't lead to a book." }, 404);
}
