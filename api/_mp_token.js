import {
  deleteMpToken,
  getMpToken,
  getMpTokenStatus,
  isSupabaseConfigured,
  saveMpToken,
} from './_supabase.js';

import {
  getAccountKeys,
  getAccountLabel,
  normalizeAccount,
} from './_token.js';

const MP_AUTH_URL = 'https://auth.mercadopago.com.ar/authorization';
const MP_TOKEN_URL = 'https://api.mercadopago.com/oauth/token';

function assertMpConfig() {
  if (!process.env.MP_CLIENT_ID || !process.env.MP_CLIENT_SECRET) {
    throw new Error('Faltan MP_CLIENT_ID o MP_CLIENT_SECRET en Vercel');
  }
}

export function getMpRedirectUri(req) {
  if (process.env.MP_REDIRECT_URI) {
    return process.env.MP_REDIRECT_URI;
  }

  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;

  return `${proto}://${host}/api/mp?action=callback`;
}

function buildState(account) {
  const payload = {
    account: normalizeAccount(account),
    ts: Date.now(),
  };

  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function parseState(state) {
  try {
    const payload = JSON.parse(Buffer.from(String(state || ''), 'base64url').toString('utf8'));
    return normalizeAccount(payload.account);
  } catch {
    return 'lebron';
  }
}

function normalizeMpToken(raw, fallback = {}) {
  const expiresIn = Number(raw.expires_in || 0);

  return {
    access_token: raw.access_token,
    refresh_token: raw.refresh_token || fallback.refresh_token,
    user_id: raw.user_id || raw.collector_id || fallback.user_id || null,
    token_type: raw.token_type || null,
    scope: raw.scope || null,
    live_mode: raw.live_mode ?? null,
    public_key: raw.public_key || null,
    expires: Date.now() + Math.max(expiresIn, 3600) * 1000,
  };
}

async function postMpToken(params) {
  assertMpConfig();

  const response = await fetch(MP_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({
      client_id: process.env.MP_CLIENT_ID,
      client_secret: process.env.MP_CLIENT_SECRET,
      ...params,
    }),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok || data.error) {
    throw new Error(data.message || data.error_description || data.error || `Error Mercado Pago OAuth HTTP ${response.status}`);
  }

  return data;
}

export function buildMpAuthUrl(req, account = 'lebron') {
  assertMpConfig();

  const safeAccount = normalizeAccount(account);
  const redirectUri = getMpRedirectUri(req);

  const params = new URLSearchParams({
    client_id: process.env.MP_CLIENT_ID,
    response_type: 'code',
    platform_id: 'mp',
    redirect_uri: redirectUri,
    state: buildState(safeAccount),
  });

  return `${MP_AUTH_URL}?${params.toString()}`;
}

export async function exchangeMpCodeAndSave({ req, code, state }) {
  if (!isSupabaseConfigured()) {
    throw new Error('Supabase no está configurado. No se puede guardar token Mercado Pago.');
  }

  const account = parseState(state);
  const label = getAccountLabel(account);
  const redirectUri = getMpRedirectUri(req);

  const raw = await postMpToken({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
  });

  const token = normalizeMpToken(raw);

  if (!token.access_token || !token.refresh_token) {
    throw new Error('Mercado Pago no devolvió access_token o refresh_token');
  }

  await saveMpToken(account, label, token);

  return {
    account,
    label,
    user_id: token.user_id,
    expires_at: new Date(token.expires).toISOString(),
    scope: token.scope,
    live_mode: token.live_mode,
    public_key: token.public_key,
  };
}

export async function refreshMpToken(token) {
  const raw = await postMpToken({
    grant_type: 'refresh_token',
    refresh_token: token.refresh_token,
  });

  return normalizeMpToken(raw, token);
}

export async function getValidMpToken(account = 'lebron') {
  const safeAccount = normalizeAccount(account);
  const token = await getMpToken(safeAccount);

  if (!token) return null;

  if (Date.now() < token.expires - 60000) {
    return token;
  }

  const refreshed = await refreshMpToken(token);
  const label = getAccountLabel(safeAccount);

  await saveMpToken(safeAccount, label, refreshed);

  return refreshed;
}

export async function getValidMpTokens(accounts = getAccountKeys()) {
  const result = {};

  for (const account of accounts) {
    const token = await getValidMpToken(account);
    if (token) result[account] = token;
  }

  return result;
}

export async function getMercadoPagoTokenStatus() {
  return getMpTokenStatus(getAccountKeys());
}

export async function disconnectMercadoPago(account = 'lebron') {
  const safeAccount = normalizeAccount(account);
  await deleteMpToken(safeAccount);

  return {
    account: safeAccount,
    label: getAccountLabel(safeAccount),
    disconnected: true,
  };
}
