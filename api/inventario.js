import {
  getAccountKeys,
  getAccountLabel,
  getValidToken,
  normalizeAccount,
} from './_token.js';

const ML_API = 'https://api.mercadolibre.com';

const DEFAULT_ACCOUNT = 'all';
const DEFAULT_DIAS = 30;
const MAX_SCROLLS_PER_STATUS = 25;
const SEARCH_LIMIT = 50;
const ITEMS_BATCH_SIZE = 20;

function num(value) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function round(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round(num(value) * factor) / factor;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function subtractDaysISO(dateText, days) {
  const d = new Date(`${dateText}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function normalizar(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');
}

function cleanText(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ');
}

function getRequestedAccounts(accountQuery) {
  if (!accountQuery || accountQuery === 'all') return getAccountKeys();
  return [normalizeAccount(accountQuery)];
}

function getBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
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

async function fetchMlJson(url, token) {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token.access_token}`,
    },
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok || data.error) {
    throw new Error(data.message || data.description || data.error || `Error HTTP ${response.status}`);
  }

  return data;
}

function chunkArray(items, size) {
  const chunks = [];

  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }

  return chunks;
}

function buildCostosMap(costosCrudos = {}) {
  const map = {};

  Object.entries(costosCrudos).forEach(([key, value]) => {
    const costo = num(value);
    const original = cleanText(key);
    const normalized = normalizar(key);

    if (!original && !normalized) return;

    if (original) map[original] = costo;
    if (normalized) map[normalized] = costo;
  });

  return map;
}

function buscarCosto(costosMap, claves = []) {
  for (const clave of claves) {
    const original = cleanText(clave);
    const normalized = normalizar(clave);

    if (original && Object.prototype.hasOwnProperty.call(costosMap, original)) {
      return {
        tiene_costo: true,
        costo_unitario: num(costosMap[original]),
        clave_usada: original,
      };
    }

    if (normalized && Object.prototype.hasOwnProperty.call(costosMap, normalized)) {
      return {
        tiene_costo: true,
        costo_unitario: num(costosMap[normalized]),
        clave_usada: normalized,
      };
    }
  }

  return {
    tiene_costo: false,
    costo_unitario: 0,
    clave_usada: null,
  };
}

function getVariationSku(variation = {}) {
  return cleanText(
    variation.seller_sku ||
    variation.seller_custom_field ||
    variation.attributes?.find?.(a => normalizar(a.id) === 'seller_sku')?.value_name ||
    variation.attributes?.find?.(a => normalizar(a.name) === 'sku')?.value_name ||
    ''
  );
}

function getItemSku(item = {}) {
  return cleanText(
    item.seller_sku ||
    item.seller_custom_field ||
    item.attributes?.find?.(a => normalizar(a.id) === 'seller_sku')?.value_name ||
    item.attributes?.find?.(a => normalizar(a.name) === 'sku')?.value_name ||
    ''
  );
}

function getVariationLabel(variation = {}) {
  const combos = variation.attribute_combinations || [];

  if (!combos.length) return '';

  return combos
    .map(a => cleanText(a.value_name || a.name || ''))
    .filter(Boolean)
    .join(' / ');
}

function getInventoryId(item = {}, variation = null) {
  if (variation?.inventory_id) return variation.inventory_id;
  if (item.inventory_id) return item.inventory_id;
  return null;
}

function isFull(item = {}, inventoryId = null) {
  const logisticType = item.shipping?.logistic_type || '';
  const tags = item.shipping?.tags || [];

  return logisticType === 'fulfillment' ||
    tags.includes('fulfillment') ||
    Boolean(inventoryId);
}

async function fetchItemIdsByStatus({ token, sellerId, status }) {
  const ids = [];
  let scrollId = null;
  let page = 0;

  while (page < MAX_SCROLLS_PER_STATUS) {
    const params = new URLSearchParams({
      search_type: 'scan',
      limit: String(SEARCH_LIMIT),
      status,
    });

    if (scrollId) params.set('scroll_id', scrollId);

    const url = `${ML_API}/users/${encodeURIComponent(sellerId)}/items/search?${params.toString()}`;
    const data = await fetchMlJson(url, token);

    const results = Array.isArray(data.results) ? data.results : [];
    ids.push(...results);

    scrollId = data.scroll_id || null;
    page += 1;

    if (!scrollId || results.length === 0) break;
  }

  return ids;
}

