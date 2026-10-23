import Anthropic from "@anthropic-ai/sdk";
import { json } from "../_middleware.js";
import { takeSlot, giveBack } from "./_usage.js";

/* POST /api/books/screenshot  { image: base64, mediaType, width, height }
   Reads a screenshot of a book's page (Audible's app, or any book app) with Claude Haiku and returns what it shows:
   title, subtitle, authors, narrators, length, series, and where the cover is on the screenshot. Only what's
   visible; anything not shown comes back empty, never guessed.
   The screenshot is never stored: it's held only while this request runs, and isn't logged. Anthropic doesn't keep
   images beyond the request or train on them.
   Each person can read SCREENSHOT_PER_PERSON a day (default 10) and everyone together SCREENSHOT_PER_DAY (default
   200), so the cost stays small; the monthly spend limit set at Anthropic is the last stop.
   Settings: ANTHROPIC_API_KEY (a secret, server-side only). ANTHROPIC_BASE_URL_TEST points at a stand-in for local
   tests and is never set on Cloudflare. */
const MODEL = "claude-haiku-5-5";
const MAX_BASE64 = 3_000_000;   // about 2.2 MB; the app sends a JPEG of about 200–400 KB
const TYPES = { "image/jpeg": [0xff, 0xd8, 0xff], "image/png": [0x89, 0x50, 0x4e, 0x47], "image/webp": [0x52, 0x49, 0x46, 0x46] };

const SYSTEM = `You read a screenshot that someone took of one book's page in an audiobook or book app (often Audible) and report that book's details exactly as the page shows them.

Rules:
- Report only text you can see on the page for the main book. Never fill a field from memory, and never guess. If something isn't shown, use null (or an empty list).
- Ignore everything that isn't the main book: the mini player or "now playing" bar at the bottom of the screen, recommendations, "listeners also enjoyed", ratings, prices, buttons, the status bar.
- length_text: the book's total running time exactly as written on the page (for example "19h 7m" or "16 hrs and 10 mins"). Never a time left ("8h 28m left") and never a time from the mini player.
- series: only when the page names the series (for example "The Green Bone Saga, Book 1" gives series "The Green Bone Saga" and series_number 1). A heading like "Included in series" with no series name is not a series name: use null.
- authors and narrators: each person or company as a separate entry, as written ("Jason M. Satterfield & The Great Courses" is two authors). Keep titles like "Professor" when they're written.
- title: the book's title as shown. subtitle: a line directly under the title that is the book's subtitle, not a series line, a length line or genres.
- cover_box: the bounding box of the main cover artwork in pixels of this image, as x, y, width, height, or null if there is no cover.
- is_book_page: false if this isn't a page about one book (a library list, a home screen, a photo of something else). Then leave the other fields null.`;

const nul = t => ({ anyOf: [{ type: t }, { type: "null" }] });
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["is_book_page", "title", "subtitle", "authors", "narrators", "length_text", "series", "series_number", "cover_box"],
  properties: {
    is_book_page: { type: "boolean" },
    title: nul("string"),
    subtitle: nul("string"),
    authors: { type: "array", items: { type: "string" } },
    narrators: { type: "array", items: { type: "string" } },
    length_text: nul("string"),
    series: nul("string"),
    series_number: nul("number"),
    cover_box: {
      anyOf: [{ type: "null" }, {
        type: "object", additionalProperties: false, required: ["x", "y", "width", "height"],
        properties: { x: { type: "integer" }, y: { type: "integer" }, width: { type: "integer" }, height: { type: "integer" } },
      }],
    },
  },
};

const str = (v, n = 300) => (typeof v === "string" && v.trim() ? v.trim().replace(/\s+/g, " ").slice(0, n) : null);
const names = v => (Array.isArray(v) ? v.map(x => str(x, 120)).filter(Boolean).slice(0, 6) : []);
// "19h 7m", "16 hrs and 10 mins", "45 min", "3 hours" → minutes; anything that says "left" isn't a length
export function lengthMinutes(text) {
  const t = String(text || "").toLowerCase();
  if (!t || /left|remaining/.test(t)) return null;
  const h = /(\d+)\s*(?:h|hr|hrs|hour|hours)\b/.exec(t), m = /(\d+)\s*(?:m|min|mins|minute|minutes)\b/.exec(t);
  const min = (h ? +h[1] * 60 : 0) + (m ? +m[1] : 0);
  return h || m ? (min > 0 && min < 20000 ? min : null) : null;
}
function clean(o, w, h) {
  if (!o || !o.is_book_page) return null;
  const title = str(o.title); if (!title) return null;
  const num = typeof o.series_number === "number" && o.series_number > 0 && o.series_number < 1e4 ? o.series_number : null;
  const b = o.cover_box;
  let cover = null;
  if (b && [b.x, b.y, b.width, b.height].every(Number.isFinite) && w > 0 && h > 0) {
    const x = Math.max(0, Math.round(b.x)), y = Math.max(0, Math.round(b.y));
    const cw = Math.min(w - x, Math.round(b.width)), ch = Math.min(h - y, Math.round(b.height));
    if (cw >= 40 && ch >= 40) cover = { x, y, width: cw, height: ch };
  }
  const series = str(o.series, 200);
  return { title, subtitle: str(o.subtitle), authors: names(o.authors), narrators: names(o.narrators),
    lengthText: str(o.length_text, 60), minutes: lengthMinutes(o.length_text), series, num: series ? num : null, cover };
}

