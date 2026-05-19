export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  const SHEET_ID = '1AJRDGujWNkam2cWrH050zjTTz0Gmuo_niK_nMTTzKIM';
  const SHEET_NAME = 'PRODUCTOS';

  function normalizarTexto(value) {
    return String(value ?? '').trim();
  }

  function normalizarClave(value) {
    return String(value ?? '').trim().toLowerCase();
  }

  function tieneValorDeCosto(value) {
    return value !== null && value !== undefined && String(value).trim() !== '';
  }

  function parseCosto(value) {
    if (typeof value === 'number') return value;

    const raw = String(value ?? '')
      .replace(/\$/g, '')
      .replace(/ARS/gi, '')
      .replace(/\s/g, '')
      .trim();

    if (raw === '') return null;

    // Formato argentino frecuente: 12.500,50
    if (raw.includes(',') && raw.includes('.')) {
      return Number(raw.replace(/\./g, '').replace(',', '.'));
    }

    // Formato argentino sin decimales: 12.500
    if (raw.includes('.') && /^\d{1,3}(\.\d{3})+$/.test(raw)) {
      return Number(raw.replace(/\./g, ''));
    }

    // Formato con coma decimal: 12500,50
    if (raw.includes(',')) {
      return Number(raw.replace(',', '.'));
    }

    return Number(raw);
  }

  function getCell(row, index) {
    if (index === -1) return '';
    return row.c?.[index]?.v ?? '';
  }

  function addCosto(costos, key, costo) {
    const original = normalizarTexto(key);
    const normalizada = normalizarClave(key);

    if (!original) return;
    if (!Number.isFinite(Number(costo))) return;

    costos[original] = Number(costo);
    costos[normalizada] = Number(costo);
  }

  try {
    const cacheBuster = Date.now();
    const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json&sheet=${encodeURIComponent(SHEET_NAME)}&cb=${cacheBuster}`;

    const r = await fetch(url, {
      cache: 'no-store',
      headers: {
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
      },
    });

    const text = await r.text();
    const jsonText = text.replace(/^[^{]*/, '').replace(/[^}]*$/, '');
    const json = JSON.parse(jsonText);

    const rows = json.table?.rows || [];
    const cols = (json.table?.cols || []).map(c => String(c.label || '').trim().toUpperCase());

    const skuIdx = cols.indexOf('SKU');
    const itemIdIdx = cols.indexOf('ITEM_ID') !== -1 ? cols.indexOf('ITEM_ID') : cols.indexOf('ITEM ID');
    const costoIdx = cols.indexOf('COSTO');

    if (skuIdx === -1 && itemIdIdx === -1) {
      return res.status(400).json({
        error: 'No se encontró columna SKU ni ITEM_ID en la hoja PRODUCTOS',
        columnas_detectadas: cols,
      });
    }

    if (costoIdx === -1) {
      return res.status(400).json({
        error: 'No se encontró columna COSTO en la hoja PRODUCTOS',
        columnas_detectadas: cols,
      });
    }

    const costos = {};
    const productos_sin_costo = [];
    const filas_leidas = [];

    rows.forEach((row, index) => {
      const sku = normalizarTexto(getCell(row, skuIdx));
      const itemId = normalizarTexto(getCell(row, itemIdIdx));
      const costoRaw = getCell(row, costoIdx);
      const costoParseado = parseCosto(costoRaw);
      const costoValido = tieneValorDeCosto(costoRaw) && Number.isFinite(Number(costoParseado));

      if (!sku && !itemId) return;

      filas_leidas.push({
        fila: index + 2,
        sku,
        item_id: itemId,
        costo: costoValido ? Number(costoParseado) : null,
        costo_raw: costoRaw,
      });

      // IMPORTANTE:
      // costo 0 es válido. Solo se considera sin costo si la celda está vacía
      // o si el valor no se puede convertir a número.
      if (!costoValido) {
        productos_sin_costo.push({
          fila: index + 2,
          sku,
          item_id: itemId,
          costo_raw: costoRaw,
        });
        return;
      }

      addCosto(costos, sku, Number(costoParseado));
      addCosto(costos, itemId, Number(costoParseado));
    });

    res.status(200).json({
      costos,
      total_claves: Object.keys(costos).length,
      total_filas_leidas: filas_leidas.length,
      productos_sin_costo,
      actualizado: new Date().toISOString(),
      nota: 'Costo 0 se considera válido para productos bonificados.',
    });
  } catch (err) {
    res.status(500).json({
      error: 'Error al leer la planilla',
      detail: err.message,
    });
  }
}
