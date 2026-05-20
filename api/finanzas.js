import {
  getAccountKeys,
  getAccountLabel,
  getValidToken,
  normalizeAccount,
} from './_token.js';

const ML_API = 'https://api.mercadolibre.com';
const MP_API = 'https://api.mercadopago.com';

const DEFAULT_DATE_FROM = '2026-01-01';
const PAGE_LIMIT = 50;
const MAX_PAGES_PER_ACCOUNT = 20;
const MAX_ORDERS_PER_ACCOUNT = PAGE_LIMIT * MAX_PAGES_PER_ACCOUNT;

function toNumber(value) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function absNumber(value) {
  return Math.abs(toNumber(value));
}

function round2(value) {
  return Math.round(toNumber(value) * 100) / 100;
}

function buildDateFrom(desde) {
  const date = desde || DEFAULT_DATE_FROM;
  return `${date}T00:00:00.000-03:00`;
}

function buildDateTo(hasta) {
  if (hasta) return `${hasta}T23:59:59.000-03:00`;
  return new Date().toISOString();
}

function normalizeDateOnly(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function diffDays(dateValue) {
  if (!dateValue) return null;
  const target = new Date(`${normalizeDateOnly(dateValue)}T00:00:00-03:00`);
  const today = new Date();
  const base = new Date(`${today.toISOString().slice(0, 10)}T00:00:00-03:00`);
  return Math.ceil((target.getTime() - base.getTime()) / 86400000);
}

function getBucket(releaseDate) {
  const days = diffDays(releaseDate);
  if (days === null) return 'sin_fecha';
  if (days < 0) return 'vencido';
  if (days === 0) return 'hoy';
  if (days === 1) return 'manana';
  if (days <= 7) return 'proximos_7';
  if (days <= 15) return 'proximos_15';
  if (days <= 30) return 'proximos_30';
  return 'mas_30';
}

function getRequestedAccounts(accountQuery) {
  if (!accountQuery || accountQuery === 'all') return getAccountKeys();
  return [normalizeAccount(accountQuery)];
}

async function fetchJson(url, token) {
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

async function fetchJsonSafe(url, token) {
  try {
    return await fetchJson(url, token);
  } catch (error) {
    return null;
  }
}

async function buscarOrdenesPaginadas(token, dateFrom, dateTo) {
  let offset = 0;
  let total = 0;
  let allResults = [];
  let page = 0;

  while (page < MAX_PAGES_PER_ACCOUNT) {
    const searchUrl = `${ML_API}/orders/search?seller=${token.user_id}&order.status=paid&order.date_created.from=${encodeURIComponent(dateFrom)}&order.date_created.to=${encodeURIComponent(dateTo)}&offset=${offset}&limit=${PAGE_LIMIT}&sort=date_desc`;
    const searchData = await fetchJson(searchUrl, token);

    const results = searchData.results || [];
    total = searchData.paging?.total || total;
    allResults = allResults.concat(results);

    if (!results.length) break;
    if (allResults.length >= total) break;
    if (allResults.length >= MAX_ORDERS_PER_ACCOUNT) break;

    offset += PAGE_LIMIT;
    page += 1;
  }

  return {
    total,
    returned: allResults.length,
    truncated: total > allResults.length,
    max_orders: MAX_ORDERS_PER_ACCOUNT,
    results: allResults,
  };
}

function getSkuFromOrderItem(orderItem = {}) {
  return String(
    orderItem.seller_sku ||
    orderItem.seller_custom_field ||
    orderItem.item?.seller_sku ||
    orderItem.item?.seller_custom_field ||
    orderItem.item?.seller_sku_id ||
    orderItem.item?.id ||
    ''
  ).trim();
}

function summarizeOrderItems(order) {
  const items = order.order_items || [];
  return items.map(item => ({
    producto: item.item?.title || '—',
    sku: getSkuFromOrderItem(item),
    item_id: item.item?.id || null,
    cantidad: toNumber(item.quantity) || 1,
    precio_unitario: toNumber(item.unit_price),
    precio_total: (toNumber(item.quantity) || 1) * toNumber(item.unit_price),
    sale_fee: absNumber(item.sale_fee) * (toNumber(item.quantity) || 1),
  }));
}

function summarizeCharges(payment) {
  const charges = payment?.charges_details || [];
  const result = {
    fee_total: 0,
    tax_total: 0,
    fees: [],
    taxes: [],
  };

  charges.forEach(charge => {
    const amount = absNumber(charge.amounts?.original || charge.amount || charge.value);
    const type = String(charge.type || '').toLowerCase();
    const row = {
      name: charge.name || charge.type || '—',
      amount,
      type: charge.type || '—',
      metadata: charge.metadata || {},
    };

    if (type === 'fee') {
      result.fee_total += amount;
      result.fees.push(row);
    }

    if (type === 'tax') {
      result.tax_total += amount;
      result.taxes.push(row);
    }
  });

  return result;
}

function normalizePayment({ payment, order, account, token, items }) {
  const charges = summarizeCharges(payment);
  const totalItems = items.reduce((sum, item) => sum + toNumber(item.precio_total), 0) || toNumber(order.total_amount);
  const paymentAmount = toNumber(payment?.transaction_amount || payment?.transaction_details?.total_paid_amount || totalItems);
  const netReceived = toNumber(payment?.transaction_details?.net_received_amount);
  const releaseDate = payment?.money_release_date || payment?.money_release_schema?.date || null;
  const releaseDateOnly = normalizeDateOnly(releaseDate);
  const status = payment?.status || 'unknown';
  const statusDetail = payment?.status_detail || '';
  const isReleased = releaseDateOnly ? diffDays(releaseDateOnly) <= 0 : false;

  return {
    account,
    cuenta: getAccountLabel(account),
    cuenta_key: account,
    seller_id: token.user_id,
    order_id: order.id,
    pack_id: order.pack_id || null,
    payment_id: payment?.id || null,
    fecha_venta: normalizeDateOnly(order.date_created),
    fecha_liberacion: releaseDateOnly,
    dias_para_liberar: diffDays(releaseDateOnly),
    bucket: getBucket(releaseDateOnly),
    estado_pago: status,
    estado_detalle: statusDetail,
    liberado_estimado: isReleased,
    comprador: order.buyer?.nickname || '—',
    producto: items.length > 1 ? `${items[0]?.producto || '—'} + ${items.length - 1} prod.` : items[0]?.producto || '—',
    productos: items,
    sku: items.map(i => i.sku).filter(Boolean).join(' + '),
    precio_productos: round2(totalItems),
    monto_pago: round2(paymentAmount),
    cobro_neto_mp: round2(netReceived),
    comisiones_mp: round2(charges.fee_total),
    impuestos_mp: round2(charges.tax_total),
    shipping_amount_mp: absNumber(payment?.shipping_amount),
    charges_detail: charges,
    fuente: 'mercadopago_payment',
  };
}

async function normalizarOrdenFinanciera(order, token, account) {
  const items = summarizeOrderItems(order);
  const paymentIds = (order.payments || []).map(p => p.id).filter(Boolean);
  const mpPayments = await Promise.all(
    paymentIds.map(paymentId => fetchJsonSafe(`${MP_API}/v1/payments/${encodeURIComponent(paymentId)}`, token))
  );

  const validPayments = mpPayments.filter(Boolean);

  if (!validPayments.length) {
    return [{
      account,
      cuenta: getAccountLabel(account),
      cuenta_key: account,
      seller_id: token.user_id,
      order_id: order.id,
      pack_id: order.pack_id || null,
      payment_id: null,
      fecha_venta: normalizeDateOnly(order.date_created),
      fecha_liberacion: null,
      dias_para_liberar: null,
      bucket: 'sin_fecha',
      estado_pago: 'sin_payment_detail',
      estado_detalle: 'No se pudo leer Mercado Pago',
      liberado_estimado: false,
      comprador: order.buyer?.nickname || '—',
      producto: items.length > 1 ? `${items[0]?.producto || '—'} + ${items.length - 1} prod.` : items[0]?.producto || '—',
      productos: items,
      sku: items.map(i => i.sku).filter(Boolean).join(' + '),
      precio_productos: round2(items.reduce((sum, item) => sum + toNumber(item.precio_total), 0) || toNumber(order.total_amount)),
      monto_pago: round2(toNumber(order.paid_amount || order.total_amount)),
      cobro_neto_mp: 0,
      comisiones_mp: 0,
      impuestos_mp: 0,
      shipping_amount_mp: 0,
      charges_detail: { fee_total: 0, tax_total: 0, fees: [], taxes: [] },
      fuente: 'orders_without_payment_detail',
    }];
  }

  return validPayments.map(payment => normalizePayment({ payment, order, account, token, items }));
}

function summarizeByBucket(liquidaciones) {
  const labels = {
    vencido: 'Vencido / ya debería estar',
    hoy: 'Hoy',
    manana: 'Mañana',
    proximos_7: 'Próximos 7 días',
    proximos_15: 'Próximos 15 días',
    proximos_30: 'Próximos 30 días',
    mas_30: 'Más de 30 días',
    sin_fecha: 'Sin fecha',
  };

  const result = {};
  Object.keys(labels).forEach(key => {
    result[key] = { key, label: labels[key], cantidad: 0, monto: 0 };
  });

  liquidaciones.forEach(row => {
    const key = row.bucket || 'sin_fecha';
    if (!result[key]) result[key] = { key, label: key, cantidad: 0, monto: 0 };
    result[key].cantidad += 1;
    result[key].monto += toNumber(row.cobro_neto_mp);
  });

  return Object.values(result).map(row => ({ ...row, monto: round2(row.monto) }));
}

function summarizeByAccount(liquidaciones) {
  const result = {};

  liquidaciones.forEach(row => {
    const key = row.cuenta_key || row.account || 'sin_cuenta';
    if (!result[key]) {
      result[key] = {
        key,
        cuenta: row.cuenta || key,
        ventas: 0,
        cobro_neto_mp: 0,
        comisiones_mp: 0,
        impuestos_mp: 0,
        pendiente: 0,
        liberado: 0,
      };
    }

    result[key].ventas += 1;
    result[key].cobro_neto_mp += toNumber(row.cobro_neto_mp);
    result[key].comisiones_mp += toNumber(row.comisiones_mp);
    result[key].impuestos_mp += toNumber(row.impuestos_mp);

    if (row.liberado_estimado) result[key].liberado += toNumber(row.cobro_neto_mp);
    else result[key].pendiente += toNumber(row.cobro_neto_mp);
  });

  return Object.values(result).map(row => ({
    ...row,
    cobro_neto_mp: round2(row.cobro_neto_mp),
    comisiones_mp: round2(row.comisiones_mp),
    impuestos_mp: round2(row.impuestos_mp),
    pendiente: round2(row.pendiente),
    liberado: round2(row.liberado),
  }));
}

function buildResumen(liquidaciones) {
  const totalCobroNeto = liquidaciones.reduce((sum, row) => sum + toNumber(row.cobro_neto_mp), 0);
  const totalPendiente = liquidaciones
    .filter(row => !row.liberado_estimado)
    .reduce((sum, row) => sum + toNumber(row.cobro_neto_mp), 0);
  const totalLiberado = liquidaciones
    .filter(row => row.liberado_estimado)
    .reduce((sum, row) => sum + toNumber(row.cobro_neto_mp), 0);
  const hoy = liquidaciones
    .filter(row => row.bucket === 'hoy')
    .reduce((sum, row) => sum + toNumber(row.cobro_neto_mp), 0);
  const proximos7 = liquidaciones
    .filter(row => ['hoy', 'manana', 'proximos_7'].includes(row.bucket))
    .reduce((sum, row) => sum + toNumber(row.cobro_neto_mp), 0);
  const proximos30 = liquidaciones
    .filter(row => ['hoy', 'manana', 'proximos_7', 'proximos_15', 'proximos_30'].includes(row.bucket))
    .reduce((sum, row) => sum + toNumber(row.cobro_neto_mp), 0);

  return {
    ventas: liquidaciones.length,
    cobro_neto_mp_total: round2(totalCobroNeto),
    liquidado_estimado: round2(totalLiberado),
    pendiente_liquidar: round2(totalPendiente),
    libera_hoy: round2(hoy),
    libera_7_dias: round2(proximos7),
    libera_30_dias: round2(proximos30),
    comisiones_mp_total: round2(liquidaciones.reduce((sum, row) => sum + toNumber(row.comisiones_mp), 0)),
    impuestos_mp_total: round2(liquidaciones.reduce((sum, row) => sum + toNumber(row.impuestos_mp), 0)),
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  const { desde, hasta, account = 'all' } = req.query;
  const dateFrom = buildDateFrom(desde);
  const dateTo = buildDateTo(hasta);
  const requestedAccounts = getRequestedAccounts(account);

  try {
    const accounts = {};
    const liquidaciones = [];

    for (const accountKey of requestedAccounts) {
      const token = await getValidToken(req, res, accountKey);

      accounts[accountKey] = {
        account: accountKey,
        label: getAccountLabel(accountKey),
        connected: !!token,
        user_id: token?.user_id || null,
        total_orders: 0,
        returned_orders: 0,
        truncated: false,
        error: null,
      };

      if (!token) continue;

      try {
        const searchData = await buscarOrdenesPaginadas(token, dateFrom, dateTo);
        accounts[accountKey].total_orders = searchData.total;
        accounts[accountKey].returned_orders = searchData.returned;
        accounts[accountKey].truncated = searchData.truncated;
        accounts[accountKey].max_orders = searchData.max_orders;

        const normalizedGroups = await Promise.all(
          searchData.results.map(order => normalizarOrdenFinanciera(order, token, accountKey))
        );

        normalizedGroups.flat().forEach(row => liquidaciones.push(row));
      } catch (accountError) {
        accounts[accountKey].error = accountError.message;
      }
    }

    liquidaciones.sort((a, b) => {
      const da = a.fecha_liberacion || '9999-12-31';
      const db = b.fecha_liberacion || '9999-12-31';
      if (da !== db) return da.localeCompare(db);
      return String(b.fecha_venta || '').localeCompare(String(a.fecha_venta || ''));
    });

    res.status(200).json({
      ok: true,
      tipo: 'war_room_financiero',
      desde: dateFrom,
      hasta: dateTo,
      requested_account: account,
      accounts,
      resumen: buildResumen(liquidaciones),
      buckets: summarizeByBucket(liquidaciones),
      cuentas: summarizeByAccount(liquidaciones),
      liquidaciones,
      nota: 'MVP financiero basado en money_release_date y net_received_amount de Mercado Pago. Es caja proyectada de cobros, no reemplaza conciliación bancaria. Sí, el dinero todavía no se teletransporta.',
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: 'Error al armar War Room financiero',
      detail: err.message,
    });
  }
}
