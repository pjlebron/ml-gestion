import {
  getAccountKeys,
  getAccountLabel,
  getValidToken,
  normalizeAccount,
} from './_token.js';

const ML_API = 'https://api.mercadolibre.com';

const PAGE_LIMIT = 50;
const MAX_PAGES_PER_ACCOUNT = 20;
const DEFAULT_DAYS_BACK = 30;
const MAX_METRICS_DAYS_BACK = 90;

const ADS_METRICS = [
  'clicks',
  'prints',
  'ctr',
  'cost',
  'cpc',
  'acos',
  'organic_units_quantity',
  'organic_units_amount',
  'organic_items_quantity',
  'direct_items_quantity',
  'indirect_items_quantity',
  'advertising_items_quantity',
  'cvr',
  'roas',
  'sov',
  'direct_units_quantity',
  'indirect_units_quantity',
  'units_quantity',
  'direct_amount',
  'indirect_amount',
  'total_amount',
].join(',');

function toNumber(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function round2(value) {
  return Math.round(toNumber(value) * 100) / 100;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function daysAgoISO(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

function parseDateISO(dateText) {
  const [year, month, day] = String(dateText).split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function formatDateISO(date) {
  return date.toISOString().slice(0, 10);
}

function clampDateRange(desde, hasta) {
  const requestedTo = hasta || todayISO();
  const requestedFrom = desde || daysAgoISO(DEFAULT_DAYS_BACK);

  const toDate = parseDateISO(requestedTo);
  const minFromDate = new Date(toDate);
  minFromDate.setUTCDate(minFromDate.getUTCDate() - MAX_METRICS_DAYS_BACK);

  const fromDate = parseDateISO(requestedFrom);

  if (fromDate < minFromDate) {
    return {
      requested_from: requestedFrom,
      requested_to: requestedTo,
      date_from: formatDateISO(minFromDate),
      date_to: requestedTo,
      clamped: true,
      warning: `Mercado Ads solo permite consultar métricas hasta ${MAX_METRICS_DAYS_BACK} días hacia atrás. Se usó date_from=${formatDateISO(minFromDate)}.`,
    };
  }

  return {
    requested_from: requestedFrom,
    requested_to: requestedTo,
    date_from: requestedFrom,
    date_to: requestedTo,
    clamped: false,
    warning: null,
  };
}

function getRequestedAccounts(accountQuery) {
  if (!accountQuery || accountQuery === 'all') return getAccountKeys();
  return [normalizeAccount(accountQuery)];
}

function calcRoas(ingresos, gasto) {
  return gasto > 0 ? ingresos / gasto : 0;
}

function calcAcos(gasto, ingresos) {
  return ingresos > 0 ? (gasto / ingresos) * 100 : 0;
}

function calcCtr(clicks, prints) {
  return prints > 0 ? (clicks / prints) * 100 : 0;
}

function calcCpc(gasto, clicks) {
  return clicks > 0 ? gasto / clicks : 0;
}

function getRecommendation(item) {
  if (item.gasto > 0 && item.ingresos === 0) {
    return {
      estado: 'Cortar / revisar urgente',
      color: 'rojo',
      motivo: 'Tiene gasto publicitario y no generó ingresos atribuidos.',
    };
  }

  if (item.roas >= 4) {
    return {
      estado: 'Escalar',
      color: 'verde',
      motivo: 'ROAS sano. Candidato a subir presupuesto gradualmente.',
    };
  }

  if (item.roas >= 2) {
    return {
      estado: 'Revisar',
      color: 'amarillo',
      motivo: 'ROAS intermedio. Revisar precio, ficha, stock y competencia.',
    };
  }

  if (item.gasto === 0 && item.ingresos === 0) {
    return {
      estado: 'Sin actividad',
      color: 'gris',
      motivo: 'No tuvo gasto ni ingresos atribuidos en el período.',
    };
  }

  return {
    estado: 'Pausar',
    color: 'rojo',
    motivo: 'ROAS bajo. No conviene escalar sin corregir.',
  };
}

async function fetchJson(url, token, apiVersion = '2') {
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      'Content-Type': 'application/json',
      'api-version': apiVersion,
      'Api-Version': apiVersion,
    },
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok || data.error) {
    throw new Error(data.message || data.description || data.error || `Error HTTP ${response.status}`);
  }

  return data;
}

function chooseAdvertiser(advertisers = []) {
  if (!Array.isArray(advertisers) || !advertisers.length) return null;

  const mla = advertisers.find(a => a.site_id === 'MLA');
  return mla || advertisers[0];
}

async function getAdvertiser(token) {
  const url = `${ML_API}/advertising/advertisers?product_id=PADS`;
  const data = await fetchJson(url, token, '1');
  const advertiser = chooseAdvertiser(data.advertisers || []);

  if (!advertiser?.advertiser_id || !advertiser?.site_id) {
    throw new Error('No se encontró advertiser_id/site_id para Product Ads. Revisar Mercado Libre > Mi perfil > Publicidad.');
  }

  return advertiser;
}

function buildAdsSearchUrl({ siteId, advertiserId, dateFrom, dateTo, offset }) {
  const params = new URLSearchParams({
    limit: String(PAGE_LIMIT),
    offset: String(offset),
    date_from: dateFrom,
    date_to: dateTo,
    metrics: ADS_METRICS,
  });

  return `${ML_API}/advertising/${siteId}/advertisers/${advertiserId}/product_ads/ads/search?${params.toString()}`;
}

function normalizeAdsItem(raw, accountKey, advertiser, dateRange) {
  const metrics = raw.metrics || raw.metrics_summary || {};

  const gasto = toNumber(metrics.cost);
  const ingresos = toNumber(metrics.total_amount);
  const clicks = toNumber(metrics.clicks);
  const prints = toNumber(metrics.prints);

  const directAmount = toNumber(metrics.direct_amount);
  const indirectAmount = toNumber(metrics.indirect_amount);
  const directUnits = toNumber(metrics.direct_units_quantity);
  const indirectUnits = toNumber(metrics.indirect_units_quantity);
  const units = toNumber(metrics.units_quantity);
  const advertisingItems = toNumber(metrics.advertising_items_quantity);

  const roas = toNumber(metrics.roas) || calcRoas(ingresos, gasto);
  const acos = toNumber(metrics.acos) || calcAcos(gasto, ingresos);
  const ctr = toNumber(metrics.ctr) || calcCtr(clicks, prints);
  const cpc = toNumber(metrics.cpc) || calcCpc(gasto, clicks);

  const item = {
    account: accountKey,
    cuenta: getAccountLabel(accountKey),
    cuenta_key: accountKey,
    advertiser_id: advertiser.advertiser_id,
    advertiser_site_id: advertiser.site_id,
    advertiser_name: advertiser.advertiser_name || null,
    account_name: advertiser.account_name || null,

    item_id: raw.item_id || raw.id || '—',
    campaign_id: raw.campaign_id || null,
    titulo: raw.title || raw.item_title || raw.item_id || raw.id || '—',
    status: raw.status || '—',
    price: toNumber(raw.price),
    thumbnail: raw.thumbnail || null,
    permalink: raw.permalink || null,
    listing_type_id: raw.listing_type_id || null,
    logistic_type: raw.logistic_type || null,
    channel: raw.channel || null,
    recommended: Boolean(raw.recommended),

    gasto: round2(gasto),
    ingresos: round2(ingresos),
    direct_amount: round2(directAmount),
    indirect_amount: round2(indirectAmount),

    impresiones: prints,
    prints,
    clicks,
    ventas_atribuidas: advertisingItems,
    unidades: units,
    direct_units_quantity: directUnits,
    indirect_units_quantity: indirectUnits,

    roas: round2(roas),
    acos: round2(acos),
    ctr: round2(ctr),
    cpc: round2(cpc),

    date_from: dateRange.date_from,
    date_to: dateRange.date_to,
  };

  const recommendation = getRecommendation(item);

  return {
    ...item,
    recomendacion: recommendation.estado,
    recomendacion_color: recommendation.color,
    recomendacion_motivo: recommendation.motivo,
  };
}

async function fetchAdsItemsForAccount({ token, accountKey, advertiser, dateRange }) {
  let offset = 0;
  let page = 0;
  let total = 0;
  let allItems = [];

  while (page < MAX_PAGES_PER_ACCOUNT) {
    const url = buildAdsSearchUrl({
      siteId: advertiser.site_id,
      advertiserId: advertiser.advertiser_id,
      dateFrom: dateRange.date_from,
      dateTo: dateRange.date_to,
      offset,
    });

    const data = await fetchJson(url, token, '2');
    const results = data.results || [];

    total = data.paging?.total || total || results.length;

    allItems = allItems.concat(
      results.map(item => normalizeAdsItem(item, accountKey, advertiser, dateRange))
    );

    if (!results.length) break;
    if (allItems.length >= total) break;
    if (results.length < PAGE_LIMIT) break;

    offset += PAGE_LIMIT;
    page += 1;
  }

  return {
    total,
    returned: allItems.length,
    truncated: total > allItems.length,
    items: allItems,
  };
}

function summarizeItems(items) {
  const gastoTotal = round2(items.reduce((sum, item) => sum + toNumber(item.gasto), 0));
  const ingresosTotal = round2(items.reduce((sum, item) => sum + toNumber(item.ingresos), 0));
  const directAmountTotal = round2(items.reduce((sum, item) => sum + toNumber(item.direct_amount), 0));
  const indirectAmountTotal = round2(items.reduce((sum, item) => sum + toNumber(item.indirect_amount), 0));
  const impresionesTotal = items.reduce((sum, item) => sum + toNumber(item.prints), 0);
  const clicksTotal = items.reduce((sum, item) => sum + toNumber(item.clicks), 0);
  const ventasAtribuidasTotal = items.reduce((sum, item) => sum + toNumber(item.ventas_atribuidas), 0);
  const unidadesTotal = items.reduce((sum, item) => sum + toNumber(item.unidades), 0);

  return {
    gasto_total: gastoTotal,
    ingresos_total: ingresosTotal,
    direct_amount_total: directAmountTotal,
    indirect_amount_total: indirectAmountTotal,
    impresiones_total: impresionesTotal,
    clicks_total: clicksTotal,
    ventas_atribuidas_total: ventasAtribuidasTotal,
    unidades_total: unidadesTotal,
    roas: round2(calcRoas(ingresosTotal, gastoTotal)),
    acos: round2(calcAcos(gastoTotal, ingresosTotal)),
    ctr: round2(calcCtr(clicksTotal, impresionesTotal)),
    cpc: round2(calcCpc(gastoTotal, clicksTotal)),
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  const {
    desde,
    hasta,
    account = 'all',
  } = req.query;

  const requestedAccounts = getRequestedAccounts(account);
  const dateRange = clampDateRange(desde, hasta);

  try {
    const accounts = {};
    const allItems = [];

    for (const accountKey of requestedAccounts) {
      const token = await getValidToken(req, res, accountKey);

      accounts[accountKey] = {
        account: accountKey,
        label: getAccountLabel(accountKey),
        connected: Boolean(token),
        user_id: token?.user_id || null,
        advertiser_id: null,
        advertiser_site_id: null,
        advertiser_name: null,
        account_name: null,
        total: 0,
        returned: 0,
        truncated: false,
        gasto_total: 0,
        ingresos_total: 0,
        direct_amount_total: 0,
        indirect_amount_total: 0,
        impresiones_total: 0,
        clicks_total: 0,
        ventas_atribuidas_total: 0,
        unidades_total: 0,
        roas: 0,
        acos: 0,
        ctr: 0,
        cpc: 0,
        items: [],
        error: null,
      };

      if (!token) continue;

      try {
        const advertiser = await getAdvertiser(token);
        const adsData = await fetchAdsItemsForAccount({
          token,
          accountKey,
          advertiser,
          dateRange,
        });
        const summary = summarizeItems(adsData.items);

        accounts[accountKey] = {
          ...accounts[accountKey],
          advertiser_id: advertiser.advertiser_id,
          advertiser_site_id: advertiser.site_id,
          advertiser_name: advertiser.advertiser_name || null,
          account_name: advertiser.account_name || null,
          total: adsData.total,
          returned: adsData.returned,
          truncated: adsData.truncated,
          ...summary,
          items: adsData.items,
        };

        allItems.push(...adsData.items);
      } catch (accountError) {
        accounts[accountKey].error = accountError.message;
      }
    }

    allItems.sort((a, b) => {
      if (b.gasto !== a.gasto) return b.gasto - a.gasto;
      return b.ingresos - a.ingresos;
    });

    const globalSummary = summarizeItems(allItems);

    res.status(200).json({
      requested_account: account,
      requested_desde: dateRange.requested_from,
      requested_hasta: dateRange.requested_to,
      desde: dateRange.date_from,
      hasta: dateRange.date_to,
      date_clamped: dateRange.clamped,
      warning: dateRange.warning,
      accounts,
      connected_accounts: Object.values(accounts).filter(a => a.connected).length,
      total_accounts: Object.keys(accounts).length,

      // Campos legacy que ya usa el frontend actual.
      roas_global: globalSummary.roas,
      gasto_total: globalSummary.gasto_total,
      ingresos_total: globalSummary.ingresos_total,
      items: allItems,

      // Campos nuevos.
      acos_global: globalSummary.acos,
      direct_amount_total: globalSummary.direct_amount_total,
      indirect_amount_total: globalSummary.indirect_amount_total,
      impresiones_total: globalSummary.impresiones_total,
      clicks_total: globalSummary.clicks_total,
      ventas_atribuidas_total: globalSummary.ventas_atribuidas_total,
      unidades_total: globalSummary.unidades_total,
      ctr_global: globalSummary.ctr,
      cpc_global: globalSummary.cpc,
      truncated: Object.values(accounts).some(a => a.truncated),
    });
  } catch (err) {
    res.status(500).json({
      error: 'Error al consultar Mercado Ads',
      detail: err.message,
    });
  }
}
