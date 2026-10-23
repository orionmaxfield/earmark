import { json } from "../_middleware.js";
import { askClaude } from "./_claude.js";
import { takeSlot, giveBack } from "./_usage.js";
import { readImage, claudeFailure, limits, limitReached } from "./_shot.js";

/* POST /api/books/read-list  { image: base64, mediaType, width, height }   (one picture a request; the app sends at most 5)
   Reads a screenshot of a book list or library (Audible, Libby, Kindle…) or a photo of a bookshelf with Claude
   Haiku, and returns the books it can read: [{ title, author, format, progress_or_hours }]. Nothing is saved here:
   the app shows the list for the person to check, edit and confirm. Only the picture and these instructions are
   sent to Anthropic, never anything about the person. The picture isn't stored or logged.
   Counts toward the same daily limits as reading one book's page (see _shot.js). */
const MODEL = "claude-haiku-5-5";
const MAX_BOOKS = 60;
const FORMATS = ["audiobook", "ebook", "print", "unknown"];

const SYSTEM = `You read a picture someone took of their books: a screenshot of a list or library in an app (Audible, Libby, Kindle, Goodreads and so on) or a photo of a bookshelf. List every book in it whose title you can actually read.

Rules:
- Only titles you can read in the picture. If a title is cut off, blurred or too small to read with confidence, leave that book out. Never fill in a title or author from memory, and never guess.
- author: only when the picture shows it next to that book (on a spine, or under the title in a list). Otherwise null.
- format: "audiobook" when the app is an audiobook app (Audible, Libby's audiobooks, Libro.fm…) or the item shows a listening time or headphones; "ebook" for Kindle or other ebooks; "print" for physical books in a photo; otherwise "unknown".
- progress_or_hours: progress or time shown for that book, exactly as written ("45%", "3h 2m left", "Finished", "12h 15m"); otherwise null.
- Ignore anything that isn't one of the person's books: a "now playing" bar, recommendations ("You might like", "Listeners also enjoyed"), ads, menus, headings, the status bar.
- List each book once, in the order it appears. If the picture shows no books, return an empty list.`;

const nul = t => ({ anyOf: [{ type: t }, { type: "null" }] });
const SCHEMA = {
  type: "object", additionalProperties: false, required: ["books"],
  properties: {
    books: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["title", "author", "format", "progress_or_hours"],
        properties: { title: { type: "string" }, author: nul("string"), format: { type: "string", enum: FORMATS }, progress_or_hours: nul("string") },
      },
    },
  },
};

const str = (v, n) => (typeof v === "string" && v.trim() ? v.trim().replace(/\s+/g, " ").slice(0, n) : null);
// Claude's answer, checked: strings only, known formats, each book once
export function cleanList(out) {
  if (!out || !Array.isArray(out.books)) return null;
  const seen = new Set(), books = [];
  for (const b of out.books) {
    const title = str(b && b.title, 200); if (!title) continue;
    const author = str(b.author, 200), key = (title + "|" + (author || "")).toLowerCase();
    if (seen.has(key)) continue; seen.add(key);
    books.push({ title, author, format: FORMATS.includes(b.format) ? b.format : "unknown", progress_or_hours: str(b.progress_or_hours, 40) });
    if (books.length >= MAX_BOOKS) break;
  }
  return books;
}

export async function onRequestPost({ request, env, data }) {
  if (!env.ANTHROPIC_API_KEY) return json({ error: "Reading screenshots isn't available yet.", reason: "not-configured" }, 503);
  const pic = await readImage(request); if (pic.error) return json(...pic.error);
  const { image, mediaType, w, h } = pic, { perPerson, perDay } = limits(env);
  const slot = await takeSlot(env.DB, data.email, "screenshot", perPerson, perDay);
  if (!slot.ok) return json(...limitReached(slot, perPerson));
  let res;
  try {
    res = await askClaude(env, {
      model: MODEL,
      max_tokens: 1000,
      system: SYSTEM,
      output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: mediaType, data: image } },
        { type: "text", text: `List the books in this picture (${w}×${h} pixels).` },
      ] }],
    });
  } catch (err) {
    await giveBack(env.DB, data.email, "screenshot").catch(() => {});
    return json(...claudeFailure(err));
  }
  const left = Math.max(0, perPerson - slot.mine);
  if (res.stop_reason === "max_tokens")
    return json({ error: "That picture has more books than Earmark can read at once. Try a screenshot of fewer books.", reason: "too-many", left }, 422);
  if (res.stop_reason === "refusal") return json({ error: "Couldn't read books from that picture.", reason: "unreadable", left }, 422);
  let out = null;
  try { out = JSON.parse((res.content.find(b => b.type === "text") || {}).text || "null"); } catch { out = null; }
  const books = cleanList(out);
  if (!books) return json({ error: "Couldn't read books from that picture.", reason: "unreadable", left }, 422);
  return json({ books, left, usage: res.usage ? { input: res.usage.input_tokens, output: res.usage.output_tokens } : null });
}
