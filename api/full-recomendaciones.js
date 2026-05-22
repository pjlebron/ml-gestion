import {
  getAccountKeys,
  getAccountLabel,
  getValidToken,
  normalizeAccount,
} from './_token.js';

const ML_API = 'https://api.mercadolibre.com';
const DEFAULT_DESDE = '2026-01-01';
const DEFAULT_ACCOUNT = 'all';
const DEFAULT_DIAS_COBERTURA = 15;
const DEFAULT_MAX_UNIDADES = 30;
const DEFAULT_MIN_UNIDADES = 2;
const ITEMS_BATCH_SIZE = 20;
const MAX_OPERATIONS_DAYS = 60;
const OPERATIONS_LIMIT = 100;
const ML_DIRECT_RECOMMENDATION_LIMIT = 35;

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

function addDaysISO(dateText, days) {
  const d = new Date(`${dateText}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function subtractDaysISO(dateText, days) {
  return addDaysISO(dateText, -days);
}

function normalizarCodigo(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');
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

function diasEntre(desde, hasta) {
  const from = new Date(`${desde}T00:00:00.000Z`);
  const to = new Date(`${hasta}T00:00:00.000Z`);
  const diff = Math.ceil((to - from) / (1000 * 60 * 60 * 24)) + 1;
  return Math.max(diff, 1);
}

function clampOperationsDateRange(hasta) {
  const dateTo = hasta || todayISO();
  const dateFrom = subtractDaysISO(dateTo, MAX_OPERATIONS_DAYS - 1);
  return { date_from: dateFrom, date_to: dateTo };
}

async function fetchJson(url, req) {
  const response = await fetch(url, {
    headers: {
      cookie: req.headers.cookie || '',
    },
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok || data.error) {
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

async function fetchMlJsonSafe(url, token) {
  try {
    return await fetchMlJson(url, token);
  } catch (error) {
    return {
      __error: true,
      message: error.message,
      url,
    };
  }
}

function buildCostosMap(costosCrudos = {}) {
  const map = {};

  Object.entries(costosCrudos).forEach(([codigo, costo]) => {
    const keyOriginal = String(codigo ?? '').trim();
    const keyNormalizada = normalizarCodigo(codigo);
    const valor = num(costo);

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
        costo: num(costosMap[keyOriginal]),
        tieneCosto: true,
        codigo_usado: keyOriginal,
      };
    }

    if (keyNormalizada && Object.prototype.hasOwnProperty.call(costosMap, keyNormalizada)) {
      return {
        costo: num(costosMap[keyNormalizada]),
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

function getProductoKey({ cuentaKey, itemId, variationId, sku, producto }) {
  const id = variationId ? `${itemId || 'item'}::${variationId}` : (itemId || sku || normalizarCodigo(producto));
  return `${cuentaKey}::${id}`;
}

function extractVentaItems(venta) {
  const items = Array.isArray(venta.items) && venta.items.length
    ? venta.items
    : [{
        item_id: venta.item_id || venta.item_id_ml,
        item_id_ml: venta.item_id || venta.item_id_ml,
        variation_id: venta.variation_id || null,
        sku: venta.sku,
        producto: venta.producto,
        cantidad: venta.cantidad || 1,
        precio_total_item: venta.precio_total,
      }];

  const totalItems = items.reduce((sum, item) => sum + num(item.precio_total_item), 0) || num(venta.precio_total) || 1;

  return items.map(item => {
    const precioItem = num(item.precio_total_item) || (num(item.precio_unitario) * (num(item.cantidad) || 1));
    const proporcion = totalItems > 0 ? precioItem / totalItems : 0;

    return {
      item_id: item.item_id || item.item_id_ml || venta.item_id || venta.item_id_ml || null,
      item_id_ml: item.item_id || item.item_id_ml || venta.item_id || venta.item_id_ml || null,
      variation_id: item.variation_id || venta.variation_id || null,
      sku: item.sku || venta.sku || null,
      producto: item.producto || venta.producto || '—',
      cantidad: num(item.cantidad) || 1,
      precio_total_item: precioItem,
      proporcion,
    };
  });
}

function crearProductoBase({ key, cuentaKey, cuenta, producto, itemId, variationId, sku }) {
  return {
    key,
    cuenta_key: cuentaKey,
    cuenta,
    producto,
    item_id: itemId,
    variation_id: variationId || null,
    sku,

    ventas: 0,
    unidades_vendidas: 0,
    facturacion: 0,
    cobro_neto: 0,
    costo_total: 0,
    ganancia_pre_full: 0,
    margen_pre_full: 0,
    ticket_promedio: 0,
    velocidad_diaria: 0,

    falta_costo: false,
    costo_cero_valido: false,
    codigos_faltantes: [],

    ml: null,
    estado_full_ml: 'sin_datos_ml',
    ml_recomienda: 'sin_dato_directo',
    ml_motivo: 'Todavía no estamos leyendo un endpoint directo de recomendaciones Full; usamos señales logísticas de Mercado Libre y datos propios.',

    ml_recomendacion_directa: false,
    ml_recomendacion_directa_fuente: null,
    ml_recomendacion_directa_error: null,
    ml_recomendacion_directa_raw: null,
    ml_recomendacion_directa_endpoints: [],

    inventory_id: null,
    fulfillment_stock: null,
    stock_full_total: null,
    stock_full_disponible: null,
    stock_full_no_disponible: null,
    stock_full_no_disponible_detalle: [],
    operaciones_full: null,
    operaciones_full_resumen: null,

    recomendacion_sistema: null,
    prioridad: 0,
    unidades_sugeridas_full: 0,
    dias_cobertura: 0,
    motivo_sistema: '',
    alertas: [],
  };
}

function aggregateVentas(ventas = [], costosMap = {}, periodoDias = 1) {
  const agg = {};

  ventas.forEach(venta => {
    const cuentaKey = venta.cuenta_key || venta.account || 'lebron';
    const cuenta = venta.cuenta || getAccountLabel(cuentaKey);
    const items = extractVentaItems(venta);
    const cobroNetoVenta = num(venta.cobro_neto) || num(venta.precio_total);

    items.forEach(item => {
      const costoInfo = buscarCosto(costosMap, [
        item.sku,
        item.item_id,
        item.item_id_ml,
      ]);

      const key = getProductoKey({
        cuentaKey,
        itemId: item.item_id,
        variationId: item.variation_id,
        sku: item.sku,
        producto: item.producto,
      });

      if (!agg[key]) {
        agg[key] = crearProductoBase({
          key,
          cuentaKey,
          cuenta,
          producto: item.producto,
          itemId: item.item_id,
          variationId: item.variation_id,
          sku: item.sku,
        });
      }

      const row = agg[key];
      const costoTotal = costoInfo.tieneCosto ? costoInfo.costo * item.cantidad : 0;

      row.ventas += 1;
      row.unidades_vendidas += item.cantidad;
      row.facturacion += item.precio_total_item;
      row.cobro_neto += cobroNetoVenta * item.proporcion;
      row.costo_total += costoTotal;

      if (!costoInfo.tieneCosto) {
        row.falta_costo = true;
        row.codigos_faltantes.push({
          producto: item.producto,
          sku: item.sku || '—',
          item_id: item.item_id || '—',
          variation_id: item.variation_id || null,
        });
      }

      if (costoInfo.tieneCosto && costoInfo.costo === 0) {
        row.costo_cero_valido = true;
      }
    });
  });

  Object.values(agg).forEach(row => {
    row.facturacion = round(row.facturacion);
    row.cobro_neto = round(row.cobro_neto);
    row.costo_total = round(row.costo_total);
    row.ganancia_pre_full = round(row.cobro_neto - row.costo_total);
    row.margen_pre_full = row.facturacion > 0 ? round(row.ganancia_pre_full / row.facturacion * 100, 2) : 0;
    row.ticket_promedio = row.ventas > 0 ? round(row.facturacion / row.ventas, 2) : 0;
    row.velocidad_diaria = round(row.unidades_vendidas / periodoDias, 3);
  });

  return agg;
}

function chunkArray(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

async function fetchItemsMlForAccount({ token, itemIds }) {
  const uniqueIds = [...new Set(itemIds.filter(Boolean))];
  const result = {};

  for (const chunk of chunkArray(uniqueIds, ITEMS_BATCH_SIZE)) {
    const attributes = [
      'id',
      'title',
      'status',
      'price',
      'available_quantity',
      'sold_quantity',
      'shipping',
      'category_id',
      'permalink',
      'listing_type_id',
      'catalog_listing',
      'condition',
      'thumbnail',
      'inventory_id',
      'variations',
    ].join(',');

    const url = `${ML_API}/items?ids=${encodeURIComponent(chunk.join(','))}&attributes=${encodeURIComponent(attributes)}`;
    const data = await fetchMlJson(url, token);

    if (Array.isArray(data)) {
      data.forEach(entry => {
        if (entry?.body?.id) result[entry.body.id] = entry.body;
      });
    }
  }

  return result;
}

function getInventoryIdFromItem(itemData, variationId) {
  if (!itemData) return null;

  if (variationId && Array.isArray(itemData.variations)) {
    const variation = itemData.variations.find(v => String(v.id) === String(variationId));
    if (variation?.inventory_id) return variation.inventory_id;
  }

  return itemData.inventory_id || null;
}

function resumirOperacionesFull(operationsData) {
  if (!operationsData || operationsData.__error) {
    return {
      total_operaciones: 0,
      ventas_confirmadas: 0,
      ingresos_full: 0,
      devoluciones: 0,
      cancelaciones: 0,
      retiros: 0,
      ajustes: 0,
      bajas_perdidas_danadas: 0,
      error: operationsData?.message || null,
    };
  }

  const results = operationsData.results || [];
  const resumen = {
    total_operaciones: results.length,
    ventas_confirmadas: 0,
    ingresos_full: 0,
    devoluciones: 0,
    cancelaciones: 0,
    retiros: 0,
    ajustes: 0,
    bajas_perdidas_danadas: 0,
    error: null,
  };

  results.forEach(op => {
    const type = String(op.type || '').toLowerCase();
    const availableDelta = num(op.detail?.available_quantity);
    const notAvailableDetail = op.detail?.not_available_detail || [];

    if (type.includes('sale_confirmation')) resumen.ventas_confirmadas += Math.abs(availableDelta || 1);
    else if (type.includes('inbound_reception')) resumen.ingresos_full += Math.abs(availableDelta || 1);
    else if (type.includes('sale_return')) resumen.devoluciones += Math.abs(availableDelta || 1);
    else if (type.includes('sale_cancelation') || type.includes('sale_cancellation')) resumen.cancelaciones += Math.abs(availableDelta || 1);
    else if (type.includes('withdrawal') || type.includes('removal')) resumen.retiros += Math.abs(availableDelta || 1);
    else if (type.includes('adjust') || type.includes('ajust')) resumen.ajustes += Math.abs(availableDelta || 1);

    notAvailableDetail.forEach(detail => {
      const status = String(detail.status || '').toLowerCase();
      if (status.includes('lost') || status.includes('damage')) {
        resumen.bajas_perdidas_danadas += num(detail.quantity);
      }
    });
  });

  return resumen;
}

async function fetchFulfillmentStock({ token, inventoryId }) {
  if (!inventoryId) return null;

  const url = `${ML_API}/inventories/${encodeURIComponent(inventoryId)}/stock/fulfillment?include_attributes=conditions`;
  return fetchMlJsonSafe(url, token);
}

async function fetchFulfillmentOperations({ token, sellerId, inventoryId, hasta }) {
  if (!sellerId || !inventoryId) return null;

  const range = clampOperationsDateRange(hasta);
  const params = new URLSearchParams({
    seller_id: String(sellerId),
    inventory_id: inventoryId,
    date_from: range.date_from,
    date_to: range.date_to,
    limit: String(OPERATIONS_LIMIT),
  });

  const url = `${ML_API}/stock/fulfillment/operations/search?${params.toString()}`;
  const data = await fetchMlJsonSafe(url, token);

  return {
    ...data,
    rango_consultado: range,
  };
}

function compactJson(value, max = 700) {
  try {
    const text = JSON.stringify(value);
    if (!text) return null;
    return text.length > max ? `${text.slice(0, max)}...` : text;
  } catch {
    return null;
  }
}

function normalizeDirectRecommendationPayload(data, sourceUrl) {
  if (!data || data.__error) {
    return {
      available: false,
      fuente: sourceUrl,
      error: data?.message || 'Respuesta inválida',
      raw_resumen: null,
    };
  }

  const payload = data.body || data;
  const hasPayload = payload && typeof payload === 'object' && Object.keys(payload).length > 0;

  if (!hasPayload) {
    return {
      available: false,
      fuente: sourceUrl,
      error: 'Respuesta vacía',
      raw_resumen: null,
    };
  }

  const recommendation =
    payload.recommendation ||
    payload.recommendation_type ||
    payload.action ||
    payload.suggested_action ||
    payload.status ||
    payload.result ||
    payload.type ||
    payload.title ||
    null;

  const reason =
    payload.reason ||
    payload.message ||
    payload.description ||
    payload.detail ||
    payload.explanation ||
    payload.name ||
    null;

  const rawResumen = compactJson(payload);

  if (!recommendation && !reason) {
    return {
      available: false,
      fuente: sourceUrl,
      error: 'ML respondió, pero sin campos de recomendación reconocibles',
      raw_resumen: rawResumen,
    };
  }

  return {
    available: true,
    recomendacion: String(recommendation || 'dato_directo_ml'),
    motivo: reason
      ? String(reason)
      : 'Mercado Libre devolvió un dato directo de recomendación, pero sin explicación textual.',
    fuente: sourceUrl,
    raw_resumen: rawResumen,
    error: null,
  };
}

async function fetchMlDirectFullRecommendation({ token, sellerId, itemId, inventoryId }) {
  const urls = [];

  if (itemId) {
    urls.push(`${ML_API}/items/${encodeURIComponent(itemId)}/recommendations`);
  }

  if (sellerId && itemId) {
    urls.push(`${ML_API}/users/${encodeURIComponent(sellerId)}/items/${encodeURIComponent(itemId)}/recommendations`);
  }

  if (inventoryId) {
    urls.push(`${ML_API}/inventories/${encodeURIComponent(inventoryId)}/recommendations`);
  }

  const errors = [];

  for (const url of urls) {
    const data = await fetchMlJsonSafe(url, token);

    if (data.__error) {
      errors.push({
        url,
        error: data.message,
      });
      continue;
    }

    const normalized = normalizeDirectRecommendationPayload(data, url);

    if (normalized.available) {
      return {
        ...normalized,
        endpoints_consultados: urls,
      };
    }

    errors.push({
      url,
      error: normalized.error,
      raw_resumen: normalized.raw_resumen,
    });
  }

  return {
    available: false,
    recomendacion: 'sin_dato_directo',
    motivo: 'Mercado Libre no devolvió una recomendación directa usable por API para este producto.',
    fuente: null,
    raw_resumen: null,
    error: errors.length
      ? errors.map(e => `${e.url}: ${e.error}`).slice(0, 3).join(' | ')
      : 'No había endpoints directos para consultar',
    endpoints_consultados: urls,
  };
}

function aplicarRecomendacionDirectaMl(producto, directData) {
  producto.ml_recomendacion_directa = Boolean(directData?.available);
  producto.ml_recomendacion_directa_fuente = directData?.fuente || null;
  producto.ml_recomendacion_directa_error = directData?.error || null;
  producto.ml_recomendacion_directa_raw = directData?.raw_resumen || null;
  producto.ml_recomendacion_directa_endpoints = directData?.endpoints_consultados || [];

  if (directData?.available) {
    producto.ml_recomienda = directData.recomendacion || 'dato_directo_ml';
    producto.ml_motivo = `Recomendación directa Mercado Libre: ${directData.recomendacion || 'dato directo'}. ${directData.motivo || ''}`.trim();
    return;
  }

  producto.ml_motivo = `${producto.ml_motivo} Recomendación directa ML: no disponible por API para este producto.`;
}

async function mergeMlItems({ req, res, productos, requestedAccounts, hasta }) {
  const byAccount = {};

  productos.forEach(producto => {
    if (!producto.item_id) return;
    if (!byAccount[producto.cuenta_key]) byAccount[producto.cuenta_key] = [];
    byAccount[producto.cuenta_key].push(producto.item_id);
  });

  const mlDataByAccount = {};
  const tokenByAccount = {};

  for (const accountKey of requestedAccounts) {
    const token = await getValidToken(req, res, accountKey);
    tokenByAccount[accountKey] = token;
    const itemIds = byAccount[accountKey] || [];

    if (!token || !itemIds.length) {
      mlDataByAccount[accountKey] = {};
      continue;
    }

    try {
      mlDataByAccount[accountKey] = await fetchItemsMlForAccount({ token, itemIds });
    } catch (error) {
      mlDataByAccount[accountKey] = {};
    }
  }

  let directRecommendationRequests = 0;

  for (const producto of productos) {
    const token = tokenByAccount[producto.cuenta_key];
    const itemData = mlDataByAccount[producto.cuenta_key]?.[producto.item_id] || null;
    producto.ml = itemData;

    if (!itemData) {
      producto.estado_full_ml = 'sin_datos_ml';
      producto.ml_recomienda = 'sin_dato_directo';
      producto.ml_motivo = 'No se pudo leer la publicación en Mercado Libre.';
      continue;
    }

    const logisticType = itemData.shipping?.logistic_type || null;
    const tags = itemData.shipping?.tags || [];
    const inventoryId = getInventoryIdFromItem(itemData, producto.variation_id);
    const isFull = logisticType === 'fulfillment' || tags.includes('fulfillment') || Boolean(inventoryId);

    producto.estado_publicacion = itemData.status || null;
    producto.stock_ml = num(itemData.available_quantity);
    producto.vendidos_historicos_ml = num(itemData.sold_quantity);
    producto.precio_actual_ml = num(itemData.price);
    producto.logistic_type = logisticType;
    producto.shipping_mode = itemData.shipping?.mode || null;
    producto.free_shipping = Boolean(itemData.shipping?.free_shipping);
    producto.category_id = itemData.category_id || null;
    producto.permalink = itemData.permalink || null;
    producto.thumbnail = itemData.thumbnail || null;
    producto.inventory_id = inventoryId;

    if (inventoryId && token) {
      const [stockData, operationsData] = await Promise.all([
        fetchFulfillmentStock({ token, inventoryId }),
        fetchFulfillmentOperations({
          token,
          sellerId: token.user_id,
          inventoryId,
          hasta,
        }),
      ]);

      producto.fulfillment_stock = stockData && !stockData.__error ? stockData : null;
      producto.fulfillment_stock_error = stockData?.__error ? stockData.message : null;
      producto.operaciones_full = operationsData && !operationsData.__error ? operationsData : null;
      producto.operaciones_full_error = operationsData?.__error ? operationsData.message : null;
      producto.operaciones_full_resumen = resumirOperacionesFull(operationsData);

      if (stockData && !stockData.__error) {
        producto.stock_full_total = num(stockData.total);
        producto.stock_full_disponible = num(stockData.available_quantity);
        producto.stock_full_no_disponible = num(stockData.not_available_quantity);
        producto.stock_full_no_disponible_detalle = stockData.not_available_detail || [];
      }
    }

    if (isFull) {
      producto.estado_full_ml = 'ya_esta_en_full';
      producto.ml_recomienda = 'ya_full';
      producto.ml_motivo = inventoryId
        ? `Mercado Libre informa inventory_id ${inventoryId}. Se puede consultar stock real en Full.`
        : 'Mercado Libre informa logística fulfillment.';
    } else if (logisticType) {
      producto.estado_full_ml = 'no_full';
      producto.ml_recomienda = 'no_disponible_directo';
      producto.ml_motivo = `La publicación opera con logística ${logisticType}. El sistema evalúa si conviene enviarla a Full.`;
    } else {
      producto.estado_full_ml = 'sin_logistica';
      producto.ml_recomienda = 'sin_dato_directo';
      producto.ml_motivo = 'No se pudo leer logistic_type ni inventory_id de la publicación.';
    }

    if (token && directRecommendationRequests < ML_DIRECT_RECOMMENDATION_LIMIT) {
      directRecommendationRequests += 1;

      const directData = await fetchMlDirectFullRecommendation({
        token,
        sellerId: token.user_id,
        itemId: producto.item_id,
        inventoryId,
      });

      aplicarRecomendacionDirectaMl(producto, directData);
    } else if (directRecommendationRequests >= ML_DIRECT_RECOMMENDATION_LIMIT) {
      producto.ml_recomendacion_directa = false;
      producto.ml_recomendacion_directa_error = `No se consultó recomendación directa ML porque se alcanzó el límite interno de ${ML_DIRECT_RECOMMENDATION_LIMIT} productos por request.`;
      producto.ml_motivo = `${producto.ml_motivo} Recomendación directa ML: no consultada por límite interno.`;
    }
  }
}

function calcularUnidadesSugeridas(producto, opciones) {
  const diasCobertura = opciones.diasCobertura;
  const minUnidades = opciones.minUnidades;
  const maxUnidades = opciones.maxUnidades;
  const stockMl = num(producto.stock_ml);
  const stockFullDisponible = producto.stock_full_disponible === null || producto.stock_full_disponible === undefined
    ? null
    : num(producto.stock_full_disponible);

  let sugeridas = Math.ceil(producto.velocidad_diaria * diasCobertura);

  if (producto.recomendacion_sistema === 'Enviar a Full') {
    sugeridas = Math.max(sugeridas, minUnidades + 1);
  } else if (producto.recomendacion_sistema === 'Testear Full') {
    sugeridas = Math.max(sugeridas, minUnidades);
  } else if (producto.recomendacion_sistema === 'Reponer Full') {
    const objetivo = Math.ceil(producto.velocidad_diaria * diasCobertura);
    sugeridas = Math.max(objetivo - (stockFullDisponible || 0), 0);
  }

  sugeridas = Math.min(sugeridas, maxUnidades);

  if (stockMl > 0 && producto.estado_full_ml !== 'ya_esta_en_full') {
    sugeridas = Math.min(sugeridas, stockMl);
  }

  return Math.max(sugeridas, 0);
}

function tieneProblemasFull(producto) {
  const detalles = producto.stock_full_no_disponible_detalle || [];
  const problemStatuses = ['damaged', 'damage', 'lost', 'not_supported', 'not supportted', 'noFiscalCoverage', 'no_fiscal_coverage'];

  return detalles.some(detail => problemStatuses.includes(String(detail.status || '').trim()));
}

function estaPublicacionActiva(producto) {
  return !producto.estado_publicacion || producto.estado_publicacion === 'active';
}

function clasificarProductoFull(producto, opciones) {
  const alertas = [];

  if (producto.estado_publicacion && producto.estado_publicacion !== 'active') {
    alertas.push(`Publicación no activa: ${producto.estado_publicacion}`);
  }

  if (producto.fulfillment_stock_error) {
    alertas.push(`Error stock Full: ${producto.fulfillment_stock_error}`);
  }

  if (producto.operaciones_full_error) {
    alertas.push(`Error operaciones Full: ${producto.operaciones_full_error}`);
  }

  if (producto.stock_full_no_disponible > 0) {
    alertas.push(`${producto.stock_full_no_disponible} unidades no disponibles en Full`);
  }

  if (tieneProblemasFull(producto)) {
    alertas.push('Full reporta dañados/perdidos/no aptos');
  }

  if (producto.falta_costo) {
    producto.recomendacion_sistema = 'No enviar';
    producto.prioridad = 0;
    producto.motivo_sistema = 'Falta costo asignado. No conviene mandar a Full sin margen real.';
    producto.alertas = [...alertas, 'Falta costo'];
    producto.unidades_sugeridas_full = 0;
    return 'falta_datos';
  }

  if (!estaPublicacionActiva(producto)) {
    producto.recomendacion_sistema = 'Revisar publicación';
    producto.prioridad = round(producto.ganancia_pre_full + producto.unidades_vendidas * 300 + producto.margen_pre_full * 50, 2);
    producto.motivo_sistema = `Tiene señales comerciales, pero la publicación está ${producto.estado_publicacion}. Primero resolver estado de publicación antes de mandar o reponer Full.`;
    producto.alertas = alertas;
    producto.unidades_sugeridas_full = 0;
    return 'revisar_publicacion';
  }

  if (producto.estado_full_ml === 'ya_esta_en_full') {
    const stockDisponible = num(producto.stock_full_disponible);
    const objetivoCobertura = Math.ceil(producto.velocidad_diaria * opciones.diasCobertura);
    const ventasFull = num(producto.operaciones_full_resumen?.ventas_confirmadas);
    const necesitaReponer = objetivoCobertura > 0 && stockDisponible < objetivoCobertura;

    if (necesitaReponer && producto.margen_pre_full >= 12 && producto.unidades_vendidas > 0) {
      producto.recomendacion_sistema = 'Reponer Full';
      producto.prioridad = round(producto.ganancia_pre_full + ventasFull * 1200 + producto.margen_pre_full * 100, 2);
      producto.motivo_sistema = `Ya está en Full, pero el stock disponible (${stockDisponible}) no cubre ${opciones.diasCobertura} días estimados (${objetivoCobertura}).`;
      producto.alertas = alertas;
      producto.unidades_sugeridas_full = calcularUnidadesSugeridas(producto, opciones);
      return 'reponer_full';
    }

    producto.recomendacion_sistema = 'Ya está en Full';
    producto.prioridad = 50;
    producto.motivo_sistema = 'Ya opera en Full. Revisar stock disponible y unidades no disponibles.';
    producto.alertas = alertas;
    producto.unidades_sugeridas_full = 0;
    return 'ya_full';
  }

  if (num(producto.stock_ml) <= 0) {
    producto.recomendacion_sistema = 'No enviar';
    producto.prioridad = 0;
    producto.motivo_sistema = 'Mercado Libre informa stock disponible 0. Primero revisar publicación/stock.';
    producto.alertas = [...alertas, 'Stock ML 0'];
    producto.unidades_sugeridas_full = 0;
    return 'no_enviar';
  }

  if (producto.ventas <= 0 || producto.unidades_vendidas <= 0) {
    producto.recomendacion_sistema = 'No enviar';
    producto.prioridad = 0;
    producto.motivo_sistema = 'No tiene ventas recientes en el período analizado.';
    producto.alertas = alertas;
    producto.unidades_sugeridas_full = 0;
    return 'no_enviar';
  }

  if (producto.ganancia_pre_full <= 0 || producto.margen_pre_full < 12) {
    producto.recomendacion_sistema = 'No enviar';
    producto.prioridad = 5;
    producto.motivo_sistema = 'Margen bajo antes de Full. Si Full suma costos, puede destruir rentabilidad.';
    producto.alertas = [...alertas, 'Margen bajo'];
    producto.unidades_sugeridas_full = 0;
    return 'no_enviar';
  }

  if (producto.unidades_vendidas >= 8 && producto.margen_pre_full >= 22 && producto.velocidad_diaria >= 0.25) {
    producto.recomendacion_sistema = 'Enviar a Full';
    producto.prioridad = round(producto.ganancia_pre_full + producto.unidades_vendidas * 1000 + producto.margen_pre_full * 100, 2);
    producto.motivo_sistema = 'Alta rotación y margen sano. Buen candidato para mejorar conversión y velocidad logística con Full.';
    producto.alertas = alertas;
    producto.unidades_sugeridas_full = calcularUnidadesSugeridas(producto, opciones);
    return 'enviar_ahora';
  }

  if (producto.unidades_vendidas >= 3 && producto.margen_pre_full >= 18) {
    producto.recomendacion_sistema = 'Testear Full';
    producto.prioridad = round(producto.ganancia_pre_full + producto.unidades_vendidas * 500 + producto.margen_pre_full * 80, 2);
    producto.motivo_sistema = 'Tiene ventas y margen aceptable. Conviene probar con pocas unidades, sin mandar medio depósito a la aventura.';
    producto.alertas = alertas;
    producto.unidades_sugeridas_full = calcularUnidadesSugeridas(producto, opciones);
    return 'testear_full';
  }

  producto.recomendacion_sistema = 'No enviar';
  producto.prioridad = 10;
  producto.motivo_sistema = 'La rotación todavía no justifica ocupar stock en Full.';
  producto.alertas = alertas;
  producto.unidades_sugeridas_full = 0;
  return 'no_enviar';
}

function ordenarPorPrioridad(items = []) {
  return [...items].sort((a, b) => {
    if (b.prioridad !== a.prioridad) return b.prioridad - a.prioridad;
    if (b.unidades_vendidas !== a.unidades_vendidas) return b.unidades_vendidas - a.unidades_vendidas;
    return b.margen_pre_full - a.margen_pre_full;
  });
}

function limpiarProducto(producto) {
  return {
    cuenta: producto.cuenta,
    cuenta_key: producto.cuenta_key,
    producto: producto.producto,
    item_id: producto.item_id,
    variation_id: producto.variation_id,
    sku: producto.sku,
    permalink: producto.permalink,
    thumbnail: producto.thumbnail,

    ventas: producto.ventas,
    unidades_vendidas: producto.unidades_vendidas,
    facturacion: round(producto.facturacion),
    cobro_neto: round(producto.cobro_neto),
    costo_total: round(producto.costo_total),
    ganancia_pre_full: round(producto.ganancia_pre_full),
    margen_pre_full: producto.margen_pre_full,
    ticket_promedio: producto.ticket_promedio,
    velocidad_diaria: producto.velocidad_diaria,

    stock_ml: producto.stock_ml ?? null,
    vendidos_historicos_ml: producto.vendidos_historicos_ml ?? null,
    precio_actual_ml: producto.precio_actual_ml ?? null,
    logistic_type: producto.logistic_type || null,
    shipping_mode: producto.shipping_mode || null,
    free_shipping: producto.free_shipping ?? null,
    estado_publicacion: producto.estado_publicacion || null,

    inventory_id: producto.inventory_id,
    stock_full_total: producto.stock_full_total,
    stock_full_disponible: producto.stock_full_disponible,
    stock_full_no_disponible: producto.stock_full_no_disponible,
    stock_full_no_disponible_detalle: producto.stock_full_no_disponible_detalle || [],
    operaciones_full_resumen: producto.operaciones_full_resumen,
    fulfillment_stock_error: producto.fulfillment_stock_error || null,
    operaciones_full_error: producto.operaciones_full_error || null,

    ml_recomienda: producto.ml_recomienda,
    ml_motivo: producto.ml_motivo,
    estado_full_ml: producto.estado_full_ml,

    ml_recomendacion_directa: producto.ml_recomendacion_directa,
    ml_recomendacion_directa_fuente: producto.ml_recomendacion_directa_fuente,
    ml_recomendacion_directa_error: producto.ml_recomendacion_directa_error,
    ml_recomendacion_directa_raw: producto.ml_recomendacion_directa_raw,
    ml_recomendacion_directa_endpoints: producto.ml_recomendacion_directa_endpoints,

    recomendacion_sistema: producto.recomendacion_sistema,
    unidades_sugeridas_full: producto.unidades_sugeridas_full,
    dias_cobertura: producto.dias_cobertura,
    motivo_sistema: producto.motivo_sistema,
    prioridad: producto.prioridad,
    alertas: producto.alertas || [],

    falta_costo: producto.falta_costo,
    costo_cero_valido: producto.costo_cero_valido,
    codigos_faltantes: producto.codigos_faltantes,
  };
}

function resumenTexto({ enviarAhora, testearFull, reponerFull, revisarPublicacion, noEnviar, yaFull, faltaDatos }) {
  const partes = [];

  if (enviarAhora.length) partes.push(`${enviarAhora.length} producto${enviarAhora.length === 1 ? '' : 's'} aparecen fuertes para enviar a Full.`);
  if (testearFull.length) partes.push(`${testearFull.length} producto${testearFull.length === 1 ? '' : 's'} conviene probar con pocas unidades.`);
  if (reponerFull.length) partes.push(`${reponerFull.length} producto${reponerFull.length === 1 ? '' : 's'} ya están en Full y parecen necesitar reposición.`);
  if (revisarPublicacion.length) partes.push(`${revisarPublicacion.length} producto${revisarPublicacion.length === 1 ? '' : 's'} tienen oportunidad, pero primero hay que revisar la publicación.`);
  if (yaFull.length) partes.push(`${yaFull.length} producto${yaFull.length === 1 ? '' : 's'} ya están en Full con stock aparentemente suficiente.`);
  if (faltaDatos.length) partes.push(`${faltaDatos.length} producto${faltaDatos.length === 1 ? '' : 's'} no se pueden evaluar por falta de costo/datos.`);
  if (noEnviar.length) partes.push(`${noEnviar.length} producto${noEnviar.length === 1 ? '' : 's'} no conviene enviar todavía.`);

  return partes.join(' ') || 'No hay suficientes datos para recomendar envíos a Full.';
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  const account = req.query.account || DEFAULT_ACCOUNT;
  const desde = req.query.desde || DEFAULT_DESDE;
  const hasta = req.query.hasta || todayISO();
  const diasCobertura = Math.max(num(req.query.dias_cobertura) || DEFAULT_DIAS_COBERTURA, 1);
  const maxUnidades = Math.max(num(req.query.max_unidades) || DEFAULT_MAX_UNIDADES, 1);
  const minUnidades = Math.max(num(req.query.min_unidades) || DEFAULT_MIN_UNIDADES, 1);
  const requestedAccounts = getRequestedAccounts(account);

  try {
    const baseUrl = getBaseUrl(req);
    const periodoDias = diasEntre(desde, hasta);

    const [ventasData, costosData] = await Promise.all([
      fetchJson(`${baseUrl}/api/ventas?account=${encodeURIComponent(account)}&desde=${encodeURIComponent(desde)}&hasta=${encodeURIComponent(hasta)}`, req),
      fetchJson(`${baseUrl}/api/costos?cb=${Date.now()}`, req),
    ]);

    const costosMap = buildCostosMap(costosData.costos || {});
    const agg = aggregateVentas(ventasData.orders || [], costosMap, periodoDias);
    const productos = Object.values(agg);

    await mergeMlItems({
      req,
      res,
      productos,
      requestedAccounts,
      hasta,
    });

    const buckets = {
      enviar_ahora: [],
      testear_full: [],
      reponer_full: [],
      revisar_publicacion: [],
      no_enviar: [],
      ya_full: [],
      falta_datos: [],
    };

    const opciones = {
      diasCobertura,
      minUnidades,
      maxUnidades,
    };

    productos.forEach(producto => {
      producto.dias_cobertura = diasCobertura;
      const bucket = clasificarProductoFull(producto, opciones);
      buckets[bucket].push(producto);
    });

    const enviarAhora = ordenarPorPrioridad(buckets.enviar_ahora).map(limpiarProducto);
    const testearFull = ordenarPorPrioridad(buckets.testear_full).map(limpiarProducto);
    const reponerFull = ordenarPorPrioridad(buckets.reponer_full).map(limpiarProducto);
    const revisarPublicacion = ordenarPorPrioridad(buckets.revisar_publicacion).map(limpiarProducto);
    const noEnviar = ordenarPorPrioridad(buckets.no_enviar).map(limpiarProducto);
    const yaFull = ordenarPorPrioridad(buckets.ya_full).map(limpiarProducto);
    const faltaDatos = ordenarPorPrioridad(buckets.falta_datos).map(limpiarProducto);

    const unidadesSugeridas = enviarAhora.reduce((sum, p) => sum + num(p.unidades_sugeridas_full), 0) +
      testearFull.reduce((sum, p) => sum + num(p.unidades_sugeridas_full), 0) +
      reponerFull.reduce((sum, p) => sum + num(p.unidades_sugeridas_full), 0);

    const gananciaPotencialBase = enviarAhora.reduce((sum, p) => sum + num(p.ganancia_pre_full), 0) +
      testearFull.reduce((sum, p) => sum + num(p.ganancia_pre_full), 0) +
      reponerFull.reduce((sum, p) => sum + num(p.ganancia_pre_full), 0);

    const productosConMlDirecto = productos.filter(p => p.ml_recomendacion_directa).length;
    const productosSinMlDirecto = productos.filter(p => !p.ml_recomendacion_directa).length;
    const productosConErrorMlDirecto = productos.filter(p => p.ml_recomendacion_directa_error).length;

    res.status(200).json({
      ok: true,
      tipo: 'asistente_full',
      account,
      desde,
      hasta,
      periodo_dias: periodoDias,
      parametros: {
        dias_cobertura: diasCobertura,
        min_unidades: minUnidades,
        max_unidades: maxUnidades,
        operaciones_full_max_dias: MAX_OPERATIONS_DAYS,
        ml_direct_recommendation_limit: ML_DIRECT_RECOMMENDATION_LIMIT,
      },
      nota: 'Este módulo usa inventory_id desde /items, consulta stock real en /inventories/{inventory_id}/stock/fulfillment, operaciones recientes en /stock/fulfillment/operations/search e intenta leer recomendación directa de Mercado Libre por API. Si ML no devuelve recomendación directa usable, lo informa sin inventar datos.',
      resumen_ia: resumenTexto({
        enviarAhora,
        testearFull,
        reponerFull,
        revisarPublicacion,
        noEnviar,
        yaFull,
        faltaDatos,
      }),
      resumen: {
        productos_analizados: productos.length,
        enviar_ahora: enviarAhora.length,
        testear_full: testearFull.length,
        reponer_full: reponerFull.length,
        revisar_publicacion: revisarPublicacion.length,
        ya_full: yaFull.length,
        no_enviar: noEnviar.length,
        falta_datos: faltaDatos.length,
        unidades_sugeridas_full: unidadesSugeridas,
        ganancia_potencial_base: round(gananciaPotencialBase),
        ml_recomendaciones_directas_encontradas: productosConMlDirecto,
        ml_recomendaciones_directas_sin_dato: productosSinMlDirecto,
        ml_recomendaciones_directas_con_error: productosConErrorMlDirecto,
      },
      enviar_ahora: enviarAhora.slice(0, 50),
      testear_full: testearFull.slice(0, 50),
      reponer_full: reponerFull.slice(0, 50),
      revisar_publicacion: revisarPublicacion.slice(0, 80),
      ya_full: yaFull.slice(0, 80),
      no_enviar: noEnviar.slice(0, 100),
      falta_datos: faltaDatos.slice(0, 100),
      debug: {
        ventas_returned: ventasData.returned,
        costos_cargados: Object.keys(costosData.costos || {}).length,
        cuentas_consultadas: requestedAccounts,
        ml_direct_recommendation_limit: ML_DIRECT_RECOMMENDATION_LIMIT,
      },
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: 'Error armando recomendaciones Full',
      detail: error.message,
    });
  }
}
