import { json } from "../_middleware.js";
import { askClaude } from "./_claude.js";
import { readImage, claudeFailure, limits, limitReached, coverBox } from "./_shot.js";
import { takeSlot, giveBack, usedToday } from "./_usage.js";

/* POST /api/books/screenshot  { image: base64, mediaType, width, height }
   Reads a screenshot of a book's page (Audible's app, or any book app) with Claude Haiku and returns what it shows:
   title, subtitle, authors, narrators, length, series, and where the cover is on the screenshot. Only what's
   visible; anything not shown comes back empty, never guessed.
   The screenshot is never stored: it's held only while this request runs, and isn't logged. Anthropic doesn't keep
   images beyond the request or train on them.
   Pictures read here and by read-list.js count toward the same daily limits (see _shot.js).
   GET says whether reading is set up, so the app can hide it where it isn't (Production has no key).
   Settings: ANTHROPIC_API_KEY (a secret, server-side only). Without it the feature says it isn't available yet. */
const MODEL = "claude-haiku-5-5";

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
  const cover = coverBox(o.cover_box, w, h);
  const series = str(o.series, 200);
  return { title, subtitle: str(o.subtitle), authors: names(o.authors), narrators: names(o.narrators),
    lengthText: str(o.length_text, 60), minutes: lengthMinutes(o.length_text), series, num: series ? num : null, cover };
}

export async function onRequestPost({ request, env, data }) {
  if (!env.ANTHROPIC_API_KEY) return json({ error: "Reading screenshots isn't set up yet.", reason: "not-configured" }, 503);
  const pic = await readImage(request); if (pic.error) return json(...pic.error);
  const { image, mediaType, w, h } = pic, { perPerson, perDay } = limits(env);
  const slot = await takeSlot(env.DB, data.email, "screenshot", perPerson, perDay);
  if (!slot.ok) return json(...limitReached(slot, perPerson));

  let res;
  try {
    res = await askClaude(env, {
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
    return json(...claudeFailure(err));
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

// GET: whether reading screenshots is set up here, and how many this person has left today
export async function onRequestGet({ env, data }) {
  if (!env.ANTHROPIC_API_KEY) return json({ available: false });
  const { perPerson } = limits(env);
  return json({ available: true, left: Math.max(0, perPerson - await usedToday(env.DB, data.email, "screenshot")), perPerson });
}
