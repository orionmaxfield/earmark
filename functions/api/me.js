import { json, touchUser } from "./_middleware.js";

// GET /api/me: the signed-in email and when the account was created (null until a device has sent data)
export async function onRequestGet({ env, data }) {
  await touchUser(env.DB, data.email).run();
  const user = await env.DB.prepare("SELECT email, created FROM users WHERE email = ?1").bind(data.email).first();
  return json({ email: data.email, created: user ? user.created : null });
}
