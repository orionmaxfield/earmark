import { json } from "../_middleware.js";
import { askClaude, scrub } from "./_claude.js";
import { takeSlot, giveBack } from "./_usage.js";
import { limits, limitReached } from "./_shot.js";

/* GET /api/books/screenshot-check  Whether this deployment can reach Claude with an image: sends one tiny built-in
   test picture (a 32×32 green square, nothing of anyone's) to the same model the screenshot readers use, and
   reports what came back, how long it took and what it cost. Signed-in only, and it counts as one picture toward
   the daily limit, so it can't run up the bill. The key is never part of the answer. */
const MODEL = "claude-haiku-5-5";
const TEST_PNG = "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR42mPQWNVDU8QwasGoBaMWjFowasGoBaMWjFowasGoBaMWDBULAO1peExBhG7AAAAAAElFTkSuQmCC";
const PRICE = { input: 0.10, output: 0.50 };   // US$ per million tokens, Claude Haiku 5.5

export async function onRequestGet({ env, data }) {
  if (!env.ANTHROPIC_API_KEY) return json({ reachable: false, keySet: false, note: "ANTHROPIC_API_KEY isn't set on this deployment (expected on Production)." });
  const { perPerson, perDay } = limits(env);
  const slot = await takeSlot(env.DB, data.email, "screenshot", perPerson, perDay);
  if (!slot.ok) return json(...limitReached(slot, perPerson));
  const t0 = Date.now();
  try {
    const res = await askClaude(env, {
      model: MODEL, max_tokens: 200, output_config: { effort: "low" },
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: TEST_PNG } },
        { type: "text", text: "What colour is this square? Answer in one word." },
      ] }],
    }, { retries: 0 });
    const u = res.usage || {}, cost = ((u.input_tokens || 0) * PRICE.input + (u.output_tokens || 0) * PRICE.output) / 1e6;
    const answer = scrub((res.content.find(b => b.type === "text") || {}).text || "", env).slice(0, 60);
    return json({ reachable: true, keySet: true, model: res.model || MODEL, ms: Date.now() - t0, answer, stop: res.stop_reason,
      usage: { input: u.input_tokens || 0, output: u.output_tokens || 0 }, estimatedCostUsd: +cost.toFixed(6) });
  } catch (err) {
    await giveBack(env.DB, data.email, "screenshot").catch(() => {});
    return json({ reachable: false, keySet: true, ms: Date.now() - t0, status: err.status || 0, type: err.type || "error", message: scrub(err.message, env).slice(0, 200) }, 502);
  }
}