async function fetchAccountItemIds({ token }) {
  const sellerId = token.user_id;

  const statuses = ['active', 'paused'];
  const byStatus = {};
  const allIds = [];

  for (const status of statuses) {
    try {
      const ids = await fetchItemIdsByStatus({ token, sellerId, status });
      byStatus[status] = ids;
      allIds.push(...ids);
    } catch (error) {
      byStatus[status] = [];
    }
  }

  return {
    ids: [...new Set(allIds)],
    byStatus,
  };
}

async function fetchItemsDetails({ token, itemIds }) {
  const uniqueIds = [...new Set(itemIds.filter(Boolean))];
  const result = {};

  const attributes = [
    'id',
    'title',
    'status',
    'price',
    'base_price',
    'original_price',
    'available_quantity',
    'sold_quantity',
    'seller_custom_field',
    'seller_sku',
    'permalink',
    'thumbnail',
    'shipping',
    'inventory_id',
    'variations',
    'attributes',
    'listing_type_id',
    'catalog_listing',
    'condition',
    'category_id',
  ].join(',');

  for (const chunk of chunkArray(uniqueIds, ITEMS_BATCH_SIZE)) {
    const url = `${ML_API}/items?ids=${encodeURIComponent(chunk.join(','))}&attributes=${encodeURIComponent(attributes)}`;
    const data = await fetchMlJson(url, token);

    if (Array.isArray(data)) {
      data.forEach(entry => {
        if (entry?.body?.id) {
          result[entry.body.id] = entry.body;
        }
      });
    }
  }

  return result;
}

function getProductoKey({ cuentaKey, itemId, variationId, sku }) {
  if (sku) return `${cuentaKey}::sku::${normalizar(sku)}`;
  if (variationId) return `${cuentaKey}::variation::${itemId}::${variationId}`;
  return `${cuentaKey}::item::${itemId}`;
}

function getSkuMaestro({ sku, itemId, variationId }) {
  if (sku) return cleanText(sku);
  if (variationId) return `SIN-SKU-${itemId}-${variationId}`;
  return `SIN-SKU-${itemId}`;
}

function normalizeItemRows({ cuentaKey, cuenta, item, costosMap }) {
  const variations = Array.isArray(item.variations) ? item.variations : [];

  if (variations.length) {
    return variations.map(variation => {
      const sku = getVariationSku(variation) || getItemSku(item);
      const variationId = variation.id || null;
      const stock = num(variation.available_quantity);
      const price = num(variation.price || item.price);
      const inventoryId = getInventoryId(item, variation);
      const costo = buscarCosto(costosMap, [
        sku,
        variationId,
        item.id,
      ]);

      const label = getVariationLabel(variation);
      const producto = label ? `${item.title} - ${label}` : item.title;

      return buildInventarioRow({
        cuentaKey,
        cuenta,
        item,
        producto,
        sku,
        variationId,
        stock,
        price,
        inventoryId,
        costo,
      });
    });
  }

  const sku = getItemSku(item);
  const stock = num(item.available_quantity);
  const price = num(item.price);
  const inventoryId = getInventoryId(item, null);
  const costo = buscarCosto(costosMap, [
    sku,
    item.id,
  ]);

  return [
    buildInventarioRow({
      cuentaKey,
      cuenta,
      item,
      producto: item.title,
      sku,
      variationId: null,
      stock,
      price,
      inventoryId,
      costo,
    }),
  ];
}

