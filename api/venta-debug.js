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
const MAX_PAGES = 30;

function num(value) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function abs(value) {
  return Math.abs(num(value));
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

async function fetchJson(url, token) {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token.access_token}`,
    },
  });

  const data = await response.json().catch(() => ({}));

  return {
    ok: response.ok,
    status: response.status,
    url,
    data,
    error: response.ok ? null : (data.message || data.error || `HTTP ${response.status}`),
  };
}

async function directOrderLookup(orderId, token) {
  return fetchJson(`${ML_API}/orders/${encodeURIComponent(orderId)}`, token);
}

function orderMatches(order, lookupId) {
  const wanted = String(lookupId || '').trim();
  if (!wanted) return false;

  const candidates = [
    order.id,
    order.pack_id,
    order.shipping?.id,
    order.shipping?.shipment_id,
  ]
    .filter(value => value !== null && value !== undefined)
    .map(value => String(value));

  return candidates.includes(wanted);
}

async function searchOrderByVisibleId({ lookupId, token, desde, hasta }) {
  const dateFrom = buildDateFrom(desde);
  const dateTo = buildDateTo(hasta);
  let offset = 0;
  let page = 0;
  let total = 0;
  const inspected = [];

  while (page < MAX_PAGES) {
    const url = `${ML_API}/orders/search?seller=${token.user_id}&order.status=paid&order.date_created.from=${encodeURIComponent(dateFrom)}&order.date_created.to=${encodeURIComponent(dateTo)}&offset=${offset}&limit=${PAGE_LIMIT}&sort=date_desc`;
    const response = await fetchJson(url, token);

    if (!response.ok) {
      return {
        ok: false,
        error: response.error,
        status: response.status,
        inspected,
      };
    }

    const results = response.data.results || [];
    total = response.data.paging?.total || total;

    for (const order of results) {
      inspected.push({
        id: order.id,
        pack_id: order.pack_id,
        shipping_id: order.shipping?.id,
        date_created: order.date_created,
        total_amount: order.total_amount,
        title: order.order_items?.[0]?.item?.title,
      });

      if (orderMatches(order, lookupId)) {
        return {
          ok: true,
          order,
          matched_by_search: true,
          date_from: dateFrom,
          date_to: dateTo,
          inspected_count: inspected.length,
          total,
        };
      }
    }

    if (!results.length) break;
    if (offset + PAGE_LIMIT >= total) break;

    offset += PAGE_LIMIT;
    page += 1;
  }

  return {
    ok: false,
    error: 'No se encontró la venta en orders/search para esa cuenta y rango de fechas.',
    date_from: dateFrom,
    date_to: dateTo,
    inspected_count: inspected.length,
    total,
    inspected: inspected.slice(0, 30),
  };
}

async function resolveOrderForAccount({ lookupId, token, account, desde, hasta }) {
  const direct = await directOrderLookup(lookupId, token);

  if (direct.ok) {
    return {
      ok: true,
      account,
      cuenta: getAccountLabel(account),
      token_user_id: token.user_id,
      source: 'direct_order_id',
      order: direct.data,
      direct_status: direct.status,
    };
  }

  const searched = await searchOrderByVisibleId({ lookupId, token, desde, hasta });

  if (searched.ok) {
    return {
      ok: true,
      account,
      cuenta: getAccountLabel(account),
      token_user_id: token.user_id,
      source: 'orders_search_match_id_pack_or_shipping',
      order: searched.order,
      direct_error: direct.error,
      direct_status: direct.status,
      search_meta: {
        date_from: searched.date_from,
        date_to: searched.date_to,
        inspected_count: searched.inspected_count,
        total: searched.total,
      },
    };
  }

  return {
    ok: false,
    account,
    cuenta: getAccountLabel(account),
    token_user_id: token.user_id,
    direct_error: direct.error,
    direct_status: direct.status,
    search_error: searched.error,
    search_status: searched.status || null,
    search_meta: {
      date_from: searched.date_from,
      date_to: searched.date_to,
      inspected_count: searched.inspected_count,
      total: searched.total,
      inspected_sample: searched.inspected || [],
    },
  };
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
        output.push({ path, value: parsed, raw: value });
      }
      return;
    }

    if (value && typeof value === 'object') {
      flattenNumericFields(value, path, output);
    }
  });

  return output;
}

function containsAny(text, words = []) {
  const clean = String(text || '').toLowerCase();
  return words.some(word => clean.includes(word));
}

function detectCandidateCredits(numericFields = []) {
  const creditWords = [
    'discount',
    'bonification',
    'bonus',
    'compensation',
    'subsidy',
    'subsidized',
    'loyal',
    'promotion',
    'promoted',
    'gap',
    'list_cost',
    'listcost',
    'descuento',
    'bonificacion',
    'bonificación',
  ];

  return numericFields
    .filter(field => field.value > 0 && containsAny(field.path, creditWords))
    .sort((a, b) => b.value - a.value);
}

function redactOrder(order) {
  if (!order || typeof order !== 'object') return order;

  return {
    id: order.id,
    pack_id: order.pack_id,
    status: order.status,
    date_created: order.date_created,
    total_amount: order.total_amount,
    paid_amount: order.paid_amount,
    currency_id: order.currency_id,
    seller: order.seller ? { id: order.seller.id, nickname: order.seller.nickname } : null,
    buyer: order.buyer ? { id: order.buyer.id, nickname: order.buyer.nickname } : null,
    shipping: order.shipping,
    order_items: order.order_items,
    payments: (order.payments || []).map(payment => ({
      id: payment.id,
      status: payment.status,
      status_detail: payment.status_detail,
      transaction_amount: payment.transaction_amount,
      total_paid_amount: payment.total_paid_amount,
      shipping_cost: payment.shipping_cost,
      coupon_amount: payment.coupon_amount,
      taxes_amount: payment.taxes_amount,
      marketplace_fee: payment.marketplace_fee,
      date_approved: payment.date_approved,
    })),
  };
}

function redactShipment(shipment) {
  if (!shipment || typeof shipment !== 'object') return shipment;

  return {
    id: shipment.id,
    status: shipment.status,
    substatus: shipment.substatus,
    mode: shipment.mode,
    logistic_type: shipment.logistic_type,
    sub_mode: shipment.sub_mode,
    base_cost: shipment.base_cost,
    cost: shipment.cost,
    list_cost: shipment.list_cost,
    tags: shipment.tags,
    shipping_option: shipment.shipping_option,
    cost_components: shipment.cost_components,
    sender_id: shipment.sender_id,
    receiver_id: shipment.receiver_id,
    receiver_address: shipment.receiver_address ? {
      city: shipment.receiver_address.city,
      state: shipment.receiver_address.state,
      zip_code: shipment.receiver_address.zip_code,
    } : null,
  };
}

function summarizePayments(mpResponses) {
  return mpResponses.map(response => {
    const payment = response.data || {};
    return {
      ok: response.ok,
      status: response.status,
      id: payment.id,
      payment_status: payment.status,
      status_detail: payment.status_detail,
      transaction_amount: payment.transaction_amount,
      shipping_amount: payment.shipping_amount,
      coupon_amount: payment.coupon_amount,
      transaction_details: payment.transaction_details,
      fee_details: payment.fee_details,
      taxes: payment.taxes,
      charges_details: payment.charges_details,
      money_release_date: payment.money_release_date,
    };
  });
}

function calcOrderItems(order) {
  const items = order?.order_items || [];
  return items.reduce((acc, item) => {
    const quantity = num(item.quantity) || 1;
    const unitPrice = num(item.unit_price);
    const saleFee = abs(item.sale_fee) * quantity;

    acc.total_items += unitPrice * quantity;
    acc.sale_fee_items += saleFee;
    acc.quantity += quantity;
    acc.items.push({
      title: item.item?.title,
      item_id: item.item?.id,
      seller_sku: item.seller_sku || item.item?.seller_sku || item.item?.seller_custom_field,
      quantity,
      unit_price: unitPrice,
      full_unit_price: item.full_unit_price,
      sale_fee: saleFee,
      raw_sale_fee: item.sale_fee,
    });

    return acc;
  }, {
    total_items: 0,
    sale_fee_items: 0,
    quantity: 0,
    items: [],
  });
}

function calcBillingFees(billingInfo) {
  const fees = billingInfo?.sale_fees || billingInfo?.data?.sale_fees || [];
  const rows = Array.isArray(fees) ? fees : [];

  return rows.map(fee => ({
    type: fee.type,
    detail: fee.detail || fee.name || fee.description,
    amount: fee.amount,
    absolute_amount: abs(fee.amount),
    raw: fee,
  }));
}

function calcPaymentSummary(mpPayments) {
  return mpPayments.reduce((acc, paymentResponse) => {
    const payment = paymentResponse.data || {};

    acc.net_received_amount += num(payment.transaction_details?.net_received_amount);
    acc.total_paid_amount += num(payment.transaction_details?.total_paid_amount || payment.transaction_amount);
    acc.shipping_amount += abs(payment.shipping_amount);

    (payment.fee_details || []).forEach(fee => {
      acc.fee_details_total += abs(fee.amount);
    });

    (payment.taxes || []).forEach(tax => {
      acc.taxes_total += abs(tax.value || tax.amount);
    });

    (payment.charges_details || []).forEach(charge => {
      acc.charges_details.push({
        name: charge.name,
        type: charge.type,
        accounts: charge.accounts,
        amounts: charge.amounts,
        metadata: charge.metadata,
      });
    });

    return acc;
  }, {
    net_received_amount: 0,
    total_paid_amount: 0,
    shipping_amount: 0,
    fee_details_total: 0,
    taxes_total: 0,
    charges_details: [],
  });
}

function getShipmentCost(shipment) {
  return abs(
    shipment?.base_cost ||
    shipment?.cost ||
    shipment?.shipping_option?.cost ||
    shipment?.shipping_option?.base_cost ||
    shipment?.cost_components?.seller_cost ||
    shipment?.shipping_option?.cost_components?.seller_cost ||
    0
  );
}

function getShipmentListCost(shipment) {
  return abs(
    shipment?.shipping_option?.list_cost ||
    shipment?.list_cost ||
    shipment?.cost_components?.list_cost ||
    shipment?.shipping_option?.cost_components?.list_cost ||
    0
  );
}

function buildCalculations({ order, shipment, billingInfo, mpPayments }) {
  const items = calcOrderItems(order);
  const billingFees = calcBillingFees(billingInfo);
  const paymentSummary = calcPaymentSummary(mpPayments);

  const shipmentFields = flattenNumericFields(shipment || {});
  const shipmentCreditCandidates = detectCandidateCredits(shipmentFields);
  const shipmentListCost = getShipmentListCost(shipment);
  const shipmentSellerCost = getShipmentCost(shipment);

  const orderTotal = num(order?.total_amount) || items.total_items;
  const saleFee = billingFees
    .filter(fee => containsAny(`${fee.type} ${fee.detail}`, ['sale_fee', 'ml_fee', 'cargo por venta', 'comision', 'comisión']))
    .reduce((sum, fee) => sum + fee.absolute_amount, 0) || items.sale_fee_items || paymentSummary.fee_details_total;

  const taxes = billingFees
    .filter(fee => containsAny(`${fee.type} ${fee.detail}`, ['tax', 'iva', 'iibb', 'impuesto', 'ingresos brutos']))
    .reduce((sum, fee) => sum + fee.absolute_amount, 0) || paymentSummary.taxes_total;

  const explicitCredits = billingFees
    .filter(fee => containsAny(`${fee.type} ${fee.detail}`, ['discount', 'bonus', 'bonific', 'coupon', 'subsidy', 'descuento', 'cupón', 'cupon']))
    .reduce((sum, fee) => sum + fee.absolute_amount, 0);

  const largestShipmentCandidate = shipmentCreditCandidates[0]?.value || 0;
  const listCostFallback = shipmentListCost > 0 && shipmentSellerCost <= 10 ? shipmentListCost : 0;
  const bestCreditCandidate = Math.max(explicitCredits, largestShipmentCandidate, listCostFallback);

  const cobroNetoSinCreditos = paymentSummary.net_received_amount;
  const cobroNetoConCreditos = paymentSummary.net_received_amount + bestCreditCandidate;
  const cobroNetoFormula = orderTotal - saleFee - shipmentSellerCost - taxes + bestCreditCandidate;

  return {
    items,
    billing_fees_detected: billingFees,
    payment_summary: paymentSummary,
    shipment_numeric_fields: shipmentFields.sort((a, b) => b.value - a.value).slice(0, 100),
    shipment_credit_candidates: shipmentCreditCandidates.slice(0, 40),
    shipment_list_cost: shipmentListCost,
    shipment_seller_cost: shipmentSellerCost,
    explicit_credits_from_billing: explicitCredits,
    largest_shipment_credit_candidate: largestShipmentCandidate,
    list_cost_fallback_credit: listCostFallback,
    best_credit_candidate: bestCreditCandidate,
    expected_by_formula: {
      order_total: orderTotal,
      sale_fee: saleFee,
      shipment_seller_cost: shipmentSellerCost,
      taxes,
      credit_candidate: bestCreditCandidate,
      net_without_credit: cobroNetoSinCreditos,
      net_with_credit: cobroNetoConCreditos,
      net_formula: cobroNetoFormula,
    },
  };
}

async function buildDebugResponse({ account, token, resolved }) {
  const order = resolved.order;
  const orderId = order.id;
  const shippingId = order.shipping?.id;
  const paymentIds = (order.payments || []).map(payment => payment.id).filter(Boolean);

  const [billingResponse, shipmentResponse, ...paymentResponses] = await Promise.all([
    fetchJson(`${ML_API}/orders/${encodeURIComponent(orderId)}/billing_info`, token),
    shippingId
      ? fetchJson(`${ML_API}/shipments/${encodeURIComponent(shippingId)}`, token)
      : Promise.resolve({ ok: false, status: 404, data: null, error: 'Orden sin shipping.id' }),
    ...paymentIds.map(paymentId => fetchJson(`${MP_API}/v1/payments/${encodeURIComponent(paymentId)}`, token)),
  ]);

  const shipment = shipmentResponse.ok ? shipmentResponse.data : null;
  const billingInfo = billingResponse.ok ? billingResponse.data : null;
  const mpPayments = paymentResponses.filter(response => response.ok);

  const calculations = buildCalculations({
    order,
    shipment,
    billingInfo,
    mpPayments,
  });

  return {
    ok: true,
    account,
    cuenta: getAccountLabel(account),
    token_user_id: token.user_id,
    lookup_source: resolved.source,
    direct_error: resolved.direct_error || null,
    search_meta: resolved.search_meta || null,
    order_id: String(orderId),
    original_lookup_id: String(orderId),
    pack_id: order.pack_id || null,
    shipping_id: shippingId || null,
    payment_ids: paymentIds,
    nota: 'Debug sanitizado. No devuelve dirección completa ni datos sensibles del comprador. Sirve para ubicar dónde ML esconde descuentos/bonificaciones.',
    calculations,
    order: redactOrder(order),
    billing_info_status: {
      ok: billingResponse.ok,
      status: billingResponse.status,
      error: billingResponse.error,
    },
    billing_info: billingInfo,
    shipment_status: {
      ok: shipmentResponse.ok,
      status: shipmentResponse.status,
      error: shipmentResponse.error,
    },
    shipment: redactShipment(shipment),
    payments: summarizePayments(paymentResponses),
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  const accountQuery = req.query.account || 'all';
  const lookupId = req.query.order_id || req.query.id || req.query.venta_id || req.query.sale_id;
  const desde = req.query.desde || DEFAULT_DATE_FROM;
  const hasta = req.query.hasta;

  if (!lookupId) {
    res.status(400).json({
      ok: false,
      error: 'Falta order_id. Ejemplo: /api/venta-debug?account=all&order_id=2000013072192145&desde=2026-01-01',
    });
    return;
  }

  try {
    const requestedAccounts = getRequestedAccounts(accountQuery);
    const attempts = [];

    for (const account of requestedAccounts) {
      const token = await getValidToken(req, res, account);

      if (!token) {
        attempts.push({
          ok: false,
          account,
          cuenta: getAccountLabel(account),
          error: 'Cuenta no conectada',
        });
        continue;
      }

      const resolved = await resolveOrderForAccount({
        lookupId,
        token,
        account,
        desde,
        hasta,
      });

      if (resolved.ok) {
        const debug = await buildDebugResponse({
          account,
          token,
          resolved,
        });

        res.status(200).json({
          ...debug,
          requested_account: accountQuery,
          requested_lookup_id: String(lookupId),
          attempts,
        });
        return;
      }

      attempts.push(resolved);
    }

    res.status(404).json({
      ok: false,
      error: 'No se encontró la venta en ninguna cuenta consultada.',
      requested_account: accountQuery,
      requested_lookup_id: String(lookupId),
      desde: buildDateFrom(desde),
      hasta: buildDateTo(hasta),
      attempts,
      sugerencia: 'Probá usar account=all y un rango desde/hasta que incluya la fecha de la venta. El ID de la URL de Mercado Libre a veces puede ser pack_id o shipment_id, no order_id directo. Sí, porque hacerlo simple aparentemente era ilegal.',
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: 'Error generando debug de venta',
      detail: error.message,
    });
  }
}
