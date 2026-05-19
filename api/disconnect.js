import {
  clearLegacyTokenCookie,
  clearTokenCookie,
  getAccountKeys,
  normalizeAccount,
} from './_token.js';

import {
  deleteMlToken,
  isSupabaseConfigured,
} from './_supabase.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  const { account = 'all' } = req.query;

  const accountsToDelete =
    account === 'all'
      ? getAccountKeys()
      : [normalizeAccount(account)];

  const cookies = [];

  for (const accountKey of accountsToDelete) {
    cookies.push(clearTokenCookie(accountKey));

    if (accountKey === 'lebron') {
      cookies.push(clearLegacyTokenCookie());
    }

    if (isSupabaseConfigured()) {
      try {
        await deleteMlToken(accountKey);
      } catch (error) {
        console.error(`Error eliminando token ${accountKey}:`, error.message);
      }
    }
  }

  res.setHeader('Set-Cookie', cookies);

  res.status(200).json({
    ok: true,
    deleted_accounts: accountsToDelete,
    message: 'Tokens eliminados de Supabase y cookies limpiadas.',
  });
}
