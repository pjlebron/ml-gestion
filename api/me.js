import { getValidToken } from './_token.js';

export default async function handler(req, res) {
  const token = await getValidToken(req, res);
  if (!token) return res.status(200).json({ connected: false });
  res.status(200).json({ connected: true, user_id: token.user_id });
}
