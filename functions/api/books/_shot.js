/* What the two screenshot readers share: screenshot.js (one book's page) and read-list.js (a list, library or shelf).
   Every picture counts once toward the same limits: SCREENSHOT_PER_PERSON a day for each person (default 20) and
   SCREENSHOT_PER_DAY for everyone together (default 200). With the $5 monthly spend limit set at Anthropic as the
   last stop, a month at the full limit costs about $4. */
const MAX_BASE64 = 6_800_000;   // about 5 MB; the app sends a JPEG of a few hundred KB
const TYPES = { "image/jpeg": [0xff, 0xd8, 0xff], "image/png": [0x89, 0x50, 0x4e, 0x47], "image/webp": [0x52, 0x49, 0x46, 0x46] };

export const limits = env => ({ perPerson: +env.SCREENSHOT_PER_PERSON || 20, perDay: +env.SCREENSHOT_PER_DAY || 200 });

// the request's picture → { image, mediaType, w, h }, or { error: [body, status] }
export async function readImage(request) {
  let body; try { body = await request.json(); } catch { return { error: [{ error: "That request couldn't be read." }, 400] }; }
  const image = typeof (body && body.image) === "string" ? body.image : "", mediaType = body && body.mediaType;
  const w = Math.round(+body.width) || 0, h = Math.round(+body.height) || 0;
  const bad = { error: [{ error: "Send a JPEG, PNG or WebP image.", reason: "bad-image" }, 400] };
  if (!TYPES[mediaType] || !image) return bad;
  if (image.length > MAX_BASE64) return { error: [{ error: "That picture is too large (5 MB at most).", reason: "too-large" }, 413] };
  let head; try { head = Uint8Array.from(atob(image.slice(0, 16)), c => c.charCodeAt(0)); } catch { head = new Uint8Array(); }
  if (!TYPES[mediaType].every((v, i) => head[i] === v)) return bad;
  return { image, mediaType, w, h };
}

// a cover's box from Claude, kept inside the picture → { x, y, width, height }, or null when it's missing or too small
export function coverBox(b, w, h, min = 40) {
  if (!b || ![b.x, b.y, b.width, b.height].every(Number.isFinite) || !(w > 0 && h > 0)) return null;
  const x = Math.max(0, Math.round(b.x)), y = Math.max(0, Math.round(b.y));
  const cw = Math.min(w - x, Math.round(b.width)), ch = Math.min(h - y, Math.round(b.height));
  return cw >= min && ch >= min ? { x, y, width: cw, height: ch } : null;
}

export function limitReached(slot, perPerson) {
  return [slot.all
    ? { error: "Earmark has read as many screenshots as it can today. Try again tomorrow, or type the title.", reason: "limit-everyone" }
    : { error: `You've read ${perPerson} screenshots today, the most for one day. Try again tomorrow, or type the title.`, reason: "limit-person", limit: perPerson }, 429];
}

// a failed request to Claude → the answer for the app (the key itself is never in what's logged)
export function claudeFailure(err) {
  const s = err && err.status;
  if (s === 401 || s === 403) {
    console.error("screenshot: Anthropic refused the key", s);
    return [{ error: "Reading screenshots isn't set up yet.", reason: "not-configured" }, 503];
  }
  if (s === 400 || s === 402 || s === 429) {   // includes a spend limit being reached
    console.error("screenshot: Anthropic declined", s, err.type, String(err.message || "").slice(0, 120));
    return [{ error: "Reading screenshots is paused for now. Type the title instead.", reason: "paused" }, 503];
  }
  console.error("screenshot: Anthropic unavailable", s, err && err.type);
  return [{ error: "Couldn't read the screenshot just now. Try again, or type the title.", reason: "unavailable" }, 503];
}
