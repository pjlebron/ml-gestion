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

export function buildTokenCookie(account, token) {
  const safeAccount = normalizeAccount(account);
  const { cookieName } = getAccountConfig(safeAccount);
  const tokenPayload = encodeToken(token);

  return `${cookieName}=${tokenPayload}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${60 * 60 * 24 * 30}`;
}

export function clearTokenCookie(account) {
  const safeAccount = normalizeAccount(account);
  const { cookieName } = getAccountConfig(safeAccount);

  return `${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

export function getToken(req, account = DEFAULT_ACCOUNT) {
  const safeAccount = normalizeAccount(account);
  const { cookieName } = getAccountConfig(safeAccount);
  const cookies = parseCookies(req);

  if (!cookies[cookieName]) return null;

  return decodeToken(cookies[cookieName]);
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

export async function getValidToken(req, res, account = DEFAULT_ACCOUNT) {
  const safeAccount = normalizeAccount(account);
  const token = getToken(req, safeAccount);

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

  res.setHeader('Set-Cookie', buildTokenCookie(safeAccount, updated));

  return updated;
}

export async function getValidTokens(req, res, accounts = getAccountKeys()) {
  const result = {};
  const cookiesToSet = [];

  for (const account of accounts) {
    const safeAccount = normalizeAccount(account);
    const token = getToken(req, safeAccount);

    if (!token) continue;

    if (Date.now() < token.expires - 60000) {
      result[safeAccount] = token;
      continue;
    }

    const refreshed = await refreshToken(token);
    if (refreshed.error) continue;

    const updated = {
      access_token: refreshed.access_token,
      refresh_token: refreshed.refresh_token || token.refresh_token,
      user_id: token.user_id,
      expires: Date.now() + refreshed.expires_in * 1000,
    };

    cookiesToSet.push(buildTokenCookie(safeAccount, updated));
    result[safeAccount] = updated;
  }

  if (cookiesToSet.length) {
    res.setHeader('Set-Cookie', cookiesToSet);
  }

  return result;
}
