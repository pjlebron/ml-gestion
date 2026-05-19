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

      let cargo_venta = 0;
      let descuentos = 0;
      let impuestos = 0;
      let cobro_neto = 0;
      let es_flex = false;
      let localidad = '—';
      let partido = '—';

      // Billing: cargo por venta, descuentos, impuestos
      try {
        const billingRes = await fetch(
          `https://api.mercadolibre.com/orders/${order.id}/billing_info`,
          { headers: { Authorization: `Bearer ${token.access_token}` } }
        );
        const b = await billingRes.json();
        if (b && !b.error) {
          (b.sale_fees || []).forEach(f => {
            const amt = f.amount || 0;
            if (f.type === 'ml_fee' || f.type === 'shipping_fee' || f.type === 'financing_fee') {
              cargo_venta += Math.abs(amt);
            } else if (f.type === 'discount' || f.type === 'bonus' || amt > 0) {
              descuentos += Math.abs(amt);
            } else if (f.type === 'tax' || f.type === 'iva') {
              impuestos += Math.abs(amt);
            }
          });
          cobro_neto = b.net_amount || (order.total_amount - cargo_venta + descuentos - impuestos);
        }
      } catch(e) {}

      // Fallback: calcular desde order_items si billing no trajo datos
      if (cargo_venta === 0) {
        cargo_venta = order.order_items?.reduce((s, i) => s + Math.abs(i.sale_fee || 0), 0) || 0;
        cobro_neto = order.total_amount - cargo_venta - impuestos + descuentos;
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
        cargo_venta,
        descuentos,
        impuestos,
        cobro_neto,
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
