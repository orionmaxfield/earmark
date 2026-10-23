/* One request to Claude's Messages API, over HTTPS. Earmark's Pages project has no install step, and the setting
   that would add one is shared with Production, so this calls the HTTP API directly rather than through Anthropic's
   SDK. The key comes from the environment and goes only into the request header: it's never logged or returned.
   One retry when the service is overloaded or unreachable; none when a spend limit stops the request.
   ANTHROPIC_BASE_URL_TEST points at a stand-in for local tests and is never set on Cloudflare. */
export class ClaudeError extends Error {
  constructor(status, type, message) { super(message); this.status = status; this.type = type; }
}
export async function askClaude(env, body, { timeout = 30000, retries = 1 } = {}) {
  const url = `${env.ANTHROPIC_BASE_URL_TEST || "https://api.anthropic.com"}/v1/messages`;
  for (let attempt = 0; ; attempt++) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), timeout);
    let res;
    try {
      res = await fetch(url, { method: "POST", signal: ctl.signal, body: JSON.stringify(body),
        headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2026-10-21" } });
    } catch (err) {
      if (attempt < retries) continue;
      throw new ClaudeError(0, "connection_error", err && err.name === "AbortError" ? "timed out" : "unreachable");
    } finally { clearTimeout(timer); }
    const data = await res.json().catch(() => null);
    if (res.ok && data) return data;
    const type = (data && data.error && data.error.type) || "api_error", message = (data && data.error && data.error.message) || `HTTP ${res.status}`;
    const again = res.status === 529 || res.status >= 500 || (res.status === 429 && res.headers.get("retry-after"));
    if (again && attempt < retries) { await new Promise(r => setTimeout(r, 800)); continue; }
    throw new ClaudeError(res.status, type, message);
  }
}