function buildInventarioRow({
  cuentaKey,
  cuenta,
  item,
  producto,
  sku,
  variationId,
  stock,
  price,
  inventoryId,
  costo,
}) {
  const skuMaestro = getSkuMaestro({
    sku,
    itemId: item.id,
    variationId,
  });

  const costoUnitario = costo.tiene_costo ? costo.costo_unitario : 0;
  const valorCosto = stock * costoUnitario;
  const valorVentaActual = stock * price;

  return {
    key: getProductoKey({
      cuentaKey,
      itemId: item.id,
      variationId,
      sku,
    }),
    cuenta_key: cuentaKey,
    cuenta,
    producto: cleanText(producto || item.title),
    sku: sku || '',
    sku_maestro: skuMaestro,
    item_id: item.id,
    variation_id: variationId,
    status: item.status || 'unknown',
    precio_actual: round(price),
    stock_publicado: stock,
    sold_quantity_ml: num(item.sold_quantity),
    logistic_type: item.shipping?.logistic_type || null,
    shipping_mode: item.shipping?.mode || null,
    free_shipping: Boolean(item.shipping?.free_shipping),
    inventory_id: inventoryId,
    es_full: isFull(item, inventoryId),
    permalink: item.permalink || null,
    thumbnail: item.thumbnail || null,
    listing_type_id: item.listing_type_id || null,
    catalog_listing: Boolean(item.catalog_listing),
    condition: item.condition || null,
    category_id: item.category_id || null,

    tiene_costo: costo.tiene_costo,
    costo_unitario: round(costoUnitario),
    costo_clave_usada: costo.clave_usada,
    valor_stock_costo: round(valorCosto),
    valor_stock_venta_actual: round(valorVentaActual),
    ganancia_potencial_actual: round(valorVentaActual - valorCosto),
    margen_potencial_actual: valorVentaActual > 0
      ? round((valorVentaActual - valorCosto) / valorVentaActual * 100, 2)
      : 0,

    ventas_30d_unidades: 0,
    ventas_30d_facturacion: 0,
    precio_promedio_vendido: 0,
    valor_stock_venta_promedio: 0,
    ganancia_potencial_promedio: 0,
    dias_cobertura: null,

    alertas: [],
    recomendacion: 'Mantener',
  };
}

function extractVentaItems(venta) {
  const rawItems = Array.isArray(venta.items) && venta.items.length
    ? venta.items
    : [{
        item_id: venta.item_id || venta.item_id_ml,
        variation_id: venta.variation_id || null,
        sku: venta.sku,
        producto: venta.producto,
        cantidad: venta.cantidad || 1,
        precio_total_item: venta.precio_total,
      }];

  return rawItems.map(item => {
    const cantidad = num(item.cantidad) || 1;
    const precioTotal = num(item.precio_total_item) || num(item.precio_total) || num(item.precio_unitario) * cantidad;

    return {
      cuenta_key: venta.cuenta_key || venta.account || 'lebron',
      item_id: item.item_id || item.item_id_ml || venta.item_id || venta.item_id_ml || null,
      variation_id: item.variation_id || venta.variation_id || null,
      sku: item.sku || venta.sku || '',
      cantidad,
      precio_total: precioTotal,
    };
  });
}

function buildVentasStats(ventas = []) {
  const stats = new Map();

  const add = (key, item) => {
    if (!key) return;

    const row = stats.get(key) || {
      unidades: 0,
      facturacion: 0,
    };

    row.unidades += item.cantidad;
    row.facturacion += item.precio_total;

    stats.set(key, row);
  };

  ventas.forEach(venta => {
    const items = extractVentaItems(venta);

    items.forEach(item => {
      const cuentaKey = item.cuenta_key;
      const skuNorm = normalizar(item.sku);

      add(`${cuentaKey}::item::${item.item_id}`, item);
      add(`${cuentaKey}::variation::${item.item_id}::${item.variation_id}`, item);

      if (skuNorm) {
        add(`${cuentaKey}::sku::${skuNorm}`, item);
        add(`sku::${skuNorm}`, item);
      }

      if (item.item_id) {
        add(`item::${item.item_id}`, item);
      }
    });
  });

  return stats;
}

