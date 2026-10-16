import { json } from "./_middleware.js";

// GET /api/me: the signed-in email and when the account was created
export async function onRequestGet({ env, data }) {
  const user = await env.DB.prepare("SELECT email, created FROM users WHERE email = ?1").bind(data.email).first();
  return json({ email: data.email, created: user ? user.created : null });
}
