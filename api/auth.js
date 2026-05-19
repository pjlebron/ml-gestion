import {
  buildLegacyTokenCookie,
  buildTokenCookie,
  getAccountLabel,
  normalizeAccount,
} from './_token.js';

export default async function handler(req, res) {
  const { code, state } = req.query;

  if (!code) {
    return res.status(400).json({ error: 'Falta el código de autorización' });
  }

  const account = normalizeAccount(state || 'lebron');
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

    if (data.error) {
      return res.status(400).json({ error: data.error, message: data.message });
    }

    const { access_token, refresh_token, user_id, expires_in } = data;
    const expires = Date.now() + expires_in * 1000;

    const token = {
      access_token,
      refresh_token,
      user_id,
      expires,
    };

    const cookies = [buildTokenCookie(account, token)];

    // Compatibilidad con el sistema actual: Lebron Store también se guarda
    // como ml_token para que las partes viejas no se rompan.
    if (account === 'lebron') {
      cookies.push(buildLegacyTokenCookie(token));
    }

    res.setHeader('Set-Cookie', cookies);
    res.redirect(`/?connected=1&account=${encodeURIComponent(account)}&label=${encodeURIComponent(getAccountLabel(account))}`);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener el token', detail: err.message });
  }
}