export async function onRequestPost({ request, env, data }) {
  if (!env.ANTHROPIC_API_KEY) return json({ error: "Reading screenshots isn't set up yet.", reason: "not-configured" }, 503);
  let body; try { body = await request.json(); } catch { return json({ error: "That request couldn't be read." }, 400); }
  const image = typeof (body && body.image) === "string" ? body.image : "", mediaType = body && body.mediaType;
  const w = Math.round(+body.width) || 0, h = Math.round(+body.height) || 0;
  if (!TYPES[mediaType] || !image) return json({ error: "Send a JPEG, PNG or WebP image.", reason: "bad-image" }, 400);
  if (image.length > MAX_BASE64) return json({ error: "That image is too large.", reason: "too-large" }, 413);
  let head; try { head = Uint8Array.from(atob(image.slice(0, 16)), c => c.charCodeAt(0)); } catch { head = new Uint8Array(); }
  if (!TYPES[mediaType].every((v, i) => head[i] === v)) return json({ error: "Send a JPEG, PNG or WebP image.", reason: "bad-image" }, 400);

  const perPerson = +env.SCREENSHOT_PER_PERSON || 10, perDay = +env.SCREENSHOT_PER_DAY || 200;
  const slot = await takeSlot(env.DB, data.email, "screenshot", perPerson, perDay);
  if (!slot.ok) return json(slot.all
    ? { error: "Earmark has read as many screenshots as it can today. Try again tomorrow, or type the title.", reason: "limit-everyone" }
    : { error: `You've read ${perPerson} screenshots today, the most for one day. Try again tomorrow, or type the title.`, reason: "limit-person", limit: perPerson }, 429);

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, baseURL: env.ANTHROPIC_BASE_URL_TEST || undefined, maxRetries: 1, timeout: 30000 });
  let res;
  try {
    res = await client.messages.create({
      model: MODEL,
      max_tokens: 2000,
      system: SYSTEM,
      output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: mediaType, data: image } },
        { type: "text", text: `Report this book's details. The image is ${w}×${h} pixels.` },
      ] }],
    });
  } catch (err) {
    // the call didn't happen or wasn't billed: the slot goes back
    await giveBack(env.DB, data.email, "screenshot").catch(() => {});
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
      console.error("screenshot: Anthropic key refused", err.status);
      return json({ error: "Reading screenshots isn't set up yet.", reason: "not-configured" }, 503);
    }
    if (err instanceof Anthropic.BadRequestError || err instanceof Anthropic.RateLimitError) {
      // includes the monthly spend limit being reached
      console.error("screenshot: Anthropic declined", err.status, err.message && err.message.slice(0, 120));
      return json({ error: "Reading screenshots is paused for now. Type the title instead.", reason: "paused" }, 503);
    }
    console.error("screenshot: Anthropic unavailable", err && err.status);
    return json({ error: "Couldn't read the screenshot just now. Try again, or type the title.", reason: "unavailable" }, 503);
  }
  const left = Math.max(0, perPerson - slot.mine);
  if (res.stop_reason === "refusal" || res.stop_reason === "max_tokens")
    return json({ error: "Couldn't read a book from that screenshot. Type the title instead.", reason: "unreadable", left }, 422);
  let out = null;
  try { out = JSON.parse((res.content.find(b => b.type === "text") || {}).text || "null"); } catch { out = null; }
  const book = clean(out, w, h);
  if (!book) return json({ error: "That doesn't look like a book's page. Take the screenshot on the book's page, or type the title.", reason: "not-a-book", left }, 422);
  return json({ book, left });
}