function applyVentasStats(productos, ventasStats, dias) {
  productos.forEach(p => {
    const keys = [
      p.key,
      p.sku ? `${p.cuenta_key}::sku::${normalizar(p.sku)}` : null,
      p.variation_id ? `${p.cuenta_key}::variation::${p.item_id}::${p.variation_id}` : null,
      `${p.cuenta_key}::item::${p.item_id}`,
      p.sku ? `sku::${normalizar(p.sku)}` : null,
      `item::${p.item_id}`,
    ].filter(Boolean);

    let stat = null;

    for (const key of keys) {
      if (ventasStats.has(key)) {
        stat = ventasStats.get(key);
        break;
      }
    }

    if (!stat) return;

    p.ventas_30d_unidades = round(stat.unidades);
    p.ventas_30d_facturacion = round(stat.facturacion);
    p.precio_promedio_vendido = stat.unidades > 0 ? round(stat.facturacion / stat.unidades) : 0;

    const precioValorizacion = p.precio_promedio_vendido || p.precio_actual;
    p.valor_stock_venta_promedio = round(p.stock_publicado * precioValorizacion);
    p.ganancia_potencial_promedio = round(p.valor_stock_venta_promedio - p.valor_stock_costo);

    const velocidadDiaria = stat.unidades / Math.max(dias, 1);
    p.dias_cobertura = velocidadDiaria > 0
      ? round(p.stock_publicado / velocidadDiaria, 1)
      : null;
  });
}

function clasificarProducto(p) {
  const alertas = [];

  if (!p.sku) alertas.push('Sin SKU');
  if (!p.tiene_costo) alertas.push('Sin costo cargado');
  if (p.status === 'active' && p.stock_publicado <= 0) alertas.push('Activo sin stock');
  if (p.status === 'paused' && p.stock_publicado > 0) alertas.push('Pausado con stock');
  if (p.stock_publicado > 0 && p.stock_publicado <= 2 && p.ventas_30d_unidades >= 2) alertas.push('Stock crítico');
  if (p.stock_publicado >= 10 && p.ventas_30d_unidades <= 1) alertas.push('Stock lento');
  if (p.es_full) alertas.push('Full');

  let recomendacion = 'Mantener';

  if (!p.tiene_costo) {
    recomendacion = 'Cargar costo';
  } else if (p.status === 'active' && p.stock_publicado <= 0) {
    recomendacion = 'Revisar stock';
  } else if (p.stock_publicado > 0 && p.stock_publicado <= 2 && p.ventas_30d_unidades >= 2) {
    recomendacion = 'Reponer';
  } else if (p.stock_publicado >= 10 && p.ventas_30d_unidades <= 1) {
    recomendacion = 'Liquidar / combo';
  } else if (p.status === 'paused' && p.stock_publicado > 0) {
    recomendacion = 'Reactivar o mover stock';
  }

  p.alertas = alertas;
  p.recomendacion = recomendacion;
}

function buildResumen(productos = []) {
  const activos = productos.filter(p => p.status === 'active');
  const pausados = productos.filter(p => p.status === 'paused');
  const conStock = productos.filter(p => p.stock_publicado > 0);

  const valorCosto = productos.reduce((sum, p) => sum + p.valor_stock_costo, 0);
  const valorVentaActual = productos.reduce((sum, p) => sum + p.valor_stock_venta_actual, 0);
  const valorVentaPromedio = productos.reduce((sum, p) => sum + (p.valor_stock_venta_promedio || p.valor_stock_venta_actual), 0);

  return {
    productos: productos.length,
    publicaciones_activas: activos.length,
    publicaciones_pausadas: pausados.length,
    unidades_publicadas: productos.reduce((sum, p) => sum + p.stock_publicado, 0),
    unidades_con_stock: conStock.reduce((sum, p) => sum + p.stock_publicado, 0),
    valor_stock_costo: round(valorCosto),
    valor_stock_venta_actual: round(valorVentaActual),
    valor_stock_venta_promedio: round(valorVentaPromedio),
    ganancia_potencial_actual: round(valorVentaActual - valorCosto),
    ganancia_potencial_promedio: round(valorVentaPromedio - valorCosto),
    productos_sin_costo: productos.filter(p => !p.tiene_costo).length,
    productos_sin_sku: productos.filter(p => !p.sku).length,
    productos_stock_cero: productos.filter(p => p.stock_publicado <= 0).length,
    productos_stock_critico: productos.filter(p => p.alertas.includes('Stock crítico')).length,
    productos_stock_lento: productos.filter(p => p.alertas.includes('Stock lento')).length,
    productos_full: productos.filter(p => p.es_full).length,
  };
}

