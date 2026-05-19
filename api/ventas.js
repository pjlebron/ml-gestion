import { getValidToken } from './_token.js';

const ML_API = 'https://api.mercadolibre.com';
const MP_API = 'https://api.mercadopago.com';

const DEFAULT_DATE_FROM = '2026-01-01';
const PAGE_LIMIT = 50;
const MAX_PAGES = 20;
const MAX_ORDERS = PAGE_LIMIT * MAX_PAGES;

function toNumber(value) {
  const parsed = Number(value || 0);
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

function sumarOrderItems(order) {
  const items = order.order_items || [];

  return items.reduce((acc, orderItem) => {
    const cantidad = toNumber(orderItem.quantity) || 1;
    const unitPrice = toNumber(orderItem.unit_price);
    const fullUnitPrice = toNumber(orderItem.full_unit_price) || unitPrice;
    const saleFee = absNumber(orderItem.sale_fee);

    acc.cantidad += cantidad;
    acc.precio_items += unitPrice * cantidad;
    acc.precio_lista += fullUnitPrice * cantidad;
    acc.sale_fee += saleFee * cantidad;

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

    const item = {
      type: fee.type || '',
      detail: fee.detail || fee.name || fee.description || '',
      amount,
    };

    result.detalle_fees.push(item);

    if (type.includes('shipping') || detail.includes('envío') || detail.includes('envio') || detail.includes('shipping')) {
      result.cargo_envio_ml += amount;
      return;
    }

    if (type.includes('financing') || detail.includes('financi')) {
      result.cargo_financiacion += amount;
      return;
    }

    if (type.includes('tax') || type.includes('iva') || detail.includes('iva') || detail.includes('impuesto')) {
      result.impuestos += amount;
      return;
    }

    if (type.includes('retention') || detail.includes('retenci') || detail.includes('percepci')) {
      result.retenciones += amount;
      return;
    }

    if (type.includes('discount') || detail.includes('descuento')) {
      result.descuentos += amount;
      return;
    }

    if (type.includes('bonus') || detail.includes('bonific')) {
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

function getShipmentCost(shipData) {
  if (!shipData) return 0;

  return absNumber(
    shipData.base_cost ||
    shipData.shipping_option?.cost ||
    shipData.shipping_option?.list_cost ||
    shipData.cost_components?.loyal_discount ||
    0
  );
}

function buildDateFrom(desde) {
  const date = desde || DEFAULT_DATE_FROM;
  return `${date}T00:00:00.000-03:00`;
}

function buildDateTo(hasta) {
  if (hasta) return `${hasta}T23:59:59.000-03:00`;
  return new Date().toISOString();
}

async function buscarOrdenesPaginadas(token, dateFrom, dateTo) {
  let offset = 0;
  let total = 0;
  let allResults = [];
  let page = 0;

  while (page < MAX_PAGES) {
    const searchUrl = `${ML_API}/orders/search?seller=${token.user_id}&order.status=paid&order.date_created.from=${encodeURIComponent(dateFrom)}&order.date_created.to=${encodeURIComponent(dateTo)}&offset=${offset}&limit=${PAGE_LIMIT}&sort=date_desc`;
    const searchData = await fetchJson(searchUrl, token);

    const results = searchData.results || [];
    total = searchData.paging?.total || total;

    allResults = allResults.concat(results);

    if (!results.length) break;
    if (allResults.length >= total) break;
    if (allResults.length >= MAX_ORDERS) break;

    offset += PAGE_LIMIT;
    page += 1;
  }

  return {
    total,
    returned: allResults.length,
    truncated: total > allResults.length,
    max_orders: MAX_ORDERS,
    results: allResults,
  };
}

async function normalizarOrden(order, token) {
  const firstItem = order.order_items?.[0] || {};
  const shipping = order.shipping || {};

  const orderItems = sumarOrderItems(order);
  const payments = sumarPayments(order);

  const billingInfoPromise = fetchJsonSafe(`${ML_API}/orders/${order.id}/billing_info`, token);
  const shipmentPromise = shipping.id ? fetchJsonSafe(`${ML_API}/shipments/${shipping.id}`, token) : Promise.resolve(null);
  const mpPromises = payments.payment_ids.map(paymentId => fetchJsonSafe(`${MP_API}/v1/payments/${paymentId}`, token));

  const [billingInfo, shipData, ...mpPayments] = await Promise.all([
    billingInfoPromise,
    shipmentPromise,
    ...mpPromises,
  ]);

  const billing = clasificarBillingFees(billingInfo);
  const mp = resumirMercadoPago(mpPayments);

  const precioTotal = toNumber(order.total_amount) || orderItems.precio_items || payments.transaction_amount;

  const cargoVenta = billing.cargo_venta || payments.marketplace_fee || orderItems.sale_fee || mp.mp_fee_details_total || 0;
  const cargoEnvioMl = billing.cargo_envio_ml || getShipmentCost(shipData) || 0;
  const cargoFinanciacion = billing.cargo_financiacion || 0;
  const descuentos = billing.descuentos || payments.coupon_amount || 0;
  const bonificaciones = billing.bonificaciones || 0;
  const impuestos = billing.impuestos || payments.taxes_amount || mp.mp_taxes_total || 0;
  const retenciones = billing.retenciones || 0;
  const otrosGastos = billing.otros_gastos || 0;

  const cobroNetoCalculado = precioTotal
    - cargoVenta
    - cargoEnvioMl
    - cargoFinanciacion
    - descuentos
    - impuestos
    - retenciones
    - otrosGastos
    + bonificaciones;

  const cobroNeto = toNumber(billingInfo?.net_amount) || mp.mp_net_received_amount || cobroNetoCalculado;

  const localidad = shipData?.receiver_address?.city?.name || '—';
  const partido = shipData?.receiver_address?.state?.name || '—';
  const esFlex = detectarFlex(shipData);
  const sku = getSkuFromOrderItem(firstItem);

  return {
    id: order.id,
    fecha: order.date_created?.slice(0, 10),
    producto: firstItem.item?.title || '—',
    item_id: firstItem.item?.id || null,
    item_id_ml: firstItem.item?.id || null,
    sku,
    cantidad: firstItem.quantity || orderItems.cantidad || 1,
    precio_unitario: toNumber(firstItem.unit_price),
    precio_total: precioTotal,
    precio_lista: orderItems.precio_lista,

    cargo_venta: cargoVenta,
    ml_fee: cargoVenta,
    cargo_envio_ml: cargoEnvioMl,
    cargo_financiacion: cargoFinanciacion,
    descuentos,
    bonificaciones,
    impuestos,
    retenciones,
    otros_gastos: otrosGastos,
    cobro_neto: cobroNeto,
    cobro_neto_calculado: cobroNetoCalculado,

    mp_fee_details_total: mp.mp_fee_details_total,
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
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  const token = await getValidToken(req, res);
  if (!token) return res.status(401).json({ error: 'No autenticado', redirect: '/api/login' });

  const { desde, hasta } = req.query;

  const dateFrom = buildDateFrom(desde);
  const dateTo = buildDateTo(hasta);

  try {
    const searchData = await buscarOrdenesPaginadas(token, dateFrom, dateTo);

    const orders = await Promise.all(
      searchData.results.map(order => normalizarOrden(order, token))
    );

    res.status(200).json({
      desde: dateFrom,
      hasta: dateTo,
      total: searchData.total,
      returned: searchData.returned,
      truncated: searchData.truncated,
      max_orders: searchData.max_orders,
      orders,
    });
  } catch (err) {
    res.status(500).json({ error: 'Error al consultar ventas', detail: err.message });
  }
}
