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

function calcCtr(clicks, impresiones) {
  return impresiones > 0 ? (clicks / impresiones) * 100 : 0;
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

function normalizeAdsItem(raw, accountKey, token) {
  const gasto = toNumber(raw.spend ?? raw.cost ?? raw.investment);
  const ingresos = toNumber(raw.attributed_gmv ?? raw.revenue ?? raw.amount_total);
  const impresiones = toNumber(raw.impressions);
  const clicks = toNumber(raw.clicks);
  const ventasAtribuidas = toNumber(raw.attributed_sales ?? raw.orders ?? raw.sales);
  const unidades = toNumber(raw.units_quantity ?? raw.units ?? raw.quantity);
  const roas = calcRoas(ingresos, gasto);
  const acos = calcAcos(gasto, ingresos);
  const ctr = calcCtr(clicks, impresiones);
  const cpc = calcCpc(gasto, clicks);

  const item = {
    account: accountKey,
    cuenta: getAccountLabel(accountKey),
    cuenta_key: accountKey,
    advertiser_id: token.user_id,

    item_id: raw.item_id || raw.id || raw.item?.id || '—',
    titulo: raw.item_title || raw.title || raw.item?.title || raw.item_id || raw.id || '—',

    gasto: round2(gasto),
    ingresos: round2(ingresos),
    impresiones,
    clicks,
    ventas_atribuidas: ventasAtribuidas,
    unidades,

    roas: round2(roas),
    acos: round2(acos),
    ctr: round2(ctr),
    cpc: round2(cpc),
  };

  const recomendacion = getRecommendation(item);

  return {
    ...item,
    recomendacion: recomendacion.estado,
    recomendacion_color: recomendacion.color,
    recomendacion_motivo: recomendacion.motivo,
  };
}

async function fetchAdsPage(token, dateFrom, dateTo, offset = 0) {
  const url = `${ML_API}/advertising/product_ads/reports/performance?advertiser_id=${token.user_id}&date_from=${dateFrom}&date_to=${dateTo}&group_by=ITEM&limit=${PAGE_LIMIT}&offset=${offset}`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token.access_token}`,
    },
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok || data.error) {
    throw new Error(data.message || data.error || `Error HTTP ${response.status}`);
  }

  return data;
}

async function fetchAdsItemsForAccount(token, accountKey, dateFrom, dateTo) {
  let page = 0;
  let offset = 0;
  let total = 0;
  let allItems = [];

  while (page < MAX_PAGES_PER_ACCOUNT) {
    const data = await fetchAdsPage(token, dateFrom, dateTo, offset);
    const results = data.results || [];

    total = data.paging?.total || data.total || total || results.length;

    const normalized = results.map(item => normalizeAdsItem(item, accountKey, token));
    allItems = allItems.concat(normalized);

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
  const impresionesTotal = items.reduce((sum, item) => sum + toNumber(item.impresiones), 0);
  const clicksTotal = items.reduce((sum, item) => sum + toNumber(item.clicks), 0);
  const ventasAtribuidasTotal = items.reduce((sum, item) => sum + toNumber(item.ventas_atribuidas), 0);
  const unidadesTotal = items.reduce((sum, item) => sum + toNumber(item.unidades), 0);

  return {
    gasto_total: gastoTotal,
    ingresos_total: ingresosTotal,
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

  const dateFrom = desde || daysAgoISO(DEFAULT_DAYS_BACK);
  const dateTo = hasta || todayISO();
  const requestedAccounts = getRequestedAccounts(account);

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
        total: 0,
        returned: 0,
        truncated: false,
        gasto_total: 0,
        ingresos_total: 0,
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
        const adsData = await fetchAdsItemsForAccount(token, accountKey, dateFrom, dateTo);
        const summary = summarizeItems(adsData.items);

        accounts[accountKey] = {
          ...accounts[accountKey],
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
      desde: dateFrom,
      hasta: dateTo,
      requested_account: account,
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
