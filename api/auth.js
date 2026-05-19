import {
  buildLegacyTokenCookie,
  buildTokenCookie,
  getAccountLabel,
  normalizeAccount,
} from './_token.js';

import {
  isSupabaseConfigured,
  saveMlToken,
} from './_supabase.js';

export default async function handler(req, res) {
  const { code, state } = req.query;

  if (!code) {
    return res.status(400).json({ error: 'Falta el código de autorización' });
  }

  const account = normalizeAccount(state || 'lebron');
  const label = getAccountLabel(account);
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
      return res.status(400).json({
        error: data.error,
        message: data.message,
      });
    }

    const { access_token, refresh_token, user_id, expires_in } = data;

    if (!access_token || !refresh_token) {
      return res.status(400).json({
        error: 'Token incompleto',
        message: 'Mercado Libre no devolvió access_token o refresh_token.',
        data,
      });
    }

    const token = {
      access_token,
      refresh_token,
      user_id,
      expires: Date.now() + Number(expires_in || 0) * 1000,
    };

    const cookies = [buildTokenCookie(account, token)];

    // Compatibilidad con el sistema viejo:
    // Lebron Store también queda en ml_token para que nada anterior se rompa.
    if (account === 'lebron') {
      cookies.push(buildLegacyTokenCookie(token));
    }

    res.setHeader('Set-Cookie', cookies);

    // Fuente principal nueva: Supabase.
    // Así no dependemos de Chrome, Opera o del navegador donde se conectó cada cuenta.
    if (isSupabaseConfigured()) {
      await saveMlToken(account, label, token);
    }

    res.redirect(`/?connected=1&account=${encodeURIComponent(account)}&label=${encodeURIComponent(label)}`);
  } catch (err) {
    res.status(500).json({
      error: 'Error al obtener o guardar el token',
      detail: err.message,
    });
  }
}
