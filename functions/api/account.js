import { json } from "./_middleware.js";

// DELETE /api/account: erases everything this account has on the server
export async function onRequestDelete({ env, data }) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM records WHERE email = ?1").bind(data.email),
    env.DB.prepare("DELETE FROM users WHERE email = ?1").bind(data.email),
  ]);
  return json({ deleted: true });
}
