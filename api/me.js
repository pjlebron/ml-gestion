import {
  getAccountKeys,
  getAccountLabel,
  getValidToken,
} from './_token.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  const accounts = {};
  const cookiesToSet = [];

  const originalSetHeader = res.setHeader.bind(res);

  res.setHeader = (name, value) => {
    if (String(name).toLowerCase() === 'set-cookie') {
      if (Array.isArray(value)) {
        cookiesToSet.push(...value);
      } else {
        cookiesToSet.push(value);
      }
      return;
    }

    originalSetHeader(name, value);
  };

  for (const account of getAccountKeys()) {
    const token = await getValidToken(req, res, account);

    accounts[account] = {
      account,
      label: getAccountLabel(account),
      connected: !!token,
      user_id: token?.user_id || null,
    };
  }

  if (cookiesToSet.length) {
    originalSetHeader('Set-Cookie', cookiesToSet);
  }

  const connectedAccounts = Object.values(accounts).filter(account => account.connected);

  res.status(200).json({
    connected: connectedAccounts.length > 0,
    all_connected: connectedAccounts.length === Object.keys(accounts).length,
    connected_count: connectedAccounts.length,
    total_accounts: Object.keys(accounts).length,
    accounts,
  });
}
