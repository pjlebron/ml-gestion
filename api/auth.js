export default async function handler(req, res) {
  const { code } = req.query;
  if (!code) return res.status(400).json({ error: 'Falta el código de autorización' });

  const { ML_APP_ID, ML_CLIENT_SECRET, ML_REDIRECT_URI } = process.env;

  try {
    const response = await fetch('https://api.mercadolibre.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: ML_APP_ID,
        client_secret: ML_CLIENT_SECRET,
        code,
        redirect_uri: ML_REDIRECT_URI,
      }),
    });

    const data = await response.json();

    if (data.error) return res.status(400).json({ error: data.error, message: data.message });

    const { access_token, refresh_token, user_id, expires_in } = data;
    const expires = Date.now() + expires_in * 1000;

    const tokenPayload = Buffer.from(JSON.stringify({ access_token, refresh_token, user_id, expires })).toString('base64');

    res.setHeader('Set-Cookie', `ml_token=${tokenPayload}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${60 * 60 * 24 * 30}`);
    res.redirect('/?connected=1');
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener el token', detail: err.message });
  }
}