function groupByCuenta(productos = []) {
  const map = new Map();

  productos.forEach(p => {
    const key = p.cuenta_key;
    const row = map.get(key) || {
      cuenta_key: key,
      cuenta: p.cuenta,
      productos: 0,
      unidades: 0,
      valor_costo: 0,
      valor_venta_actual: 0,
      valor_venta_promedio: 0,
      ganancia_potencial: 0,
      sin_costo: 0,
      stock_critico: 0,
      stock_lento: 0,
    };

    row.productos += 1;
    row.unidades += p.stock_publicado;
    row.valor_costo += p.valor_stock_costo;
    row.valor_venta_actual += p.valor_stock_venta_actual;
    row.valor_venta_promedio += p.valor_stock_venta_promedio || p.valor_stock_venta_actual;
    row.ganancia_potencial += p.ganancia_potencial_promedio || p.ganancia_potencial_actual;
    if (!p.tiene_costo) row.sin_costo += 1;
    if (p.alertas.includes('Stock crítico')) row.stock_critico += 1;
    if (p.alertas.includes('Stock lento')) row.stock_lento += 1;

    map.set(key, row);
  });

  return [...map.values()].map(row => ({
    ...row,
    valor_costo: round(row.valor_costo),
    valor_venta_actual: round(row.valor_venta_actual),
    valor_venta_promedio: round(row.valor_venta_promedio),
    ganancia_potencial: round(row.ganancia_potencial),
  }));
}

