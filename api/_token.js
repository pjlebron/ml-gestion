import {
  getMlToken,
  isSupabaseConfigured,
  saveMlToken,
} from './_supabase.js';

const ACCOUNT_CONFIG = {
  lebron: {
    label: 'Lebron Store',
    cookieName: 'ml_token_lebron',
  },
  fragantify: {
    label: 'Fragantify',
    cookieName: 'ml_token_fragantify',
  },
};

const DEFAULT_ACCOUNT = 'lebron';
const LEGACY_COOKIE_NAME = 'ml_token';

export function getAccountConfig(account = DEFAULT_ACCOUNT) {
  return ACCOUNT_CONFIG[account] || ACCOUNT_CONFIG[DEFAULT_ACCOUNT];
}

export function getAccountKeys() {
  return Object.keys(ACCOUNT_CONFIG);
}

export function getAccountLabel(account = DEFAULT_ACCOUNT) {
  return getAccountConfig(account).label;
}

export function normalizeAccount(account = DEFAULT_ACCOUNT) {
  return ACCOUNT_CONFIG[account] ? account : DEFAULT_ACCOUNT;
}

function parseCookies(req) {
  const cookieHeader = req.headers.cookie || '';

  return cookieHeader.split(';').reduce((acc, cookie) => {
    const [rawKey, ...rawValue] = cookie.trim().split('=');
    if (!rawKey) return acc;
    acc[rawKey] = rawValue.join('=');
    return acc;
  }, {});
}

function encodeToken(token) {
  return Buffer.from(JSON.stringify(token)).toString('base64');
}

function decodeToken(payload) {
  try {
    return JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function appendSetCookies(res, cookies) {
  if (!res || !res.setHeader || !cookies) return;

  const newCookies = Array.isArray(cookies) ? cookies : [cookies];
  const current = typeof res.getHeader === 'function' ? res.getHeader('Set-Cookie') : null;

  let existingCookies = [];

  if (Array.isArray(current)) {
    existingCookies = current;
  } else if (typeof current === 'string') {
    existingCookies = [current];
  }

  res.setHeader('Set-Cookie', [...existingCookies, ...newCookies]);
}

export function buildTokenCookie(account, token) {
  const safeAccount = normalizeAccount(account);
  const { cookieName } = getAccountConfig(safeAccount);
  const tokenPayload = encodeToken(token);

  return `${cookieName}=${tokenPayload}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${60 * 60 * 24 * 30}`;
}

export function buildLegacyTokenCookie(token) {
  const tokenPayload = encodeToken(token);
  return `${LEGACY_COOKIE_NAME}=${tokenPayload}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${60 * 60 * 24 * 30}`;
}

export function clearTokenCookie(account) {
  const safeAccount = normalizeAccount(account);
  const { cookieName } = getAccountConfig(safeAccount);

  return `${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

export function clearLegacyTokenCookie() {
  return `${LEGACY_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

export function getToken(req, account = DEFAULT_ACCOUNT) {
  const safeAccount = normalizeAccount(account);
  const { cookieName } = getAccountConfig(safeAccount);
  const cookies = parseCookies(req);

  if (cookies[cookieName]) {
    return decodeToken(cookies[cookieName]);
  }

  // Compatibilidad solo para instalaciones sin Supabase.
  // En producción con Supabase NO vamos a usar esta cookie para evitar que una cuenta pise a la otra.
  if (safeAccount === DEFAULT_ACCOUNT && cookies[LEGACY_COOKIE_NAME]) {
    return decodeToken(cookies[LEGACY_COOKIE_NAME]);
  }

  return null;
}

export function getAllTokens(req) {
  return getAccountKeys().reduce((acc, account) => {
    const token = getToken(req, account);
    if (token) acc[account] = token;
    return acc;
  }, {});
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

async function getStoredToken(req, account) {
  const safeAccount = normalizeAccount(account);

  // PRODUCCIÓN: Supabase es la única fuente de verdad.
  // Motivo: las cookies del navegador pueden quedar cruzadas entre Lebron y Fragantify.
  // Si usamos cookies como fallback, /api/me puede volver a migrar un token viejo y pisar Supabase.
  if (isSupabaseConfigured()) {
    try {
      const supabaseToken = await getMlToken(safeAccount);

      return {
        token: supabaseToken,
        source: supabaseToken ? 'supabase' : 'none',
      };
    } catch (error) {
      console.error(`Error leyendo token de Supabase para ${safeAccount}:`, error.message);
      return {
        token: null,
        source: 'none',
      };
    }
  }

  // Fallback solo para entorno local sin Supabase.
  const cookieToken = getToken(req, safeAccount);

  if (cookieToken) {
    return {
      token: cookieToken,
      source: 'cookie',
    };
  }

  return {
    token: null,
    source: 'none',
  };
}

async function saveTokenEverywhere(res, account, token) {
  const safeAccount = normalizeAccount(account);
  const label = getAccountLabel(safeAccount);
  const cookies = [buildTokenCookie(safeAccount, token)];

  // Mantengo esta cookie legacy solo para no romper archivos viejos si todavía existe alguno.
  // Pero getStoredToken ya no la usa cuando Supabase está configurado.
  if (safeAccount === DEFAULT_ACCOUNT) {
    cookies.push(buildLegacyTokenCookie(token));
  }

  appendSetCookies(res, cookies);

  if (isSupabaseConfigured()) {
    try {
      await saveMlToken(safeAccount, label, token);
    } catch (error) {
      console.error(`Error guardando token de ${safeAccount} en Supabase:`, error.message);
    }
  }
}

export async function getValidToken(req, res, account = DEFAULT_ACCOUNT) {
  const safeAccount = normalizeAccount(account);
  const { token } = await getStoredToken(req, safeAccount);

  if (!token) return null;

  if (Date.now() < token.expires - 60000) {
    return token;
  }

  const refreshed = await refreshToken(token);

  if (refreshed.error) {
    console.error(`Error refrescando token de ${safeAccount}:`, refreshed.message || refreshed.error);
    return null;
  }

  const updated = {
    access_token: refreshed.access_token,
    refresh_token: refreshed.refresh_token || token.refresh_token,
    user_id: refreshed.user_id || token.user_id,
    expires: Date.now() + refreshed.expires_in * 1000,
  };

  await saveTokenEverywhere(res, safeAccount, updated);

  return updated;
}

export async function getValidTokens(req, res, accounts = getAccountKeys()) {
  const result = {};

  for (const account of accounts) {
    const safeAccount = normalizeAccount(account);
    const token = await getValidToken(req, res, safeAccount);

    if (token) {
      result[safeAccount] = token;
    }
  }

  return result;
}
