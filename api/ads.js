import { getValidToken } from './_token.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const token = await getValidToken(req, res);
  if (!token) return res.status(401).json({ error: 'No autenticado', redirect: '/api/login' });

  const { desde, hasta } = req.query;

  const dateFrom = desde || (() => { const d = new Date(); d.setDate(d.getDate() - 30); return d.toISOString().slice(0, 10); })();
  const dateTo = hasta || new Date().toISOString().slice(0, 10);

  try {
    const adsUrl = `https://api.mercadolibre.com/advertising/product_ads/reports/performance?advertiser_id=${token.user_id}&date_from=${dateFrom}&date_to=${dateTo}&group_by=ITEM&limit=50`;

    const adsRes = await fetch(adsUrl, {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    const adsData = await adsRes.json();

    if (adsData.error) return res.status(400).json({ error: adsData.error, message: adsData.message });

    const items = (adsData.results || []).map(item => ({
      item_id: item.item_id,
      titulo: item.item_title || item.item_id,
      gasto: item.spend || 0,
      ingresos: item.attributed_gmv || 0,
      impresiones: item.impressions || 0,
      clicks: item.clicks || 0,
      roas: item.spend > 0 ? (item.attributed_gmv / item.spend) : 0,
      ctr: item.impressions > 0 ? (item.clicks / item.impressions * 100) : 0,
    }));

    const totGasto = items.reduce((s, i) => s + i.gasto, 0);
    const totIngresos = items.reduce((s, i) => s + i.ingresos, 0);

    res.status(200).json({
      desde: dateFrom,
      hasta: dateTo,
      roas_global: totGasto > 0 ? totIngresos / totGasto : 0,
      gasto_total: totGasto,
      ingresos_total: totIngresos,
      items,
    });
  } catch (err) {
    res.status(500).json({ error: 'Error al consultar Mercado Ads', detail: err.message });
  }
}
