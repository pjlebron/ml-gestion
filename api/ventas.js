import { getValidToken } from './_token.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const token = await getValidToken(req, res);
  if (!token) return res.status(401).json({ error: 'No autenticado', redirect: '/api/login' });

  const { desde, hasta, offset = 0, limit = 50 } = req.query;

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

    const orders = (searchData.results || []).map(order => {
      const item = order.order_items?.[0] || {};
      const shipping = order.shipping || {};
      return {
        id: order.id,
        fecha: order.date_created?.slice(0, 10),
        producto: item.item?.title || '—',
        item_id: item.item?.id,
        cantidad: item.quantity || 1,
        precio_unitario: item.unit_price || 0,
        precio_total: order.total_amount || 0,
        ml_fee: order.marketplace_fee || 0,
        envio_id: shipping.id || null,
        localidad: shipping.receiver_address?.city?.name || '—',
        partido: shipping.receiver_address?.state?.name || '—',
        estado: order.status,
        comprador: order.buyer?.nickname || '—',
      };
    });

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
