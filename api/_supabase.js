const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function assertSupabaseConfig() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Faltan variables SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en Vercel');
  }
}

function getHeaders(extra = {}) {
  assertSupabaseConfig();

  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

function tokenRowToAppToken(row) {
  if (!row) return null;

  return {
    access_token: row.access_token,
    refresh_token: row.refresh_token,
    user_id: row.user_id,
    expires: new Date(row.expires_at).getTime(),
  };
}

function appTokenToRow(account, label, token) {
  return {
    account,
    label,
    user_id: token.user_id || null,
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    expires_at: new Date(token.expires).toISOString(),
    updated_at: new Date().toISOString(),
  };
}

export function isSupabaseConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
}

export async function getMlToken(account) {
  assertSupabaseConfig();

  const url = `${SUPABASE_URL}/rest/v1/ml_tokens?account=eq.${encodeURIComponent(account)}&select=*`;

  const response = await fetch(url, {
    method: 'GET',
    headers: getHeaders(),
  });

  const data = await response.json().catch(() => []);

  if (!response.ok) {
    throw new Error(data.message || data.error || 'Error leyendo token de Supabase');
  }

  const row = Array.isArray(data) ? data[0] : null;

  if (!row) return null;
  if (!row.access_token || !row.refresh_token) return null;
  if (row.access_token === 'pending' || row.refresh_token === 'pending') return null;

  return tokenRowToAppToken(row);
}

export async function getAllMlTokens(accounts = []) {
  assertSupabaseConfig();

  const result = {};

  for (const account of accounts) {
    const token = await getMlToken(account);
    if (token) result[account] = token;
  }

  return result;
}

export async function saveMlToken(account, label, token) {
  assertSupabaseConfig();

  const row = appTokenToRow(account, label, token);

  // UPSERT REAL:
  // Si account ya existe, actualiza la fila.
  // Si account no existe, la crea.
  // Sin esto Supabase tira duplicate key y se hace el ofendido.
  const url = `${SUPABASE_URL}/rest/v1/ml_tokens?on_conflict=account`;

  const response = await fetch(url, {
    method: 'POST',
    headers: getHeaders({
      Prefer: 'resolution=merge-duplicates,return=representation',
    }),
    body: JSON.stringify(row),
  });

  const data = await response.json().catch(() => []);

  if (!response.ok) {
    throw new Error(data.message || data.error || 'Error guardando token en Supabase');
  }

  return Array.isArray(data) ? data[0] : data;
}

export async function deleteMlToken(account) {
  assertSupabaseConfig();

  const url = `${SUPABASE_URL}/rest/v1/ml_tokens?account=eq.${encodeURIComponent(account)}`;

  const response = await fetch(url, {
    method: 'DELETE',
    headers: getHeaders({
      Prefer: 'return=minimal',
    }),
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.message || data.error || 'Error eliminando token de Supabase');
  }

  return true;
}

export async function getMlTokenStatus(accounts = []) {
  assertSupabaseConfig();

  const result = {};

  for (const account of accounts) {
    const token = await getMlToken(account);

    result[account] = {
      connected: Boolean(token),
      user_id: token?.user_id || null,
      expires: token?.expires || null,
      expires_at: token?.expires ? new Date(token.expires).toISOString() : null,
    };
  }

  return result;
}
