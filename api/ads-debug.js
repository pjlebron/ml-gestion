import {
  getAccountKeys,
  getAccountLabel,
  getValidToken,
  normalizeAccount,
} from './_token.js';

const ML_API = 'https://api.mercadolibre.com';

function getRequestedAccounts(accountQuery) {
  if (!accountQuery || accountQuery === 'all') return getAccountKeys();
  return [normalizeAccount(accountQuery)];
}

async function fetchDiagnostic(name, url, token) {
  const startedAt = Date.now();

  try {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token.access_token}`,
      },
    });

    const contentType = response.headers.get('content-type') || '';
    let data;

    if (contentType.includes('application/json')) {
      data = await response.json().catch(() => null);
    } else {
      data = await response.text().catch(() => null);
    }

    return {
      name,
      url,
      status: response.status,
      ok: response.ok,
      ms: Date.now() - startedAt,
      data,
    };
  } catch (error) {
    return {
      name,
      url,
      status: null,
      ok: false,
      ms: Date.now() - startedAt,
      error: error.message,
    };
  }
}

function findAdvertisersFromResponse(data) {
  if (!data) return [];

  if (Array.isArray(data)) return data;
  if (Array.isArray(data.advertisers)) return data.advertisers;
  if (Array.isArray(data.results)) return data.results;

  if (data.advertiser_id || data.id) return [data];

  return [];
}

function getAdvertiserId(candidate) {
  if (!candidate) return null;
  return candidate.advertiser_id || candidate.id || candidate.user_id || null;
}

async function diagnoseAccount(accountKey, req, res) {
  const token = await getValidToken(req, res, accountKey);

  const result = {
    account: accountKey,
    label: getAccountLabel(accountKey),
    connected: Boolean(token),
    user_id: token?.user_id || null,
    advertiser_discovered: false,
    advertiser_id: null,
    advertisers: [],
    endpoints_tested: [],
    next_step: null,
  };

  if (!token) {
    result.next_step = 'Reconectar esta cuenta con /api/login?account=' + accountKey;
    return result;
  }

  const baseTests = [
    {
      name: 'Control token: usuario ML',
      url: `${ML_API}/users/${token.user_id}`,
    },
    {
      name: 'Advertisers PADS',
      url: `${ML_API}/advertising/advertisers?product_id=PADS`,
    },
    {
      name: 'Advertisers sin product_id',
      url: `${ML_API}/advertising/advertisers`,
    },
    {
      name: 'Product Ads performance actual',
      url: `${ML_API}/advertising/product_ads/reports/performance?advertiser_id=${token.user_id}&date_from=2026-01-01&date_to=${new Date().toISOString().slice(0, 10)}&group_by=ITEM&limit=5`,
    },
    {
      name: 'Product Ads campaigns posible',
      url: `${ML_API}/advertising/product_ads/campaigns?advertiser_id=${token.user_id}&limit=5`,
    },
    {
      name: 'Product Ads items posible',
      url: `${ML_API}/advertising/product_ads/items?advertiser_id=${token.user_id}&limit=5`,
    },
  ];

  for (const test of baseTests) {
    const diagnostic = await fetchDiagnostic(test.name, test.url, token);
    result.endpoints_tested.push(diagnostic);

    if (test.name.includes('Advertisers')) {
      const advertisers = findAdvertisersFromResponse(diagnostic.data);
      if (advertisers.length) {
        result.advertisers.push(...advertisers);
      }
    }
  }

  const firstAdvertiser = result.advertisers.find(a => getAdvertiserId(a));
  const advertiserId = getAdvertiserId(firstAdvertiser);

  if (advertiserId) {
    result.advertiser_discovered = true;
    result.advertiser_id = advertiserId;

    const advertiserTests = [
      {
        name: 'Performance con advertiser_id detectado',
        url: `${ML_API}/advertising/product_ads/reports/performance?advertiser_id=${advertiserId}&date_from=2026-01-01&date_to=${new Date().toISOString().slice(0, 10)}&group_by=ITEM&limit=5`,
      },
      {
        name: 'Campaigns con advertiser_id detectado',
        url: `${ML_API}/advertising/product_ads/campaigns?advertiser_id=${advertiserId}&limit=5`,
      },
      {
        name: 'Items con advertiser_id detectado',
        url: `${ML_API}/advertising/product_ads/items?advertiser_id=${advertiserId}&limit=5`,
      },
    ];

    for (const test of advertiserTests) {
      const diagnostic = await fetchDiagnostic(test.name, test.url, token);
      result.endpoints_tested.push(diagnostic);
    }

    result.next_step = 'Usar advertiser_id detectado si algún endpoint de Product Ads devuelve status 200.';
  } else {
    result.next_step = 'No se detectó advertiser_id. Revisar permisos de la app en Mercado Libre Developers o endpoint correcto de Mercado Ads.';
  }

  return result;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  const { account = 'all' } = req.query;
  const requestedAccounts = getRequestedAccounts(account);

  try {
    const accounts = {};

    for (const accountKey of requestedAccounts) {
      accounts[accountKey] = await diagnoseAccount(accountKey, req, res);
    }

    res.status(200).json({
      ok: true,
      requested_account: account,
      accounts,
      summary: {
        connected_accounts: Object.values(accounts).filter(a => a.connected).length,
        advertiser_discovered_accounts: Object.values(accounts).filter(a => a.advertiser_discovered).length,
        total_accounts: Object.keys(accounts).length,
      },
      instructions: [
        'Si /users/{user_id} devuelve 200, el token está bien.',
        'Si advertisers devuelve 401/403, faltan permisos o la app no tiene acceso a Mercado Ads.',
        'Si advertisers devuelve 404 o recurso no disponible, el endpoint no corresponde para esta app/API.',
        'No tocar el dashboard hasta detectar un endpoint de Ads con status 200 y datos reales.',
      ],
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: 'Error diagnosticando Mercado Ads',
      detail: error.message,
    });
  }
}
