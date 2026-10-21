import { json } from "../_middleware.js";
import { saveBooks } from "./_library.js";

/* POST /api/books/remember  { kind: "manual" | "import", books: [{ t, author, narrator, series, num, minutes, cover, asin, isbn }] }
   Books someone added by hand or imported go into Earmark's book table so the library grows. Only facts about the
   book are kept (nothing about who sent it), and because they come from people rather than a catalog they're never
   shown in search until a catalog confirms the same book. At most 500 at a time. */
export async function onRequestPost({ request, env }) {
  let body; try { body = await request.json(); } catch { return json({ error: "That request couldn't be read." }, 400); }
  const books = Array.isArray(body && body.books) ? body.books : [];
  if (books.length > 500) return json({ error: "Send at most 500 books at a time." }, 413);
  const saved = await saveBooks(env.DB, books, body.kind === "import" ? "import" : "manual");
  return json({ saved });
}
