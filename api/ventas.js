import { getValidToken } from './_token.js';

const ML_API = 'https://api.mercadolibre.com';
const MP_API = 'https://api.mercadopago.com';

function n(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
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

function sumarOrderItems(order) {
  const items = order.order_items || [];

  return items.reduce((acc, item) => {
    const cantidad = n(item.quantity) || 1;
    const unitPrice = n(item.unit_price);
    const fullUnitPrice = n(item.full_unit_price);
    const saleFee = Math.abs(n(item.sale_fee));

    acc.cantidad += cantidad;
    acc.precio_items += unitPrice * cantidad;
    acc.precio_lista += (fullUnitPrice || unitPrice) * cantidad;
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
    acc.payment_ids.push(payment.id);
    acc.transaction_amount += n(payment.transaction_amount);
    acc.total_paid_amount += n(payment.total_paid_amount);
    acc.shipping_cost += n(payment.shipping_cost);
    acc.marketplace_fee += Math.abs(n(payment.marketplace_fee));
    acc.coupon_amount += Math.abs(n(payment.coupon_amount));
    acc.taxes_amount += Math.abs(n(payment.taxes_amount));

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
  };

  const fees = billingInfo?.sale_fees || [];

  fees.forEach(fee => {
    const type = String(fee.type || '').toLowerCase();
    const detail = String(fee.detail || fee.name || '').toLowerCase();
    const amount = Math.abs(n(fee.amount));

    if (!amount) return;

    if (type.includes('shipping') || detail.includes('env')) {
      result.cargo_envio_ml += amount;
    } else if (type.includes('financing') || detail.includes('financi')) {
      result.cargo_financiacion += amount;
    } else if (type.includes('tax') || type.includes('iva') || detail.includes('iva') || detail.includes('impuesto')) {
      result.impuestos += amount;
    } else if (type.includes('retention') || detail.includes('retenci')) {
      result.retenciones += amount;
    } else if (type.includes('discount') || detail.includes('descuento')) {
      result.descuentos += amount;
    } else if (type.includes('bonus') || detail.includes('bonific')) {
      result.bonificaciones += amount;
    } else {
      result.cargo_venta += amount;
    }
  });

  return result;
}

async function leerBillingInfo(orderId, token) {
  try {
    const data = await fetchJson(`${ML_API}/orders/${orderId}/billing_info`, token);
    return data;
  } catch (error) {
    return null;
  }
}

async function leerShipment(shippingId, token) {
  if (!shippingId) return null;

  try {
    return await fetchJson(`${ML_API}/shipments/${shippingId}`, token);
  } catch (error) {
    return null;
  }
}

async function leerMercadoPago(paymentId, token) {
  if (!paymentId) return null;

  try {
    return await fetchJson(`${MP_API}/v1/payments/${paymentId}`, token);
  } catch (error) {
    return null;
  }
}

function resumirMercadoPago(mpPayments) {
  const result = {
    mp_fee_details_total: 0,
    mp_taxes_total: 0,
    mp_net_received_amount: 0,
    mp_shipping_amount: 0,
  };

  mpPayments.filter(Boolean).forEach(payment => {
    result.mp_net_received_amount += n(payment.transaction_details?.net_received_amount);
    result.mp_shipping_amount += n(payment.shipping_amount);

    (payment.fee_details || []).forEach(fee => {
      result.mp_fee_details_total += Math.abs(n(fee.amount));
    });

    (payment.taxes || []).forEach(tax => {
      result.mp_taxes_total += Math.abs(n(tax.value || tax.amount));
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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const token = await getValidToken(req, res);
  if (!token) return res.status(401).json({ error: 'No autenticado', redirect: '/api/login' });

  const { desde, hasta, offset = 0 } = req.query;
  const limit = 50;

  const dateFrom = desde ? `${desde}T00:00:00.000-03:00` : (() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return d.toISOString();
  })();

  const dateTo = hasta ? `${hasta}T23:59:59.000-03:00` : new Date().toISOString();

  try {
    const searchUrl = `${ML_API}/orders/search?seller=${token.user_id}&order.status=paid&order.date_created.from=${encodeURIComponent(dateFrom)}&order.date_created.to=${encodeURIComponent(dateTo)}&offset=${offset}&limit=${limit}&sort=date_desc`;
    const searchData = await fetchJson(searchUrl, token);

    const orders = await Promise.all((searchData.results || []).map(async order => {
      const item = order.order_items?.[0] || {};
      const shipping = order.shipping || {};
      const orderItems = sumarOrderItems(order);
      const payments = sumarPayments(order);

      const [billingInfo, shipData, ...mpPayments] = await Promise.all([
        leerBillingInfo(order.id, token),
        leerShipment(shipping.id, token),
        ...payments.payment_ids.map(paymentId => leerMercadoPago(paymentId, token)),
      ]);

      const billingFees = clasificarBillingFees(billingInfo);
      const mp = resumirMercadoPago(mpPayments);

      const cargoVenta = billingFees.cargo_venta || payments.marketplace_fee || orderItems.sale_fee || 0;
      const cargoEnvioMl = billingFees.cargo_envio_ml || 0;
      const cargoFinanciacion = billingFees.cargo_financiacion || 0;
      const descuentos = billingFees.descuentos || payments.coupon_amount || 0;
      const bonificaciones = billingFees.bonificaciones || 0;
      const impuestos = billingFees.impuestos || payments.taxes_amount || mp.mp_taxes_total || 0;
      const retenciones = billingFees.retenciones || 0;

      const precioTotal = n(order.total_amount) || orderItems.precio_items || payments.transaction_amount;
      const cobroNeto = n(billingInfo?.net_amount) || mp.mp_net_received_amount || (
        precioTotal - cargoVenta - cargoEnvioMl - cargoFinanciacion - impuestos - retenciones - descuentos + bonificaciones
      );

      const localidad = shipData?.receiver_address?.city?.name || '—';
      const partido = shipData?.receiver_address?.state?.name || '—';
      const esFlex = detectarFlex(shipData);

      return {
        id: order.id,
        fecha: order.date_created?.slice(0, 10),
        producto: item.item?.title || '—',
        item_id: item.item?.id || null,
        cantidad: item.quantity || orderItems.cantidad || 1,
        precio_unitario: n(item.unit_price),
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
        mp_fee_details_total: mp.mp_fee_details_total,
        mp_net_received_amount: mp.mp_net_received_amount,
        cobro_neto: cobroNeto,

        es_flex: esFlex,
        envio_id: shipping.id || null,
        localidad,
        partido,
        estado: order.status,
        comprador: order.buyer?.nickname || '—',
        payment_ids: payments.payment_ids,
      };
    }));

    res.status(200).json({
      total: searchData.paging?.total || 0,
      offset: searchData.paging?.offset || 0,
      limit: searchData.paging?.limit || limit,
      orders,
    });
  } catch (err) {
    res.status(500).json({ error: 'Error al consultar ventas', detail: err.message });
  }
}
