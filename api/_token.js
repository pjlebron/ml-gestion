export function getToken(req) {
  const cookie = req.headers.cookie || '';
  const match = cookie.match(/ml_token=([^;]+)/);
  if (!match) return null;
  try {
    return JSON.parse(Buffer.from(match[1], 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

export async function refreshToken(token) {
  const { ML_APP_ID, ML_CLIENT_SECRET } = process.env;
  const response = await fetch('https://api.mercadolibre.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: ML_APP_ID,
      client_secret: ML_CLIENT_SECRET,
      refresh_token: token.refresh_token,
    }),
  });
  return response.json();
}

export async function getValidToken(req, res) {
  const token = getToken(req);
  if (!token) return null;

  if (Date.now() < token.expires - 60000) return token;

  const refreshed = await refreshToken(token);
  if (refreshed.error) return null;

  const updated = {
    access_token: refreshed.access_token,
    refresh_token: refreshed.refresh_token || token.refresh_token,
    user_id: token.user_id,
    expires: Date.now() + refreshed.expires_in * 1000,
  };

  const tokenPayload = Buffer.from(JSON.stringify(updated)).toString('base64');
  res.setHeader('Set-Cookie', `ml_token=${tokenPayload}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${60 * 60 * 24 * 30}`);
  return updated;
}
