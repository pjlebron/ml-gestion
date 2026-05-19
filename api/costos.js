export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const SHEET_ID = '1AJRDGujWNkam2cWrH050zjTTz0Gmuo_niK_nMTTzKIM';
  const SHEET_NAME = 'PRODUCTOS';

  try {
    const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json&sheet=${encodeURIComponent(SHEET_NAME)}`;
    const r = await fetch(url);
    const text = await r.text();
    const json = JSON.parse(text.replace(/^[^{]*/, '').replace(/[^}]*$/, ''));

    const rows = json.table.rows;
    const cols = json.table.cols.map(c => c.label.trim().toUpperCase());

    const skuIdx = cols.indexOf('SKU');
    const costoIdx = cols.indexOf('COSTO');

    if (skuIdx === -1 || costoIdx === -1) {
      return res.status(400).json({ error: 'No se encontraron columnas SKU o COSTO' });
    }

    const costos = {};
    rows.forEach(row => {
      const sku = row.c[skuIdx]?.v;
      const costo = row.c[costoIdx]?.v;
      if (sku && costo !== null && costo !== undefined) {
        costos[String(sku).trim()] = Number(costo);
      }
    });

    res.status(200).json({ costos, total: Object.keys(costos).length });
  } catch (err) {
    res.status(500).json({ error: 'Error al leer la planilla', detail: err.message });
  }
}
