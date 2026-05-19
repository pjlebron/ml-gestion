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

async function requestDiagnostic({ name, url, token, method = 'GET', body = null }) {
  const startedAt = Date.now();

  try {
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
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
      method,
      url,
      body,
      status: response.status,
      ok: response.ok,
      ms: Date.now() - startedAt,
      data,
    };
  } catch (error) {
    return {
      name,
      method,
      url,
      body,
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

function getResultsCount(data) {
  if (Array.isArray(data)) return data.length;
  if (Array.isArray(data?.results)) return data.results.length;
  if (Array.isArray(data?.campaigns)) return data.campaigns.length;
  if (Array.isArray(data?.items)) return data.items.length;
  if (Array.isArray(data?.ads)) return data.ads.length;
  return null;
}

function compactEndpointResult(endpoint) {
  return {
    name: endpoint.name,
    method: endpoint.method,
    status: endpoint.status,
    ok: endpoint.ok,
    results_count: getResultsCount(endpoint.data),
    error: endpoint.data?.error || endpoint.error || null,
    message: endpoint.data?.message || endpoint.data?.description || null,
    url: endpoint.url,
    body: endpoint.body || null,
  };
}

async function discoverAdvertiser(token) {
  const tests = [
    {
      name: 'Advertisers PADS',
      method: 'GET',
      url: `${ML_API}/advertising/advertisers?product_id=PADS`,
    },
    {
      name: 'Advertisers PLA',
      method: 'GET',
      url: `${ML_API}/advertising/advertisers?product_id=PLA`,
    },
    {
      name: 'Advertisers sin product_id',
      method: 'GET',
      url: `${ML_API}/advertising/advertisers`,
    },
  ];

  const endpoints = [];
  let advertisers = [];

  for (const test of tests) {
    const result = await requestDiagnostic({ ...test, token });
    endpoints.push(result);

    const found = findAdvertisersFromResponse(result.data);
    if (found.length) advertisers = advertisers.concat(found);
  }

  const unique = [];
  const seen = new Set();

  for (const advertiser of advertisers) {
    const id = getAdvertiserId(advertiser);
    const key = String(id || JSON.stringify(advertiser));
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(advertiser);
  }

  return {
    endpoints,
    advertisers: unique,
    advertiser_id: getAdvertiserId(unique[0]),
  };
}

function buildSafePostCandidates({ advertiserId, desde, hasta }) {
  const today = hasta || new Date().toISOString().slice(0, 10);
  const dateFrom = desde || '2026-01-01';

  const basicBody = {
    advertiser_id: advertiserId,
    limit: 5,
    offset: 0,
  };

  const dateBody = {
    advertiser_id: advertiserId,
    date_from: dateFrom,
    date_to: today,
    group_by: 'ITEM',
    limit: 5,
    offset: 0,
  };

  const onlyPaginationBody = {
    limit: 5,
    offset: 0,
  };

  return [
    // Control real de token. No cuenta como Ads útil.
    {
      name: 'Control token: usuario ML',
      method: 'GET',
      url: `${ML_API}/users/${advertiserId}`,
      is_control: true,
    },

    // GET con advertiser en query.
    {
      name: 'GET campaigns root',
      method: 'GET',
      url: `${ML_API}/advertising/product_ads/campaigns?advertiser_id=${advertiserId}&limit=5&offset=0`,
    },
    {
      name: 'GET campaigns search',
      method: 'GET',
      url: `${ML_API}/advertising/product_ads/campaigns/search?advertiser_id=${advertiserId}&limit=5&offset=0`,
    },
    {
      name: 'GET items root',
      method: 'GET',
      url: `${ML_API}/advertising/product_ads/items?advertiser_id=${advertiserId}&limit=5&offset=0`,
    },
    {
      name: 'GET ads root',
      method: 'GET',
      url: `${ML_API}/advertising/product_ads/ads?advertiser_id=${advertiserId}&limit=5&offset=0`,
    },

    // POST search seguros. No crean campaña, solo buscan/listan.
    {
      name: 'POST campaigns search body advertiser',
      method: 'POST',
      url: `${ML_API}/advertising/product_ads/campaigns/search`,
      body: basicBody,
    },
    {
      name: 'POST campaigns search advertiser path',
      method: 'POST',
      url: `${ML_API}/advertising/product_ads/advertisers/${advertiserId}/campaigns/search`,
      body: onlyPaginationBody,
    },
    {
      name: 'POST items search body advertiser',
      method: 'POST',
      url: `${ML_API}/advertising/product_ads/items/search`,
      body: basicBody,
    },
    {
      name: 'POST items search advertiser path',
      method: 'POST',
      url: `${ML_API}/advertising/product_ads/advertisers/${advertiserId}/items/search`,
      body: onlyPaginationBody,
    },
    {
      name: 'POST ads search body advertiser',
      method: 'POST',
      url: `${ML_API}/advertising/product_ads/ads/search`,
      body: basicBody,
    },
    {
      name: 'POST ads search advertiser path',
      method: 'POST',
      url: `${ML_API}/advertising/product_ads/advertisers/${advertiserId}/ads/search`,
      body: onlyPaginationBody,
    },

    // Reportes / métricas por POST.
    {
      name: 'POST reports performance body advertiser',
      method: 'POST',
      url: `${ML_API}/advertising/product_ads/reports/performance`,
      body: dateBody,
    },
    {
      name: 'POST reports performance advertiser path',
      method: 'POST',
      url: `${ML_API}/advertising/product_ads/advertisers/${advertiserId}/reports/performance`,
      body: {
        date_from: dateFrom,
        date_to: today,
        group_by: 'ITEM',
        limit: 5,
        offset: 0,
      },
    },
    {
      name: 'POST metrics body advertiser',
      method: 'POST',
      url: `${ML_API}/advertising/product_ads/metrics`,
      body: dateBody,
    },
    {
      name: 'POST metrics advertiser path',
      method: 'POST',
      url: `${ML_API}/advertising/product_ads/advertisers/${advertiserId}/metrics`,
      body: {
        date_from: dateFrom,
        date_to: today,
        group_by: 'ITEM',
        limit: 5,
        offset: 0,
      },
    },
  ];
}

async function diagnoseAccount(accountKey, req, res, query) {
  const token = await getValidToken(req, res, accountKey);

  const result = {
    account: accountKey,
    label: getAccountLabel(accountKey),
    connected: Boolean(token),
    user_id: token?.user_id || null,
    advertiser_discovered: false,
    advertiser_id: null,
    advertisers: [],
    advertiser_discovery: [],
    endpoints_tested: [],
    working_endpoints: [],
    working_ads_endpoints: [],
    compact: [],
    conclusion: null,
  };

  if (!token) {
    result.conclusion = 'Cuenta sin token. Reconectar con /api/login?account=' + accountKey;
    return result;
  }

  const discovery = await discoverAdvertiser(token);
  result.advertiser_discovery = discovery.endpoints;
  result.advertisers = discovery.advertisers;
  result.advertiser_id = discovery.advertiser_id;
  result.advertiser_discovered = Boolean(discovery.advertiser_id);

  if (!discovery.advertiser_id) {
    result.compact = discovery.endpoints.map(compactEndpointResult);
    result.conclusion = 'El token funciona, pero no se pudo obtener advertiser_id. Revisar permisos de Ads o producto habilitado.';
    return result;
  }

  const candidates = buildSafePostCandidates({
    advertiserId: discovery.advertiser_id,
    desde: query.desde,
    hasta: query.hasta,
  });

  for (const candidate of candidates) {
    const endpointResult = await requestDiagnostic({
      ...candidate,
      token,
    });

    endpointResult.is_control = Boolean(candidate.is_control);
    result.endpoints_tested.push(endpointResult);

    if (endpointResult.ok) {
      result.working_endpoints.push(endpointResult);
      if (!candidate.is_control) result.working_ads_endpoints.push(endpointResult);
    }
  }

  result.compact = [
    ...discovery.endpoints.map(compactEndpointResult),
    ...result.endpoints_tested.map(compactEndpointResult),
  ];

  if (result.working_ads_endpoints.length) {
    result.conclusion = 'Hay endpoints reales de Ads funcionando. Usar working_ads_endpoints para reescribir api/ads.js.';
  } else if (result.working_endpoints.length) {
    result.conclusion = 'Solo funciona el control de token. No hay endpoint útil de Ads todavía.';
  } else {
    result.conclusion = 'Se encontró advertiser_id, pero ningún endpoint probado devolvió 200.';
  }

  return result;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  const { account = 'all', compact = '1' } = req.query;
  const requestedAccounts = getRequestedAccounts(account);

  try {
    const accounts = {};

    for (const accountKey of requestedAccounts) {
      accounts[accountKey] = await diagnoseAccount(accountKey, req, res, req.query);
    }

    if (compact === '1') {
      const compactAccounts = {};

      Object.entries(accounts).forEach(([key, accountData]) => {
        compactAccounts[key] = {
          account: accountData.account,
          label: accountData.label,
          connected: accountData.connected,
          user_id: accountData.user_id,
          advertiser_discovered: accountData.advertiser_discovered,
          advertiser_id: accountData.advertiser_id,
          working_endpoints_count: accountData.working_endpoints.length,
          working_ads_endpoints_count: accountData.working_ads_endpoints.length,
          working_endpoints: accountData.working_endpoints.map(compactEndpointResult),
          working_ads_endpoints: accountData.working_ads_endpoints.map(compactEndpointResult),
          compact: accountData.compact,
          conclusion: accountData.conclusion,
        };
      });

      return res.status(200).json({
        ok: true,
        mode: 'compact',
        requested_account: account,
        accounts: compactAccounts,
        summary: {
          connected_accounts: Object.values(accounts).filter(a => a.connected).length,
          advertiser_discovered_accounts: Object.values(accounts).filter(a => a.advertiser_discovered).length,
          working_accounts: Object.values(accounts).filter(a => a.working_ads_endpoints.length > 0).length,
          total_accounts: Object.keys(accounts).length,
        },
      });
    }

    return res.status(200).json({
      ok: true,
      mode: 'full',
      requested_account: account,
      accounts,
      summary: {
        connected_accounts: Object.values(accounts).filter(a => a.connected).length,
        advertiser_discovered_accounts: Object.values(accounts).filter(a => a.advertiser_discovered).length,
        working_accounts: Object.values(accounts).filter(a => a.working_ads_endpoints.length > 0).length,
        total_accounts: Object.keys(accounts).length,
      },
      instructions: [
        'working_endpoints incluye controles como /users.',
        'working_ads_endpoints solo incluye endpoints útiles de Mercado Ads.',
        'Si working_ads_endpoints_count es 0, todavía no hay endpoint de Ads utilizable.',
        'compact=0 devuelve respuestas completas.',
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
