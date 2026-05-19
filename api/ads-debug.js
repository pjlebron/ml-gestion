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
      method: 'GET',
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
      method: 'GET',
      url,
      status: response.status,
      ok: response.ok,
      ms: Date.now() - startedAt,
      data,
    };
  } catch (error) {
    return {
      name,
      method: 'GET',
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

function compactEndpointResult(endpoint) {
  return {
    name: endpoint.name,
    status: endpoint.status,
    ok: endpoint.ok,
    has_array_data: Array.isArray(endpoint.data),
    has_results: Array.isArray(endpoint.data?.results),
    results_count: Array.isArray(endpoint.data?.results)
      ? endpoint.data.results.length
      : Array.isArray(endpoint.data)
        ? endpoint.data.length
        : null,
    error: endpoint.data?.error || endpoint.error || null,
    message: endpoint.data?.message || endpoint.data?.description || null,
    url: endpoint.url,
  };
}

async function discoverAdvertiser(token) {
  const tests = [
    {
      name: 'Advertisers PADS',
      url: `${ML_API}/advertising/advertisers?product_id=PADS`,
    },
    {
      name: 'Advertisers PLA',
      url: `${ML_API}/advertising/advertisers?product_id=PLA`,
    },
    {
      name: 'Advertisers sin product_id',
      url: `${ML_API}/advertising/advertisers`,
    },
  ];

  const endpoints = [];
  let advertisers = [];

  for (const test of tests) {
    const result = await fetchDiagnostic(test.name, test.url, token);
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

function buildReadOnlyEndpointCandidates({ token, advertiserId, desde, hasta }) {
  const today = hasta || new Date().toISOString().slice(0, 10);
  const dateFrom = desde || '2026-01-01';

  // Solo GET. No probamos POST sobre campaigns porque podría crear/modificar cosas.
  // Sí, por una vez no vamos a tocar botones rojos en producción, qué aburrido pero sano.
  return [
    {
      name: 'User token control',
      url: `${ML_API}/users/${token.user_id}`,
    },

    // Variantes de campañas / listados.
    {
      name: 'Campaigns root con advertiser_id',
      url: `${ML_API}/advertising/product_ads/campaigns?advertiser_id=${advertiserId}&limit=5`,
    },
    {
      name: 'Campaigns search con advertiser_id',
      url: `${ML_API}/advertising/product_ads/campaigns/search?advertiser_id=${advertiserId}&limit=5`,
    },
    {
      name: 'Campaigns por advertiser path',
      url: `${ML_API}/advertising/product_ads/advertisers/${advertiserId}/campaigns?limit=5`,
    },
    {
      name: 'Product Ads campaign listado alternativo',
      url: `${ML_API}/advertising/product_ads/advertiser/${advertiserId}/campaigns?limit=5`,
    },

    // Variantes de items / anuncios.
    {
      name: 'Items root con advertiser_id',
      url: `${ML_API}/advertising/product_ads/items?advertiser_id=${advertiserId}&limit=5`,
    },
    {
      name: 'Items search con advertiser_id',
      url: `${ML_API}/advertising/product_ads/items/search?advertiser_id=${advertiserId}&limit=5`,
    },
    {
      name: 'Items por advertiser path',
      url: `${ML_API}/advertising/product_ads/advertisers/${advertiserId}/items?limit=5`,
    },
    {
      name: 'Ads root con advertiser_id',
      url: `${ML_API}/advertising/product_ads/ads?advertiser_id=${advertiserId}&limit=5`,
    },
    {
      name: 'Ads search con advertiser_id',
      url: `${ML_API}/advertising/product_ads/ads/search?advertiser_id=${advertiserId}&limit=5`,
    },

    // Variantes de performance/reportes.
    {
      name: 'Performance actual',
      url: `${ML_API}/advertising/product_ads/reports/performance?advertiser_id=${advertiserId}&date_from=${dateFrom}&date_to=${today}&group_by=ITEM&limit=5`,
    },
    {
      name: 'Reports root',
      url: `${ML_API}/advertising/product_ads/reports?advertiser_id=${advertiserId}&date_from=${dateFrom}&date_to=${today}&group_by=ITEM&limit=5`,
    },
    {
      name: 'Reports search',
      url: `${ML_API}/advertising/product_ads/reports/search?advertiser_id=${advertiserId}&date_from=${dateFrom}&date_to=${today}&group_by=ITEM&limit=5`,
    },
    {
      name: 'Performance por advertiser path',
      url: `${ML_API}/advertising/product_ads/advertisers/${advertiserId}/reports/performance?date_from=${dateFrom}&date_to=${today}&group_by=ITEM&limit=5`,
    },
    {
      name: 'Metrics root',
      url: `${ML_API}/advertising/product_ads/metrics?advertiser_id=${advertiserId}&date_from=${dateFrom}&date_to=${today}&group_by=ITEM&limit=5`,
    },
    {
      name: 'Metrics por advertiser path',
      url: `${ML_API}/advertising/product_ads/advertisers/${advertiserId}/metrics?date_from=${dateFrom}&date_to=${today}&group_by=ITEM&limit=5`,
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
    advertiser_discovery_endpoints: [],
    endpoints_tested: [],
    working_endpoints: [],
    compact: [],
    conclusion: null,
  };

  if (!token) {
    result.conclusion = 'Cuenta sin token. Reconectar con /api/login?account=' + accountKey;
    return result;
  }

  const discovery = await discoverAdvertiser(token);
  result.advertiser_discovery_endpoints = discovery.endpoints;
  result.advertisers = discovery.advertisers;
  result.advertiser_id = discovery.advertiser_id;
  result.advertiser_discovered = Boolean(discovery.advertiser_id);

  if (!discovery.advertiser_id) {
    result.compact = discovery.endpoints.map(compactEndpointResult);
    result.conclusion = 'El token funciona, pero no se pudo obtener advertiser_id. Revisar permisos de Ads o producto habilitado.';
    return result;
  }

  const candidates = buildReadOnlyEndpointCandidates({
    token,
    advertiserId: discovery.advertiser_id,
    desde: query.desde,
    hasta: query.hasta,
  });

  for (const candidate of candidates) {
    const endpointResult = await fetchDiagnostic(candidate.name, candidate.url, token);
    result.endpoints_tested.push(endpointResult);
    if (endpointResult.ok) result.working_endpoints.push(endpointResult);
  }

  result.compact = [
    ...discovery.endpoints.map(compactEndpointResult),
    ...result.endpoints_tested.map(compactEndpointResult),
  ];

  if (result.working_endpoints.length) {
    result.conclusion = 'Hay endpoints funcionando. Usar el primero que devuelva datos útiles para reescribir api/ads.js.';
  } else {
    result.conclusion = 'Se encontró advertiser_id, pero los endpoints de Product Ads probados no devolvieron 200. Probable cambio de endpoint, falta de permiso específico o API Ads restringida.';
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
          working_endpoints: accountData.working_endpoints.map(compactEndpointResult),
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
          working_accounts: Object.values(accounts).filter(a => a.working_endpoints.length > 0).length,
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
        working_accounts: Object.values(accounts).filter(a => a.working_endpoints.length > 0).length,
        total_accounts: Object.keys(accounts).length,
      },
      instructions: [
        'compact=1 devuelve resumen legible.',
        'compact=0 devuelve respuestas completas de Mercado Libre.',
        'No usar endpoints que devuelvan 405/404 para api/ads.js.',
        'Si solo funciona /advertising/advertisers?product_id=PADS, falta encontrar el endpoint real de reportes o habilitar permisos específicos.',
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
