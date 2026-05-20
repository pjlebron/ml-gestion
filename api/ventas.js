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

async function fetchJson(url, token) {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token.access_token}` },
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

function normalizeOrderItems(order) {
  const rawItems = order.order_items || [];
  const precioItems = rawItems.reduce((sum, orderItem) => {
    const cantidad = toNumber(orderItem.quantity) || 1;
    const unitPrice = toNumber(orderItem.unit_price);
    return sum + unitPrice * cantidad;
  }, 0);

  return rawItems.map((orderItem, index) => {
    const cantidad = toNumber(orderItem.quantity) || 1;
    const precioUnitario = toNumber(orderItem.unit_price);
    const precioListaUnitario = toNumber(orderItem.full_unit_price) || precioUnitario;
    const precioTotalItem = precioUnitario * cantidad;
    const precioListaItem = precioListaUnitario * cantidad;
    const saleFee = absNumber(orderItem.sale_fee) * cantidad;
    const itemId = orderItem.item?.id || null;
    const sku = getSkuFromOrderItem(orderItem);

    return {
      index,
      item_id: itemId,
      item_id_ml: itemId,
      sku,
      producto: orderItem.item?.title || '—',
      cantidad,
      precio_unitario: precioUnitario,
      precio_total_item: precioTotalItem,
      precio_lista_unitario: precioListaUnitario,
      precio_lista_item: precioListaItem,
      sale_fee: saleFee,
      porcentaje_sobre_orden: precioItems > 0 ? precioTotalItem / precioItems : 0,
      variation_id: orderItem.item?.variation_id || null,
      category_id: orderItem.item?.category_id || null,
    };
  });
}

function sumarOrderItems(order) {
  const items = normalizeOrderItems(order);

  return items.reduce((acc, item) => {
    acc.cantidad += item.cantidad;
    acc.precio_items += item.precio_total_item;
    acc.precio_lista += item.precio_lista_item;
    acc.sale_fee += item.sale_fee;
    return acc;
  }, {
    cantidad: 0,
    precio_items: 0,
    precio_lista: 0,
    sale_fee: 0,
  });
}

function sumarPayments(order) {
  const payments = order.payments || [];

  return payments.reduce((acc, payment) => {
    if (payment.id) acc.payment_ids.push(payment.id);

    acc.transaction_amount += toNumber(payment.transaction_amount);
    acc.total_paid_amount += toNumber(payment.total_paid_amount);
    acc.shipping_cost += absNumber(payment.shipping_cost);
    acc.marketplace_fee += absNumber(payment.marketplace_fee);
    acc.coupon_amount += absNumber(payment.coupon_amount);
    acc.taxes_amount += absNumber(payment.taxes_amount);

    return acc;
  }, {
    payment_ids: [],
    transaction_amount: 0,
    total_paid_amount: 0,
    shipping_cost: 0,
    marketplace_fee: 0,
    coupon_amount: 0,
    taxes_amount: 0,
  });
}

function clasificarBillingFees(billingInfo) {
  const result = {
    cargo_venta: 0,
    cargo_envio_ml: 0,
    cargo_financiacion: 0,
    descuentos: 0,
    bonificaciones: 0,
    impuestos: 0,
    retenciones: 0,
    otros_gastos: 0,
    detalle_fees: [],
  };

  const fees = billingInfo?.sale_fees || [];

  fees.forEach(fee => {
    const type = String(fee.type || '').toLowerCase();
    const detail = String(fee.detail || fee.name || fee.description || '').toLowerCase();
    const amount = absNumber(fee.amount);

    if (!amount) return;

    result.detalle_fees.push({
      type: fee.type || '',
      detail: fee.detail || fee.name || fee.description || '',
      amount,
      raw_amount: toNumber(fee.amount),
    });

    if (type.includes('shipping') || detail.includes('envío') || detail.includes('envio') || detail.includes('shipping')) {
      result.cargo_envio_ml += amount;
      return;
    }

    if (type.includes('financing') || detail.includes('financi')) {
      result.cargo_financiacion += amount;
      return;
    }

    if (
      type.includes('tax') ||
      type.includes('iva') ||
      type.includes('gross_income') ||
      type.includes('iibb') ||
      detail.includes('iva') ||
      detail.includes('impuesto') ||
      detail.includes('ingresos brutos') ||
      detail.includes('iibb')
    ) {
      result.impuestos += amount;
      return;
    }

    if (type.includes('retention') || type.includes('withholding') || detail.includes('retenci') || detail.includes('percepci')) {
      result.retenciones += amount;
      return;
    }

    if (
      type.includes('discount') ||
      type.includes('coupon') ||
      type.includes('rebate') ||
      type.includes('subsidy') ||
      detail.includes('descuento') ||
      detail.includes('cupón') ||
      detail.includes('cupon') ||
      detail.includes('subsidio')
    ) {
      result.descuentos += amount;
      return;
    }

    if (
      type.includes('bonus') ||
      type.includes('bonification') ||
      type.includes('compensation') ||
      detail.includes('bonific') ||
      detail.includes('compensaci')
    ) {
      result.bonificaciones += amount;
      return;
    }

    if (type.includes('ml_fee') || type.includes('sale_fee') || detail.includes('cargo por venta') || detail.includes('comisión') || detail.includes('comision')) {
      result.cargo_venta += amount;
      return;
    }

    result.otros_gastos += amount;
  });

  return result;
}

function resumirMercadoPago(mpPayments) {
  const result = {
    mp_fee_details_total: 0,
    mp_charges_fee_total: 0,
    mp_taxes_total: 0,
    mp_net_received_amount: 0,
    mp_shipping_amount: 0,
  };

  mpPayments.filter(Boolean).forEach(payment => {
    result.mp_net_received_amount += toNumber(payment.transaction_details?.net_received_amount);
    result.mp_shipping_amount += absNumber(payment.shipping_amount);

    (payment.fee_details || []).forEach(fee => {
      result.mp_fee_details_total += absNumber(fee.amount);
    });

    (payment.taxes || []).forEach(tax => {
      result.mp_taxes_total += absNumber(tax.value || tax.amount);
    });

    (payment.charges_details || []).forEach(charge => {
      const amount = absNumber(charge.amounts?.original || charge.amount || charge.value);
      const type = String(charge.type || '').toLowerCase();

      if (type === 'tax') result.mp_taxes_total += amount;
      if (type === 'fee') result.mp_charges_fee_total += amount;
    });
  });

  return result;
}

function detectarFlex(shipData) {
  if (!shipData) return false;

  const tags = shipData.tags || [];

  return shipData.logistic_type === 'self_service' ||
    (shipData.mode === 'me2' && shipData.sub_mode === 'flex') ||
    tags.includes('self_service');
}

function flattenNumericFields(input, prefix = '', output = []) {
  if (!input || typeof input !== 'object') return output;

  Object.entries(input).forEach(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;

    if (typeof value === 'number') {
      output.push({ path, value });
      return;
    }

    if (typeof value === 'string') {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && value.trim() !== '') {
        output.push({ path, value: parsed });
      }
      return;
    }

    if (value && typeof value === 'object') {
      flattenNumericFields(value, path, output);
    }
  });

  return output;
}

function pathHasAny(path, words) {
  const clean = String(path || '').toLowerCase();
  return words.some(word => clean.includes(word));
}

function getFirstNumber(...values) {
  for (const value of values) {
    const parsed = toNumber(value);
    if (parsed) return parsed;
  }
  return 0;
}

function getShipmentCost(shipData, shipmentCosts) {
  // IMPORTANTE: no leer sender_id / seller_id / user_id como costo.
  // El commit anterior tomaba 713167918 como envío ML. Sí, espectacular desastre contable.
  const exactCandidates = [
    shipmentCosts?.cost,
    shipmentCosts?.gross_amount,
    shipmentCosts?.sender?.cost,
    shipmentCosts?.sender?.amount,
    shipmentCosts?.seller?.cost,
    shipmentCosts?.seller?.amount,
    Array.isArray(shipmentCosts?.senders) ? shipmentCosts.senders[0]?.cost : null,
    Array.isArray(shipmentCosts?.senders) ? shipmentCosts.senders[0]?.amount : null,
    Array.isArray(shipmentCosts?.receiver) ? shipmentCosts.receiver[0]?.cost : null,
    Array.isArray(shipmentCosts?.receiver) ? shipmentCosts.receiver[0]?.amount : null,
    shipData?.base_cost,
    shipData?.cost,
    shipData?.shipping_option?.cost,
    shipData?.shipping_option?.base_cost,
    shipData?.cost_components?.seller_cost,
    shipData?.shipping_option?.cost_components?.seller_cost,
  ];

  const positives = exactCandidates
    .map(value => absNumber(value))
    .filter(value => value > 0 && value < 1000000);

  if (positives.length) return Math.min(...positives);

  return 0;
}

function getShipmentListCost(shipData, shipmentCosts) {
  const exactCandidates = [
    shipmentCosts?.list_cost,
    shipmentCosts?.gross_amount,
    shipmentCosts?.shipping_cost_before_discount,
    shipmentCosts?.shipping_option?.list_cost,
    shipmentCosts?.cost_components?.list_cost,
    shipmentCosts?.shipping_option?.cost_components?.list_cost,
    shipData?.shipping_option?.list_cost,
    shipData?.list_cost,
    shipData?.cost_components?.list_cost,
    shipData?.shipping_option?.cost_components?.list_cost,
  ];

  const positives = exactCandidates
    .map(value => absNumber(value))
    .filter(value => value > 0 && value < 1000000);

  if (positives.length) return Math.max(...positives);

  return 0;
}

function getShipmentBonusFromCosts(shipmentCosts) {
  if (!shipmentCosts) return { total: 0, detail: [] };

  const creditWords = ['discount', 'bonification', 'bonus', 'compensation', 'subsidy', 'subsidized', 'promoted', 'promotion', 'loyal', 'gap'];
  const ignoredWords = ['id', 'date', 'time', 'zip', 'quantity', 'rate', 'ratio', 'order_id', 'shipment_id', 'sender_id', 'seller_id', 'user_id', 'receiver_id'];

  const candidates = flattenNumericFields(shipmentCosts)
    .filter(field => field.value > 0 && field.value < 1000000)
    .filter(field => pathHasAny(field.path, creditWords))
    .filter(field => !pathHasAny(field.path, ignoredWords));

  if (!candidates.length) return { total: 0, detail: [] };

  const byPath = new Map();
  candidates.forEach(field => {
    if (!byPath.has(field.path)) byPath.set(field.path, field.value);
  });

  const detail = Array.from(byPath.entries()).map(([key, amount]) => ({ key, amount }));
  const total = detail.reduce((sum, item) => sum + absNumber(item.amount), 0);

  return { total, detail };
}

function getShipmentBonus({ shipData, shipmentCosts, cargoEnvioMl }) {
  const fromCosts = getShipmentBonusFromCosts(shipmentCosts);
  const listCost = getShipmentListCost(shipData, shipmentCosts);
  const sellerCost = absNumber(cargoEnvioMl || getShipmentCost(shipData, shipmentCosts));

  let total = fromCosts.total;
  const detail = [...fromCosts.detail];

  if (!total && listCost > 0 && sellerCost <= 10) {
    total = listCost;
    detail.push({ key: 'list_cost_as_bonus_fallback', amount: listCost });
  }

  return { total, detail, list_cost: listCost, seller_cost: sellerCost };
}

function buildDateFrom(desde) {
  const date = desde || DEFAULT_DATE_FROM;
  return `${date}T00:00:00.000-03:00`;
}

function buildDateTo(hasta) {
  if (hasta) return `${hasta}T23:59:59.000-03:00`;
  return new Date().toISOString();
}

function getRequestedAccounts(accountQuery) {
  if (!accountQuery || accountQuery === 'all') return getAccountKeys();
  return [normalizeAccount(accountQuery)];
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

function calcularCobroNeto({
  billingInfo,
  mp,
  precioTotal,
  cargoVenta,
  cargoEnvioMl,
  cargoFinanciacion,
  descuentos,
  bonificaciones,
  impuestos,
  retenciones,
  otrosGastos,
}) {
  const creditosMl = absNumber(descuentos) + absNumber(bonificaciones);

  const cobroNetoCalculado = precioTotal
    - cargoVenta
    - cargoEnvioMl
    - cargoFinanciacion
    + creditosMl
    - impuestos
    - retenciones
    - otrosGastos;

  const billingNetAmount = toNumber(billingInfo?.net_amount);

  if (billingNetAmount) {
    return {
      cobroNeto: billingNetAmount,
      cobroNetoCalculado,
      creditosMl,
      fuente: 'billing_info_net_amount',
    };
  }

  if (mp.mp_net_received_amount) {
    return {
      cobroNeto: mp.mp_net_received_amount + creditosMl,
      cobroNetoCalculado,
      creditosMl,
      fuente: creditosMl ? 'mercadopago_net_mas_creditos_ml' : 'mercadopago_net',
    };
  }

  return {
    cobroNeto: cobroNetoCalculado,
    cobroNetoCalculado,
    creditosMl,
    fuente: 'calculado',
  };
}

async function normalizarOrden(order, token, account) {
  const items = normalizeOrderItems(order);
  const firstItem = order.order_items?.[0] || {};
  const firstNormalizedItem = items[0] || null;
  const shipping = order.shipping || {};

  const orderItems = sumarOrderItems(order);
  const payments = sumarPayments(order);

  const billingInfoPromise = fetchJsonSafe(`${ML_API}/orders/${order.id}/billing_info`, token);
  const shipmentPromise = shipping.id ? fetchJsonSafe(`${ML_API}/shipments/${shipping.id}`, token) : Promise.resolve(null);
  const shipmentCostsPromise = shipping.id ? fetchJsonSafe(`${ML_API}/shipments/${shipping.id}/costs`, token) : Promise.resolve(null);
  const mpPromises = payments.payment_ids.map(paymentId => fetchJsonSafe(`${MP_API}/v1/payments/${paymentId}`, token));

  const [billingInfo, shipData, shipmentCosts, ...mpPayments] = await Promise.all([
    billingInfoPromise,
    shipmentPromise,
    shipmentCostsPromise,
    ...mpPromises,
  ]);

  const billing = clasificarBillingFees(billingInfo);
  const mp = resumirMercadoPago(mpPayments);

  const precioTotal = toNumber(order.total_amount) || orderItems.precio_items || payments.transaction_amount;

  const cargoVenta = billing.cargo_venta || payments.marketplace_fee || orderItems.sale_fee || mp.mp_charges_fee_total || mp.mp_fee_details_total || 0;
  const cargoEnvioMl = billing.cargo_envio_ml || getShipmentCost(shipData, shipmentCosts) || 0;
  const shipmentBonus = getShipmentBonus({ shipData, shipmentCosts, cargoEnvioMl });
  const cargoFinanciacion = billing.cargo_financiacion || 0;
  const descuentos = billing.descuentos || payments.coupon_amount || 0;
  const bonificacionesEnvioMl = shipmentBonus.total;
  const bonificaciones = billing.bonificaciones || bonificacionesEnvioMl || 0;
  const impuestos = billing.impuestos || payments.taxes_amount || mp.mp_taxes_total || 0;
  const retenciones = billing.retenciones || 0;
  const otrosGastos = billing.otros_gastos || 0;

  const cobro = calcularCobroNeto({
    billingInfo,
    mp,
    precioTotal,
    cargoVenta,
    cargoEnvioMl,
    cargoFinanciacion,
    descuentos,
    bonificaciones,
    impuestos,
    retenciones,
    otrosGastos,
  });

  const localidad = shipData?.receiver_address?.city?.name || '—';
  const partido = shipData?.receiver_address?.state?.name || '—';
  const esFlex = detectarFlex(shipData);
  const sellerId = order.seller?.id || token.user_id || null;
  const cantidadItemsDistintos = items.length;
  const esOrdenMultiItem = cantidadItemsDistintos > 1;
  const productoDisplay = esOrdenMultiItem
    ? `${firstNormalizedItem?.producto || firstItem.item?.title || '—'} + ${cantidadItemsDistintos - 1} producto${cantidadItemsDistintos - 1 === 1 ? '' : 's'}`
    : (firstNormalizedItem?.producto || firstItem.item?.title || '—');

  return {
    id: order.id,
    order_id: order.id,
    pack_id: order.pack_id || null,
    seller_id: sellerId,
    fecha: order.date_created?.slice(0, 10),
    producto: productoDisplay,
    producto_principal: firstNormalizedItem?.producto || firstItem.item?.title || '—',
    item_id: firstNormalizedItem?.item_id || firstItem.item?.id || null,
    item_id_ml: firstNormalizedItem?.item_id || firstItem.item?.id || null,
    sku: firstNormalizedItem?.sku || getSkuFromOrderItem(firstItem),
    cantidad: orderItems.cantidad || firstItem.quantity || 1,
    cantidad_items_distintos: cantidadItemsDistintos,
    cantidad_unidades_total: orderItems.cantidad || 1,
    es_orden_multi_item: esOrdenMultiItem,
    items,
    precio_unitario: toNumber(firstItem.unit_price),
    precio_total: precioTotal,
    precio_lista: orderItems.precio_lista,

    cargo_venta: cargoVenta,
    ml_fee: cargoVenta,
    cargo_envio_ml: cargoEnvioMl,
    cargo_financiacion: cargoFinanciacion,
    descuentos,
    bonificaciones,
    bonificaciones_envio_ml: bonificacionesEnvioMl,
    bonificaciones_envio_ml_detalle: shipmentBonus.detail,
    shipping_list_cost: shipmentBonus.list_cost,
    shipping_seller_cost: shipmentBonus.seller_cost,
    shipment_costs_raw: shipmentCosts || null,
    creditos_ml: cobro.creditosMl,
    impuestos,
    retenciones,
    otros_gastos: otrosGastos,
    cobro_neto: cobro.cobroNeto,
    cobro_neto_calculado: cobro.cobroNetoCalculado,
    cobro_neto_fuente: cobro.fuente,

    mp_fee_details_total: mp.mp_fee_details_total,
    mp_charges_fee_total: mp.mp_charges_fee_total,
    mp_net_received_amount: mp.mp_net_received_amount,
    mp_shipping_amount: mp.mp_shipping_amount,

    es_flex: esFlex,
    envio_id: shipping.id || null,
    localidad,
    partido,
    estado: order.status,
    comprador: order.buyer?.nickname || '—',
    payment_ids: payments.payment_ids,
    detalle_fees: billing.detalle_fees,

    account,
    cuenta: getAccountLabel(account),
    cuenta_key: account,
  };
}

function deduplicarOrdenes(orders) {
  const byId = new Map();
  const duplicados = [];

  for (const order of orders) {
    const key = String(order.id || order.order_id || '');

    if (!key) continue;

    if (!byId.has(key)) {
      byId.set(key, order);
      continue;
    }

    const existente = byId.get(key);

    duplicados.push({
      order_id: key,
      primera_cuenta: existente.cuenta,
      primera_cuenta_key: existente.cuenta_key,
      segunda_cuenta: order.cuenta,
      segunda_cuenta_key: order.cuenta_key,
      producto: order.producto,
      fecha: order.fecha,
    });

    if (existente.cuenta_key === 'lebron' && order.cuenta_key === 'fragantify') {
      byId.set(key, order);
    }
  }

  return {
    orders: Array.from(byId.values()),
    duplicados,
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
    const allOrdersRaw = [];

    for (const accountKey of requestedAccounts) {
      const token = await getValidToken(req, res, accountKey);

      accounts[accountKey] = {
        account: accountKey,
        label: getAccountLabel(accountKey),
        connected: !!token,
        user_id: token?.user_id || null,
        total: 0,
        returned: 0,
        returned_raw: 0,
        truncated: false,
        error: null,
      };

      if (!token) continue;

      try {
        const searchData = await buscarOrdenesPaginadas(token, dateFrom, dateTo);

        accounts[accountKey].total = searchData.total;
        accounts[accountKey].returned_raw = searchData.returned;
        accounts[accountKey].truncated = searchData.truncated;
        accounts[accountKey].max_orders = searchData.max_orders;

        const normalizedOrders = await Promise.all(
          searchData.results.map(order => normalizarOrden(order, token, accountKey))
        );

        allOrdersRaw.push(...normalizedOrders);
      } catch (accountError) {
        accounts[accountKey].error = accountError.message;
      }
    }

    const dedupeResult = deduplicarOrdenes(allOrdersRaw);
    const allOrders = dedupeResult.orders;

    allOrders.sort((a, b) => {
      const fechaA = String(a.fecha || '');
      const fechaB = String(b.fecha || '');
      return fechaB.localeCompare(fechaA);
    });

    for (const accountKey of Object.keys(accounts)) {
      accounts[accountKey].returned = allOrders.filter(order => order.cuenta_key === accountKey).length;
    }

    res.status(200).json({
      desde: dateFrom,
      hasta: dateTo,
      requested_account: account,
      accounts,
      connected_accounts: Object.values(accounts).filter(a => a.connected).length,
      total_accounts: Object.keys(accounts).length,
      total: Object.values(accounts).reduce((s, a) => s + (a.total || 0), 0),
      returned_raw: allOrdersRaw.length,
      returned: allOrders.length,
      duplicated_removed: dedupeResult.duplicados.length,
      duplicados_eliminados: dedupeResult.duplicados,
      truncated: Object.values(accounts).some(a => a.truncated),
      orders: allOrders,
    });
  } catch (err) {
    res.status(500).json({ error: 'Error al consultar ventas', detail: err.message });
  }
}
