import { getValidToken } from './_token.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const token = await getValidToken(req, res);
  if (!token) return res.status(401).json({ error: 'No autenticado', redirect: '/api/login' });

  const { desde, hasta, offset = 0 } = req.query;
  const limit = 50;

  const dateFrom = desde ? `${desde}T00:00:00.000-03:00` : (() => {
    const d = new Date(); d.setDate(d.getDate() - 30); return d.toISOString();
  })();
  const dateTo = hasta ? `${hasta}T23:59:59.000-03:00` : new Date().toISOString();

  try {
    const searchUrl = `https://api.mercadolibre.com/orders/search?seller=${token.user_id}&order.status=paid&order.date_created.from=${encodeURIComponent(dateFrom)}&order.date_created.to=${encodeURIComponent(dateTo)}&offset=${offset}&limit=${limit}&sort=date_desc`;

    const searchRes = await fetch(searchUrl, {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    const searchData = await searchRes.json();

    if (searchData.error) return res.status(400).json({ error: searchData.error, message: searchData.message });

    const orders = await Promise.all((searchData.results || []).map(async order => {
      const item = order.order_items?.[0] || {};
      const shipping = order.shipping || {};

      let ml_fee = 0;
      let envio_ml_costo = 0;
      let es_flex = false;
      let localidad = '—';
      let partido = '—';

      // Comisiones desde billing
      try {
        const billingRes = await fetch(
          `https://api.mercadolibre.com/orders/${order.id}/billing_info`,
          { headers: { Authorization: `Bearer ${token.access_token}` } }
        );
        const billingData = await billingRes.json();
        if (billingData && !billingData.error) {
          const feeDetail = (billingData.sale_fees || []).find(f => f.type === 'ml_fee');
          const shippingFee = (billingData.sale_fees || []).find(f => f.type === 'shipping_fee');
          if (feeDetail) ml_fee = Math.abs(feeDetail.amount || 0);
          if (shippingFee) envio_ml_costo = Math.abs(shippingFee.amount || 0);
        }
      } catch(e) {}

      // Si billing no trajo comisión, calcularla del total
      if (ml_fee === 0 && order.total_amount > 0) {
        const feeFromOrder = order.order_items?.reduce((s, i) => s + (i.sale_fee || 0), 0) || 0;
        ml_fee = Math.abs(feeFromOrder);
      }

      // Localidad y tipo de envío
      if (shipping.id) {
        try {
          const shipRes = await fetch(
            `https://api.mercadolibre.com/shipments/${shipping.id}`,
            { headers: { Authorization: `Bearer ${token.access_token}` } }
          );
          const shipData = await shipRes.json();
          localidad = shipData.receiver_address?.city?.name || '—';
          partido = shipData.receiver_address?.state?.name || '—';
          es_flex = shipData.logistic_type === 'self_service' ||
                    (shipData.mode === 'me2' && shipData.sub_mode === 'flex') ||
                    (shipData.tags || []).includes('self_service');
          if (!envio_ml_costo && shipData.shipping_option?.cost) {
            envio_ml_costo = shipData.shipping_option.cost;
          }
        } catch(e) {}
      }

      return {
        id: order.id,
        fecha: order.date_created?.slice(0, 10),
        producto: item.item?.title || '—',
        item_id: item.item?.id,
        cantidad: item.quantity || 1,
        precio_unitario: item.unit_price || 0,
        precio_total: order.total_amount || 0,
        ml_fee,
        envio_ml_costo,
        es_flex,
        envio_id: shipping.id || null,
        localidad,
        partido,
        estado: order.status,
        comprador: order.buyer?.nickname || '—',
      };
    }));

    res.status(200).json({
      total: searchData.paging?.total || 0,
      offset: searchData.paging?.offset || 0,
      limit: searchData.paging?.limit || 50,
      orders,
    });
  } catch (err) {
    res.status(500).json({ error: 'Error al consultar ventas', detail: err.message });
  }
}