function groupBySkuMaestro(productos = []) {
  const map = new Map();

  productos.forEach(p => {
    const key = p.sku_maestro || `SIN-SKU-${p.item_id}`;
    const row = map.get(key) || {
      sku_maestro: key,
      producto_referencia: p.producto,
      productos: 0,
      cuentas: new Set(),
      unidades_publicadas: 0,
      valor_costo: 0,
      valor_venta_actual: 0,
      valor_venta_promedio: 0,
      ganancia_potencial: 0,
      stock_full: 0,
      stock_no_full: 0,
      publicaciones: [],
      alertas: new Set(),
    };

    row.productos += 1;
    row.cuentas.add(p.cuenta);
    row.unidades_publicadas += p.stock_publicado;
    row.valor_costo += p.valor_stock_costo;
    row.valor_venta_actual += p.valor_stock_venta_actual;
    row.valor_venta_promedio += p.valor_stock_venta_promedio || p.valor_stock_venta_actual;
    row.ganancia_potencial += p.ganancia_potencial_promedio || p.ganancia_potencial_actual;

    if (p.es_full) row.stock_full += p.stock_publicado;
    else row.stock_no_full += p.stock_publicado;

    p.alertas.forEach(a => row.alertas.add(a));

    row.publicaciones.push({
      cuenta: p.cuenta,
      cuenta_key: p.cuenta_key,
      item_id: p.item_id,
      variation_id: p.variation_id,
      stock_publicado: p.stock_publicado,
      precio_actual: p.precio_actual,
      status: p.status,
      es_full: p.es_full,
      permalink: p.permalink,
    });

    map.set(key, row);
  });

  return [...map.values()]
    .map(row => ({
      ...row,
      cuentas: [...row.cuentas],
      alertas: [...row.alertas],
      valor_costo: round(row.valor_costo),
      valor_venta_actual: round(row.valor_venta_actual),
      valor_venta_promedio: round(row.valor_venta_promedio),
      ganancia_potencial: round(row.ganancia_potencial),
    }))
    .sort((a, b) => b.valor_costo - a.valor_costo);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  const account = req.query.account || DEFAULT_ACCOUNT;
  const dias = Math.max(1, Math.min(180, Math.trunc(num(req.query.dias) || DEFAULT_DIAS)));
  const hasta = req.query.hasta || todayISO();
  const desde = req.query.desde || subtractDaysISO(hasta, dias - 1);
  const requestedAccounts = getRequestedAccounts(account);

  try {
    const baseUrl = getBaseUrl(req);

    const [costosData, ventasData] = await Promise.all([
      fetchInternalJson(`${baseUrl}/api/costos?cb=${Date.now()}`, req),
      fetchInternalJson(`${baseUrl}/api/ventas?account=${encodeURIComponent(account)}&desde=${encodeURIComponent(desde)}&hasta=${encodeURIComponent(hasta)}&cb=${Date.now()}`, req)
        .catch(error => ({
          orders: [],
          warning: error.message,
        })),
    ]);

    const costosMap = buildCostosMap(costosData.costos || {});
    const ventasStats = buildVentasStats(ventasData.orders || []);

    const productos = [];
    const cuentas = [];
    const errores = [];

    for (const accountKey of requestedAccounts) {
      const cuenta = getAccountLabel(accountKey);
      const token = await getValidToken(req, res, accountKey);

      if (!token) {
        errores.push({
          cuenta_key: accountKey,
          cuenta,
          error: 'Cuenta no conectada o token inválido',
        });
        continue;
      }

      try {
        const itemSearch = await fetchAccountItemIds({ token });
        const itemDetails = await fetchItemsDetails({
          token,
          itemIds: itemSearch.ids,
        });

        const accountRows = Object.values(itemDetails)
          .flatMap(item => normalizeItemRows({
            cuentaKey: accountKey,
            cuenta,
            item,
            costosMap,
          }));

        productos.push(...accountRows);

        cuentas.push({
          cuenta_key: accountKey,
          cuenta,
          user_id: token.user_id,
          item_ids: itemSearch.ids.length,
          publicaciones_normalizadas: accountRows.length,
          activas: itemSearch.byStatus.active?.length || 0,
          pausadas: itemSearch.byStatus.paused?.length || 0,
        });
      } catch (error) {
        errores.push({
          cuenta_key: accountKey,
          cuenta,
          error: error.message,
        });
      }
    }

    applyVentasStats(productos, ventasStats, dias);
    productos.forEach(clasificarProducto);

    const productosOrdenados = productos.sort((a, b) => {
      if (!a.tiene_costo && b.tiene_costo) return -1;
      if (a.tiene_costo && !b.tiene_costo) return 1;
      return b.valor_stock_costo - a.valor_stock_costo;
    });

    const resumen = buildResumen(productosOrdenados);
    const porCuenta = groupByCuenta(productosOrdenados);
    const porSkuMaestro = groupBySkuMaestro(productosOrdenados);

    res.status(200).json({
      ok: true,
      tipo: 'inventario_valorizado_ml',
      account,
      desde,
      hasta,
      dias,
      generado_en: new Date().toISOString(),
      nota: 'Este módulo mide stock publicado en Mercado Libre. Todavía no representa stock físico real de depósito. Es el primer paso para construir multidepósito.',
      resumen,
      cuentas,
      por_cuenta: porCuenta,
      por_sku_maestro: porSkuMaestro,
      productos: productosOrdenados,
      alertas: {
        sin_costo: productosOrdenados.filter(p => !p.tiene_costo),
        sin_sku: productosOrdenados.filter(p => !p.sku),
        stock_critico: productosOrdenados.filter(p => p.alertas.includes('Stock crítico')),
        stock_lento: productosOrdenados.filter(p => p.alertas.includes('Stock lento')),
        activos_sin_stock: productosOrdenados.filter(p => p.status === 'active' && p.stock_publicado <= 0),
        pausados_con_stock: productosOrdenados.filter(p => p.status === 'paused' && p.stock_publicado > 0),
      },
      errores,
      debug: {
        costos_claves: Object.keys(costosData.costos || {}).length,
        ventas_leidas: ventasData.orders?.length || 0,
        ventas_warning: ventasData.warning || null,
      },
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: 'Error armando inventario valorizado',
      detail: error.message,
    });
  }
}
