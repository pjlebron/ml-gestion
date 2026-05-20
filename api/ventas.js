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

function normalizarCodigo(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');
}

function getBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
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

async function fetchInternalJson(url, req) {
  const response = await fetch(url, {
    cache: 'no-store',
    headers: {
      cookie: req.headers.cookie || '',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
    },
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok || data.error || data.ok === false) {
    throw new Error(data.detail || data.message || data.error || `Error HTTP ${response.status}`);
  }

  return data;
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
  const logisticType = String(shipData.logistic_type || '').toLowerCase();
  const mode = String(shipData.mode || '').toLowerCase();
  const subMode = String(shipData.sub_mode || '').toLowerCase();

  return logisticType === 'self_service' ||
    (mode === 'me2' && subMode === 'flex') ||
    tags.includes('self_service');
}

function sumDiscounts(discounts) {
  if (!Array.isArray(discounts)) return 0;
  return discounts.reduce((sum, discount) => sum + absNumber(discount.promoted_amount || discount.amount || discount.value), 0);
}

function getShipmentSellerCostRaw(shipData, shipmentCosts) {
  const candidates = [
    shipmentCosts?.seller?.cost,
    shipmentCosts?.seller?.amount,
    shipmentCosts?.sender?.cost,
    shipmentCosts?.sender?.amount,
    Array.isArray(shipmentCosts?.senders) ? shipmentCosts.senders[0]?.cost : null,
    Array.isArray(shipmentCosts?.senders) ? shipmentCosts.senders[0]?.amount : null,
    shipData?.base_cost,
    shipData?.cost,
    shipData?.shipping_option?.cost,
    shipData?.shipping_option?.base_cost,
    shipData?.cost_components?.seller_cost,
    shipData?.shipping_option?.cost_components?.seller_cost,
  ];

  const positives = candidates
    .map(value => absNumber(value))
    .filter(value => value > 0 && value < 1000000);

  return positives.length ? Math.min(...positives) : 0;
}

function getShipmentSellerCost({ shipData, shipmentCosts, isFlex }) {
  if (isFlex) return 0;
  return getShipmentSellerCostRaw(shipData, shipmentCosts);
}

function getShipmentGrossCost(shipData, shipmentCosts) {
  const candidates = [
    shipmentCosts?.gross_amount,
    shipmentCosts?.list_cost,
    shipmentCosts?.shipping_cost_before_discount,
    shipmentCosts?.shipping_option?.list_cost,
    shipData?.shipping_option?.list_cost,
    shipData?.list_cost,
  ];

  const positives = candidates
    .map(value => absNumber(value))
    .filter(value => value > 0 && value < 1000000);

  return positives.length ? Math.max(...positives) : 0;
}

function getShipmentBonus({ shipData, shipmentCosts, sellerCost, rawSellerCost, isFlex }) {
  const grossCost = getShipmentGrossCost(shipData, shipmentCosts);
  const receiverDiscount = sumDiscounts(shipmentCosts?.receiver?.discounts);
  const senderDiscount = Array.isArray(shipmentCosts?.senders)
    ? shipmentCosts.senders.reduce((sum, sender) => sum + sumDiscounts(sender.discounts), 0)
    : 0;

  let total = 0;
  const detail = [];

  if (isFlex && senderDiscount > 0) {
    total += senderDiscount;
    detail.push({ key: 'senders.discounts.promoted_amount_flex', amount: senderDiscount });
  }

  if (rawSellerCost === 0 && senderDiscount === 0 && receiverDiscount > 0 && grossCost > 0) {
    total += receiverDiscount;
    detail.push({ key: 'receiver.discounts.promoted_amount_seller_cost_zero', amount: receiverDiscount });
  }

  return {
    total: round2(total),
    detail,
    gross_cost: grossCost,
    seller_cost: sellerCost,
    raw_seller_cost: rawSellerCost,
    receiver_discount: receiverDiscount,
    sender_discount: senderDiscount,
  };
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
  return round2(
    precioTotal
    - cargoVenta
    - cargoEnvioMl
    - cargoFinanciacion
    - descuentos
    - impuestos
    - retenciones
    - otrosGastos
    + bonificaciones
  );
}

function prorratear(value, item, totalOrden, itemCount) {
  const porcentaje = item?.porcentaje_sobre_orden || (itemCount ? 1 / itemCount : 1);
  return round2(toNumber(value) * porcentaje);
}

async function normalizarOrden(order, token, account) {
  const items = normalizeOrderItems(order);
  const orderItems = sumarOrderItems(order);
  const payments = sumarPayments(order);
  const shipping = order.shipping || {};

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
  const isFlex = detectarFlex(shipData);
  const rawSellerCost = getShipmentSellerCostRaw(shipData, shipmentCosts);
  const sellerCost = billing.cargo_envio_ml || getShipmentSellerCost({ shipData, shipmentCosts, isFlex }) || 0;
  const shipmentBonus = getShipmentBonus({ shipData, shipmentCosts, sellerCost, rawSellerCost, isFlex });

  const orderData = {
    order,
    items,
    orderItems,
    payments,
    account,
    token,
    shipData,
    shipmentCosts,
    billing,
    mp,
    precioTotal,
    isFlex,
    rawSellerCost,
    cargoVenta: billing.cargo_venta || payments.marketplace_fee || orderItems.sale_fee || mp.mp_charges_fee_total || mp.mp_fee_details_total || 0,
    cargoEnvioMl: sellerCost,
    cargoFinanciacion: billing.cargo_financiacion || 0,
    descuentos: billing.descuentos || payments.coupon_amount || 0,
    bonificaciones: billing.bonificaciones || shipmentBonus.total || 0,
    bonificacionesEnvioMl: shipmentBonus.total || 0,
    shipmentBonus,
    impuestos: billing.impuestos || payments.taxes_amount || mp.mp_taxes_total || 0,
    retenciones: billing.retenciones || 0,
    otrosGastos: billing.otros_gastos || 0,
  };

  return construirFilasPorItem(orderData);
}

function construirFilasPorItem(data) {
  const {
    order,
    items,
    orderItems,
    payments,
    account,
    token,
    shipData,
    shipmentCosts,
    billing,
    mp,
    precioTotal,
    cargoVenta,
    cargoEnvioMl,
    cargoFinanciacion,
    descuentos,
    bonificaciones,
    bonificacionesEnvioMl,
    shipmentBonus,
    impuestos,
    retenciones,
    otrosGastos,
    isFlex,
    rawSellerCost,
  } = data;

  const shipping = order.shipping || {};
  const localidad = shipData?.receiver_address?.city?.name || '—';
  const partido = shipData?.receiver_address?.state?.name || '—';
  const sellerId = order.seller?.id || token.user_id || null;
  const cantidadItemsDistintos = items.length;
  const esOrdenMultiItem = cantidadItemsDistintos > 1;
  const comprador = order.buyer?.nickname || '—';

  return items.map(item => {
    const itemCargoVenta = round2(item.sale_fee || prorratear(cargoVenta, item, precioTotal, cantidadItemsDistintos));
    const itemCargoEnvioMl = prorratear(cargoEnvioMl, item, precioTotal, cantidadItemsDistintos);
    const itemCargoFinanciacion = prorratear(cargoFinanciacion, item, precioTotal, cantidadItemsDistintos);
    const itemDescuentos = prorratear(descuentos, item, precioTotal, cantidadItemsDistintos);
    const itemBonificaciones = prorratear(bonificaciones, item, precioTotal, cantidadItemsDistintos);
    const itemBonificacionesEnvio = prorratear(bonificacionesEnvioMl, item, precioTotal, cantidadItemsDistintos);
    const itemImpuestos = prorratear(impuestos, item, precioTotal, cantidadItemsDistintos);
    const itemRetenciones = prorratear(retenciones, item, precioTotal, cantidadItemsDistintos);
    const itemOtrosGastos = prorratear(otrosGastos, item, precioTotal, cantidadItemsDistintos);

    const itemCobroNeto = calcularCobroNeto({
      precioTotal: item.precio_total_item,
      cargoVenta: itemCargoVenta,
      cargoEnvioMl: itemCargoEnvioMl,
      cargoFinanciacion: itemCargoFinanciacion,
      descuentos: itemDescuentos,
      bonificaciones: itemBonificaciones,
      impuestos: itemImpuestos,
      retenciones: itemRetenciones,
      otrosGastos: itemOtrosGastos,
    });

    return {
      id: esOrdenMultiItem ? `${order.id}-${item.index}` : order.id,
      order_id: order.id,
      pack_id: order.pack_id || null,
      seller_id: sellerId,
      fecha: order.date_created?.slice(0, 10),
      producto: item.producto,
      producto_principal: item.producto,
      item_id: item.item_id,
      item_id_ml: item.item_id_ml,
      sku: item.sku,
      cantidad: item.cantidad,
      cantidad_items_distintos: cantidadItemsDistintos,
      cantidad_unidades_total: orderItems.cantidad || item.cantidad || 1,
      es_orden_multi_item: esOrdenMultiItem,
      items: [item],
      precio_unitario: item.precio_unitario,
      precio_total: round2(item.precio_total_item),
      precio_lista: round2(item.precio_lista_item),

      cargo_venta: itemCargoVenta,
      ml_fee: itemCargoVenta,
      cargo_envio_ml: itemCargoEnvioMl,
      cargo_envio_ml_total_orden: round2(cargoEnvioMl),
      cargo_financiacion: itemCargoFinanciacion,
      descuentos: itemDescuentos,
      bonificaciones: itemBonificaciones,
      bonificaciones_envio_ml: itemBonificacionesEnvio,
      bonificaciones_envio_ml_total_orden: round2(bonificacionesEnvioMl),
      bonificaciones_envio_ml_detalle: shipmentBonus.detail,
      shipping_list_cost: prorratear(shipmentBonus.gross_cost, item, precioTotal, cantidadItemsDistintos),
      shipping_list_cost_total_orden: round2(shipmentBonus.gross_cost),
      shipping_seller_cost: itemCargoEnvioMl,
      shipping_seller_cost_total_orden: round2(shipmentBonus.seller_cost),
      shipping_raw_seller_cost_total_orden: round2(rawSellerCost),
      shipment_costs_raw: shipmentCosts || null,
      creditos_ml: round2(itemDescuentos + itemBonificaciones),
      impuestos: itemImpuestos,
      retenciones: itemRetenciones,
      otros_gastos: itemOtrosGastos,
      cobro_neto: itemCobroNeto,
      cobro_neto_calculado: itemCobroNeto,
      cobro_neto_fuente: 'calculado_detalle_ml',

      mp_fee_details_total: prorratear(mp.mp_fee_details_total, item, precioTotal, cantidadItemsDistintos),
      mp_charges_fee_total: prorratear(mp.mp_charges_fee_total, item, precioTotal, cantidadItemsDistintos),
      mp_net_received_amount: prorratear(mp.mp_net_received_amount, item, precioTotal, cantidadItemsDistintos),
      mp_shipping_amount: prorratear(mp.mp_shipping_amount, item, precioTotal, cantidadItemsDistintos),

      es_flex: isFlex,
      envio_id: shipping.id || null,
      localidad,
      partido,
      estado: order.status,
      comprador,
      comprador_alias: comprador,
      buyer_nickname: comprador,
      payment_ids: payments.payment_ids,
      detalle_fees: billing.detalle_fees,

      account,
      cuenta: getAccountLabel(account),
      cuenta_key: account,
    };
  });
}

function buildCostosMap(costosCrudos = {}) {
  const map = {};

  Object.entries(costosCrudos).forEach(([codigo, costo]) => {
    const keyOriginal = String(codigo ?? '').trim();
    const keyNormalizada = normalizarCodigo(codigo);
    const valor = toNumber(costo);

    if (keyOriginal) map[keyOriginal] = valor;
    if (keyNormalizada) map[keyNormalizada] = valor;
  });

  return map;
}

function buscarCosto(costosMap, codigos = []) {
  for (const codigo of codigos) {
    const keyOriginal = String(codigo ?? '').trim();
    const keyNormalizada = normalizarCodigo(codigo);

    if (keyOriginal && Object.prototype.hasOwnProperty.call(costosMap, keyOriginal)) {
      return {
        costo: toNumber(costosMap[keyOriginal]),
        tieneCosto: true,
        codigo_usado: keyOriginal,
      };
    }

    if (keyNormalizada && Object.prototype.hasOwnProperty.call(costosMap, keyNormalizada)) {
      return {
        costo: toNumber(costosMap[keyNormalizada]),
        tieneCosto: true,
        codigo_usado: keyNormalizada,
      };
    }
  }

  return {
    costo: 0,
    tieneCosto: false,
    codigo_usado: null,
  };
}

function getCostoProducto(row, costosMap) {
  const items = Array.isArray(row.items) && row.items.length
    ? row.items
    : [{
        sku: row.sku,
        item_id: row.item_id || row.item_id_ml,
        item_id_ml: row.item_id || row.item_id_ml,
        producto: row.producto,
        cantidad: row.cantidad || 1,
      }];

  let costoTotal = 0;
  const faltantes = [];
  const encontrados = [];

  items.forEach(item => {
    const cantidad = toNumber(item.cantidad) || 1;
    const costoInfo = buscarCosto(costosMap, [
      item.sku,
      item.item_id,
      item.item_id_ml,
    ]);

    if (!costoInfo.tieneCosto) {
      faltantes.push({
        producto: item.producto || row.producto || '—',
        sku: item.sku || row.sku || '—',
        item_id: item.item_id || item.item_id_ml || row.item_id || '—',
        cantidad,
      });
      return;
    }

    const costoItem = costoInfo.costo * cantidad;
    costoTotal += costoItem;

    encontrados.push({
      producto: item.producto || row.producto || '—',
      sku: item.sku || row.sku || '—',
      item_id: item.item_id || item.item_id_ml || row.item_id || '—',
      cantidad,
      costo_unitario: costoInfo.costo,
      costo_total: round2(costoItem),
    });
  });

  return {
    costo: round2(costoTotal),
    tieneCosto: faltantes.length === 0,
    faltantes,
    encontrados,
  };
}

function buildLocalidadesMap(localidadesData = {}) {
  const rows = Array.isArray(localidadesData.localidades_activas)
    ? localidadesData.localidades_activas
    : Array.isArray(localidadesData.localidades)
      ? localidadesData.localidades.filter(l => l.activo !== false)
      : [];

  const byLocalidad = {};
  const byPartido = {};

  rows.forEach(row => {
    const localidad = row.localidad || row.nombre || '';
    const partido = row.partido || '';
    const tarifa = toNumber(row.tarifa);

    const localidadKey = normalizarCodigo(localidad);
    const partidoKey = normalizarCodigo(partido);

    if (localidadKey) byLocalidad[localidadKey] = tarifa;

    if (partidoKey && !Object.prototype.hasOwnProperty.call(byPartido, partidoKey)) {
      byPartido[partidoKey] = tarifa;
    }
  });

  return {
    rows,
    byLocalidad,
    byPartido,
  };
}

function getMensajeriaFlex(row, localidadesMap) {
  if (!row.es_flex) return 0;

  const localidadKey = normalizarCodigo(row.localidad);
  const partidoKey = normalizarCodigo(row.partido);

  if (localidadKey && Object.prototype.hasOwnProperty.call(localidadesMap.byLocalidad, localidadKey)) {
    return toNumber(localidadesMap.byLocalidad[localidadKey]);
  }

  if (partidoKey && Object.prototype.hasOwnProperty.call(localidadesMap.byPartido, partidoKey)) {
    return toNumber(localidadesMap.byPartido[partidoKey]);
  }

  return 0;
}

function aplicarRentabilidadSupabase(rows, costosMap, localidadesMap) {
  return rows.map(row => {
    const costoInfo = getCostoProducto(row, costosMap);
    const mensajeria = row.es_flex ? getMensajeriaFlex(row, localidadesMap) : 0;
    const flexSinMensajeria = !!row.es_flex && mensajeria === 0;
    const ganancia = round2(toNumber(row.cobro_neto) - costoInfo.costo - mensajeria);
    const margen = toNumber(row.precio_total) > 0 ? round2(ganancia / toNumber(row.precio_total) * 100) : 0;

    return {
      ...row,
      costo: costoInfo.costo,
      tiene_costo: costoInfo.tieneCosto,
      costo_faltantes: costoInfo.faltantes,
      costo_encontrados: costoInfo.encontrados,
      sin_costo: !costoInfo.tieneCosto,
      bonificado: costoInfo.tieneCosto && costoInfo.costo === 0,

      mensajeria,
      envio_flex_manual: mensajeria,
      envio_costo: round2(toNumber(row.cargo_envio_ml) + mensajeria),
      flex_sin_mensajeria: flexSinMensajeria,

      ganancia,
      margen,
      rentabilidad_fuente: 'api_ventas_costos_y_mensajeria_supabase',
    };
  });
}

function getPackageKey(row) {
  const account = row.cuenta_key || row.account || 'account';
  if (row.envio_id) return `${account}:shipment:${row.envio_id}`;
  if (row.pack_id) return `${account}:pack:${row.pack_id}`;
  return `${account}:order:${row.order_id || row.id}`;
}

function getSharedTotal(group, field, totalFields = []) {
  const totalCandidates = [];

  group.forEach(row => {
    totalFields.forEach(name => {
      const value = absNumber(row[name]);
      if (value > 0 && value < 1000000) totalCandidates.push(value);
    });
  });

  if (totalCandidates.length) return Math.max(...totalCandidates);

  const values = group.map(row => absNumber(row[field])).filter(value => value > 0 && value < 1000000);
  if (!values.length) return 0;

  const max = Math.max(...values);
  const sum = values.reduce((a, b) => a + b, 0);
  const allEqual = values.every(value => Math.abs(value - values[0]) < 1);

  if (allEqual && sum > max * 1.4) return max;
  return 0;
}

function splitSharedField(group, field, totalFields = []) {
  if (group.length <= 1) return false;

  const totalPrecio = group.reduce((sum, row) => sum + toNumber(row.precio_total), 0);
  if (!totalPrecio) return false;

  const currentSum = group.reduce((sum, row) => sum + absNumber(row[field]), 0);
  const sharedTotal = getSharedTotal(group, field, totalFields);

  if (!sharedTotal || currentSum <= sharedTotal + 1) return false;

  group.forEach(row => {
    const ratio = toNumber(row.precio_total) / totalPrecio;
    row[field] = round2(sharedTotal * ratio);
    row[`${field}_total_pedido`] = round2(sharedTotal);
    row.cargo_compartido_prorrateado = true;
  });

  return true;
}

function recalcularRowCobro(row) {
  row.cobro_neto = calcularCobroNeto({
    precioTotal: toNumber(row.precio_total),
    cargoVenta: toNumber(row.cargo_venta || row.ml_fee),
    cargoEnvioMl: toNumber(row.cargo_envio_ml),
    cargoFinanciacion: toNumber(row.cargo_financiacion),
    descuentos: toNumber(row.descuentos),
    bonificaciones: toNumber(row.bonificaciones),
    impuestos: toNumber(row.impuestos),
    retenciones: toNumber(row.retenciones),
    otrosGastos: toNumber(row.otros_gastos),
  });

  row.cobro_neto_calculado = row.cobro_neto;
  row.cobro_neto_fuente = row.cargo_compartido_prorrateado
    ? 'calculado_detalle_ml_pack_prorrateado'
    : row.cobro_neto_fuente || 'calculado_detalle_ml';
}

function normalizarPaquetesCompartidos(rows) {
  const groups = new Map();

  rows.forEach(row => {
    const key = getPackageKey(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  });

  groups.forEach(group => {
    if (group.length <= 1) return;

    group.forEach(row => {
      row.es_paquete_multi_producto = true;
      row.productos_en_pedido = group.length;
      row.pedido_key = getPackageKey(row);
    });

    splitSharedField(group, 'cargo_envio_ml', [
      'cargo_envio_ml_total_orden',
      'cargo_envio_ml_total_pedido',
      'shipping_seller_cost_total_orden',
    ]);

    splitSharedField(group, 'bonificaciones', [
      'bonificaciones_envio_ml_total_orden',
      'bonificaciones_envio_ml_total_pedido',
    ]);

    splitSharedField(group, 'bonificaciones_envio_ml', [
      'bonificaciones_envio_ml_total_orden',
      'bonificaciones_envio_ml_total_pedido',
    ]);

    splitSharedField(group, 'descuentos', ['descuentos_total_orden', 'descuentos_total_pedido']);
    splitSharedField(group, 'cargo_financiacion', ['cargo_financiacion_total_orden', 'cargo_financiacion_total_pedido']);
    splitSharedField(group, 'otros_gastos', ['otros_gastos_total_orden', 'otros_gastos_total_pedido']);
    splitSharedField(group, 'impuestos', ['impuestos_total_orden', 'impuestos_total_pedido']);

    group.forEach(recalcularRowCobro);

    const totalCobro = round2(group.reduce((sum, row) => sum + toNumber(row.cobro_neto), 0));
    const totalEnvio = round2(group.reduce((sum, row) => sum + toNumber(row.cargo_envio_ml), 0));

    group.forEach(row => {
      row.cobro_neto_total_pedido = totalCobro;
      row.cargo_envio_ml_total_pedido = totalEnvio;
    });
  });

  return rows;
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
      id: key,
      order_id: order.order_id,
      pack_id: order.pack_id,
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
    const baseUrl = getBaseUrl(req);

    const [costosData, localidadesData] = await Promise.all([
      fetchInternalJson(`${baseUrl}/api/costos?cb=${Date.now()}`, req).catch(error => ({
        error: error.message,
        costos: {},
      })),
      fetchInternalJson(`${baseUrl}/api/costos?modulo=localidades&cb=${Date.now()}`, req).catch(error => ({
        error: error.message,
        localidades: [],
        localidades_activas: [],
      })),
    ]);

    const costosMap = buildCostosMap(costosData.costos || {});
    const localidadesMap = buildLocalidadesMap(localidadesData || {});

    const accounts = {};
    const allRowsRaw = [];

    for (const accountKey of requestedAccounts) {
      const token = await getValidToken(req, res, accountKey);

      accounts[accountKey] = {
        account: accountKey,
        label: getAccountLabel(accountKey),
        connected: !!token,
        user_id: token?.user_id || null,
        total: 0,
        total_orders: 0,
        returned: 0,
        returned_orders: 0,
        returned_raw: 0,
        truncated: false,
        error: null,
      };

      if (!token) continue;

      try {
        const searchData = await buscarOrdenesPaginadas(token, dateFrom, dateTo);

        accounts[accountKey].total = searchData.total;
        accounts[accountKey].total_orders = searchData.total;
        accounts[accountKey].returned_raw = searchData.returned;
        accounts[accountKey].truncated = searchData.truncated;
        accounts[accountKey].max_orders = searchData.max_orders;

        const normalizedGroups = await Promise.all(
          searchData.results.map(order => normalizarOrden(order, token, accountKey))
        );

        normalizedGroups.flat().forEach(row => allRowsRaw.push(row));
      } catch (accountError) {
        accounts[accountKey].error = accountError.message;
      }
    }

    const rowsWithSharedPackagesFixed = normalizarPaquetesCompartidos(allRowsRaw);
    const rowsWithRentabilidad = aplicarRentabilidadSupabase(rowsWithSharedPackagesFixed, costosMap, localidadesMap);
    const dedupeResult = deduplicarOrdenes(rowsWithRentabilidad);
    const allOrders = dedupeResult.orders;

    allOrders.sort((a, b) => {
      const fechaA = String(a.fecha || '');
      const fechaB = String(b.fecha || '');
      return fechaB.localeCompare(fechaA);
    });

    for (const accountKey of Object.keys(accounts)) {
      const rowsForAccount = allOrders.filter(order => order.cuenta_key === accountKey);
      accounts[accountKey].returned = rowsForAccount.length;
      accounts[accountKey].returned_orders = new Set(rowsForAccount.map(order => String(order.order_id))).size;
    }

    const flexSinMensajeria = allOrders.filter(row => row.flex_sin_mensajeria).length;
    const mensajeriaTotal = round2(allOrders.reduce((sum, row) => sum + toNumber(row.mensajeria), 0));
    const gananciaTotal = round2(allOrders.reduce((sum, row) => sum + toNumber(row.ganancia), 0));
    const sinCosto = allOrders.filter(row => row.sin_costo).length;

    res.status(200).json({
      desde: dateFrom,
      hasta: dateTo,
      requested_account: account,
      accounts,
      connected_accounts: Object.values(accounts).filter(a => a.connected).length,
      total_accounts: Object.keys(accounts).length,
      total: Object.values(accounts).reduce((s, a) => s + (a.total || 0), 0),
      total_orders: Object.values(accounts).reduce((s, a) => s + (a.total_orders || 0), 0),
      returned_raw: allRowsRaw.length,
      returned: allOrders.length,
      returned_orders: new Set(allOrders.map(order => String(order.order_id))).size,
      duplicated_removed: dedupeResult.duplicados.length,
      duplicados_eliminados: dedupeResult.duplicados,
      truncated: Object.values(accounts).some(a => a.truncated),
      rentabilidad: {
        fuente: 'api_ventas_costos_y_mensajeria_supabase',
        costos_cargados: Object.keys(costosData.costos || {}).length,
        localidades_cargadas: localidadesMap.rows.length,
        costos_error: costosData.error || null,
        localidades_error: localidadesData.error || null,
        sin_costo: sinCosto,
        flex_sin_mensajeria: flexSinMensajeria,
        mensajeria_total: mensajeriaTotal,
        ganancia_total: gananciaTotal,
        regla: 'Venta Flex descuenta mensajería Supabase. Venta no Flex no descuenta mensajería manual.',
      },
      orders: allOrders,
    });
  } catch (err) {
    res.status(500).json({ error: 'Error al consultar ventas', detail: err.message });
  }
}
