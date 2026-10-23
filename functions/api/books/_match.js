/* Matching rules shared by search and lookups: the same relevance rules the app uses, so a source whose results
   are all summaries or unrelated titles counts as "nothing found" and the next source is asked. */
export const JUNK = /\b(summar(y|ies)|workbooks?|analysis|study guides?|notes on|conversation starters|trivia|quiz(zes)?)\b/i;
export const plain = t => String(t || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const SMALL = new Set(["the", "a", "an", "of", "and", "in", "on", "to", "for", "by", "with", "at", "from", "or", "is"]);
// the title (or the author's name) has the main words of the search; the last word may be half typed
export function sharesWords(r, q) {
  const main = plain(q).split(" ").filter(w => w && !SMALL.has(w) && (w.length > 1 || /\d/.test(w)));
  if (!main.length) return true;
  const tw = plain(r.t).split(" "), aw = plain(r.author).split(" "), last = main[main.length - 1];
  const has = (ws, w) => ws.includes(w) || (w === last && w.length >= 2 && ws.some(x => x.startsWith(w)));
  const inTitle = main.filter(w => has(tw, w)).length, byAuthor = main.filter(w => !has(tw, w) && has(aw, w)).length;
  if (!inTitle && byAuthor < main.length) return false;
  return inTitle + byAuthor >= main.length - (main.length >= 3 ? 1 : 0);
}
export const relevant = (list, q) => list.filter(r => r.author && (JUNK.test(q) || !JUNK.test(r.t)) && sharesWords(r, q));
// "title|author" for matching a book when there's no ASIN or ISBN: the title without "(Unabridged)", a subtitle or series
// tag, and the first author
export const matchKey = (t, author) => plain(String(t || "").replace(/\s*\((un)?abridged\)/gi, "").replace(/\s*[:(].*$/, "")) + "|" + plain(String(author || "").split(",")[0]);
