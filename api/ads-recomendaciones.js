const DEFAULT_DESDE = '2026-01-01';
const DEFAULT_ACCOUNT = 'all';

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

function normalizarCodigo(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');
}

function getBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
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

function buildLocalidadesMap(localidadesData = {}) {
  const rows = Array.isArray(localidadesData.localidades_activas)
    ? localidadesData.localidades_activas
    : Array.isArray(localidadesData.localidades)
      ? localidadesData.localidades.filter(l => l.activo !== false)
      : [];

  const byLocalidad = {};
  const byPartido = {};

  rows.forEach(row => {
    const localidad = row.localidad || row.nombre || '';
    const partido = row.partido || '';
    const tarifa = num(row.tarifa);

    const localidadKey = normalizarCodigo(localidad);
    const partidoKey = normalizarCodigo(partido);

    if (localidadKey) byLocalidad[localidadKey] = tarifa;
    if (partidoKey && !Object.prototype.hasOwnProperty.call(byPartido, partidoKey)) {
      byPartido[partidoKey] = tarifa;
    }
  });

  return {
    rows,
    byLocalidad,
    byPartido,
  };
}

function getMensajeriaFlex(localidadesMap, venta) {
  if (!venta?.es_flex) return 0;

  const localidadKey = normalizarCodigo(venta.localidad);
  const partidoKey = normalizarCodigo(venta.partido);

  if (localidadKey && Object.prototype.hasOwnProperty.call(localidadesMap.byLocalidad, localidadKey)) {
    return num(localidadesMap.byLocalidad[localidadKey]);
  }

  if (partidoKey && Object.prototype.hasOwnProperty.call(localidadesMap.byPartido, partidoKey)) {
    return num(localidadesMap.byPartido[partidoKey]);
  }

  return 0;
}

function accountPrefix(cuentaKey) {
  if (cuentaKey === 'fragantify') return 'FRA';
  return 'LS';
}

function getProductoKey({ cuentaKey, itemId, sku, producto }) {
  const id = itemId || sku || normalizarCodigo(producto);
  return `${cuentaKey}::${id}`;
}

function extractVentaItems(venta) {
  const items = Array.isArray(venta.items) && venta.items.length
    ? venta.items
    : [{
        item_id: venta.item_id || venta.item_id_ml,
        item_id_ml: venta.item_id || venta.item_id_ml,
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
      sku: item.sku || venta.sku || null,
      producto: item.producto || venta.producto || '—',
      cantidad: num(item.cantidad) || 1,
      precio_total_item: precioItem,
      proporcion,
    };
  });
}

function addToAggregate(agg, key, patch) {
  if (!agg[key]) {
    agg[key] = {
      key,
      cuenta_key: patch.cuenta_key,
      cuenta: patch.cuenta,
      producto: patch.producto,
      item_id: patch.item_id,
      sku: patch.sku,
      ventas: 0,
      unidades: 0,
      facturacion: 0,
      cobro_neto: 0,
      costo_total: 0,
      mensajeria_total: 0,
      ganancia_pre_ads: 0,
      margen_pre_ads: 0,
      falta_costo: false,
      falta_mensajeria_flex: false,
      costo_cero_valido: false,
      codigos_faltantes: [],
      localidades_faltantes: [],
      ads_gasto: 0,
      ads_ingresos: 0,
      ads_clicks: 0,
      ads_impresiones: 0,
      ads_roas: 0,
      ads_acos: 0,
      ads_ctr: 0,
      ads_cpc: 0,
      recomendacion: null,
      campania_sugerida: null,
      roas_objetivo_sugerido: null,
      acos_maximo_sugerido: null,
      presupuesto_sugerido: 0,
      motivo: '',
    };
  }

  return agg[key];
}

function aggregateVentas(ventas = [], costosMap = {}, localidadesMap = { byLocalidad: {}, byPartido: {}, rows: [] }) {
  const agg = {};

  ventas.forEach(venta => {
    const cuentaKey = venta.cuenta_key || venta.account || 'lebron';
    const cuenta = venta.cuenta || (cuentaKey === 'fragantify' ? 'Fragantify' : 'Lebron Store');
    const items = extractVentaItems(venta);
    const cobroNetoVenta = num(venta.cobro_neto) || num(venta.precio_total);
    const mensajeriaVenta = getMensajeriaFlex(localidadesMap, venta);
    const esFlexSinTarifa = !!venta.es_flex && mensajeriaVenta === 0;

    items.forEach(item => {
      const costoInfo = buscarCosto(costosMap, [
        item.sku,
        item.item_id,
        item.item_id_ml,
      ]);

      const costoUnitario = costoInfo.costo;
      const costoTotal = costoInfo.tieneCosto ? costoUnitario * item.cantidad : 0;
      const mensajeriaItem = mensajeriaVenta * item.proporcion;

      const key = getProductoKey({
        cuentaKey,
        itemId: item.item_id,
        sku: item.sku,
        producto: item.producto,
      });

      const row = addToAggregate(agg, key, {
        cuenta_key: cuentaKey,
        cuenta,
        producto: item.producto,
        item_id: item.item_id,
        sku: item.sku,
      });

      row.ventas += 1;
      row.unidades += item.cantidad;
      row.facturacion += item.precio_total_item;
      row.cobro_neto += cobroNetoVenta * item.proporcion;
      row.costo_total += costoTotal;
      row.mensajeria_total += mensajeriaItem;

      if (!costoInfo.tieneCosto) {
        row.falta_costo = true;
        row.codigos_faltantes.push({
          producto: item.producto,
          sku: item.sku || '—',
          item_id: item.item_id || '—',
        });
      }

      if (costoInfo.tieneCosto && costoInfo.costo === 0) {
        row.costo_cero_valido = true;
      }

      if (esFlexSinTarifa) {
        row.falta_mensajeria_flex = true;
        row.localidades_faltantes.push({
          producto: item.producto,
          localidad: venta.localidad || '—',
          partido: venta.partido || '—',
        });
      }
    });
  });

  Object.values(agg).forEach(row => {
    row.facturacion = round(row.facturacion);
    row.cobro_neto = round(row.cobro_neto);
    row.costo_total = round(row.costo_total);
    row.mensajeria_total = round(row.mensajeria_total);
    row.ganancia_pre_ads = round(row.cobro_neto - row.costo_total - row.mensajeria_total);
    row.margen_pre_ads = row.facturacion > 0 ? round(row.ganancia_pre_ads / row.facturacion * 100, 2) : 0;
  });

  return agg;
}

function mergeAds(agg, adsItems = []) {
  adsItems.forEach(ad => {
    const cuentaKey = ad.cuenta_key || ad.account || 'lebron';
    const key = getProductoKey({
      cuentaKey,
      itemId: ad.item_id,
      sku: null,
      producto: ad.titulo,
    });

    const row = addToAggregate(agg, key, {
      cuenta_key: cuentaKey,
      cuenta: ad.cuenta || (cuentaKey === 'fragantify' ? 'Fragantify' : 'Lebron Store'),
      producto: ad.titulo || ad.item_id || '—',
      item_id: ad.item_id,
      sku: null,
    });

    row.ads_gasto += num(ad.gasto);
    row.ads_ingresos += num(ad.ingresos);
    row.ads_clicks += num(ad.clicks);
    row.ads_impresiones += num(ad.impresiones || ad.prints);
  });

  Object.values(agg).forEach(row => {
    row.ads_gasto = round(row.ads_gasto);
    row.ads_ingresos = round(row.ads_ingresos);
    row.ads_roas = row.ads_gasto > 0 ? round(row.ads_ingresos / row.ads_gasto, 2) : 0;
    row.ads_acos = row.ads_ingresos > 0 ? round(row.ads_gasto / row.ads_ingresos * 100, 2) : 0;
    row.ads_ctr = row.ads_impresiones > 0 ? round(row.ads_clicks / row.ads_impresiones * 100, 2) : 0;
    row.ads_cpc = row.ads_clicks > 0 ? round(row.ads_gasto / row.ads_clicks, 2) : 0;
  });
}

function sugerirRoasYPresupuesto(row) {
  const margenDecimal = row.margen_pre_ads / 100;
  const colchon = 0.08;
  const acosMax = margenDecimal - colchon;

  if (acosMax <= 0) {
    return {
      acos_maximo_sugerido: 0,
      roas_objetivo_sugerido: null,
      presupuesto_sugerido: 0,
    };
  }

  const roasObjetivo = 1 / acosMax;

  let presupuesto = 1000;
  if (row.ventas >= 8 && row.margen_pre_ads >= 25) presupuesto = 4000;
  else if (row.ventas >= 4 && row.margen_pre_ads >= 20) presupuesto = 2500;
  else if (row.ventas >= 1 && row.margen_pre_ads >= 15) presupuesto = 1500;

  if (row.ads_roas >= 4 && row.ads_gasto > 0) presupuesto = Math.max(presupuesto, 3000);
  if (row.ads_gasto > 0 && row.ads_ingresos === 0) presupuesto = 0;

  return {
    acos_maximo_sugerido: round(acosMax * 100, 2),
    roas_objetivo_sugerido: round(Math.max(roasObjetivo, 2.5), 2),
    presupuesto_sugerido: presupuesto,
  };
}

function clasificarProducto(row) {
  const sugerencia = sugerirRoasYPresupuesto(row);

  row.acos_maximo_sugerido = sugerencia.acos_maximo_sugerido;
  row.roas_objetivo_sugerido = sugerencia.roas_objetivo_sugerido;
  row.presupuesto_sugerido = sugerencia.presupuesto_sugerido;

  if (row.falta_costo) {
    row.recomendacion = 'No anunciar';
    row.campania_sugerida = 'Bloqueados';
    row.motivo = 'Falta costo asignado. Primero cargar costo en la planilla.';
    return 'bloqueados';
  }

  if (row.falta_mensajeria_flex) {
    row.recomendacion = 'Revisar';
    row.campania_sugerida = 'Revisar mensajería Flex';
    row.motivo = 'Tiene ventas Flex sin tarifa de mensajería cargada en Supabase. Corregir localidad/partido antes de invertir.';
    return 'revisar';
  }

  if (row.facturacion <= 0 || row.ventas <= 0) {
    row.recomendacion = 'No anunciar';
    row.campania_sugerida = 'Sin ventas recientes';
    row.motivo = 'No tiene ventas recientes para validar demanda.';
    return 'bloqueados';
  }

  if (row.ganancia_pre_ads <= 0 || row.margen_pre_ads < 10) {
    row.recomendacion = 'No anunciar';
    row.campania_sugerida = 'Margen insuficiente';
    row.motivo = 'Margen bajo o ganancia negativa antes de publicidad, descontando costo y mensajería Flex.';
    return 'bloqueados';
  }

  if (row.ads_gasto > 0 && row.ads_ingresos === 0) {
    row.recomendacion = 'Revisar';
    row.campania_sugerida = 'Revisión Ads';
    row.motivo = 'Tuvo gasto publicitario y no generó ingresos atribuidos.';
    return 'revisar';
  }

  if (row.ads_gasto > 0 && row.ads_roas > 0 && row.roas_objetivo_sugerido && row.ads_roas < row.roas_objetivo_sugerido) {
    row.recomendacion = 'Revisar';
    row.campania_sugerida = 'Revisión Ads';
    row.motivo = `ROAS histórico ${row.ads_roas}x por debajo del ROAS sugerido ${row.roas_objetivo_sugerido}x.`;
    return 'revisar';
  }

  if (row.ventas >= 3 && row.margen_pre_ads >= 22 && (row.ads_gasto === 0 || row.ads_roas >= 3.5)) {
    row.recomendacion = 'Escalar';
    row.campania_sugerida = `${accountPrefix(row.cuenta_key)} – Top Rentables`;
    row.motivo = 'Tiene ventas, margen sano y condiciones para invertir con control.';
    return 'escalar';
  }

  if (row.ventas >= 1 && row.margen_pre_ads >= 15) {
    row.recomendacion = 'Testear';
    row.campania_sugerida = `${accountPrefix(row.cuenta_key)} – Testeo Controlado`;
    row.motivo = 'Tiene margen aceptable, pero necesita validación con presupuesto chico.';
    return 'testear';
  }

  row.recomendacion = 'Revisar';
  row.campania_sugerida = 'Revisión Comercial';
  row.motivo = 'No cumple todavía criterios claros para escalar o testear.';
  return 'revisar';
}

function sortByPriority(items = []) {
  return [...items].sort((a, b) => {
    if (b.ganancia_pre_ads !== a.ganancia_pre_ads) return b.ganancia_pre_ads - a.ganancia_pre_ads;
    if (b.ventas !== a.ventas) return b.ventas - a.ventas;
    return b.margen_pre_ads - a.margen_pre_ads;
  });
}

function armarCampanias(productosEscalar = [], productosTestear = []) {
  const grupos = {};

  function add(producto, tipo) {
    const nombre = producto.campania_sugerida;

    if (!grupos[nombre]) {
      grupos[nombre] = {
        campania: nombre,
        cuenta: producto.cuenta,
        cuenta_key: producto.cuenta_key,
        objetivo: tipo === 'escalar' ? 'Rentabilidad y crecimiento controlado' : 'Validar demanda con bajo riesgo',
        productos: [],
        cantidad_productos: 0,
        roas_objetivo: 0,
        acos_maximo: 0,
        presupuesto_diario_sugerido: 0,
        accion: tipo === 'escalar' ? 'Crear o reforzar campaña' : 'Crear campaña de testeo',
      };
    }

    grupos[nombre].productos.push({
      producto: producto.producto,
      item_id: producto.item_id,
      sku: producto.sku,
      ventas: producto.ventas,
      margen_pre_ads: producto.margen_pre_ads,
      ganancia_pre_ads: producto.ganancia_pre_ads,
      mensajeria_total: producto.mensajeria_total,
      roas_objetivo_sugerido: producto.roas_objetivo_sugerido,
      presupuesto_sugerido: producto.presupuesto_sugerido,
    });
  }

  productosEscalar.slice(0, 12).forEach(producto => add(producto, 'escalar'));
  productosTestear.slice(0, 12).forEach(producto => add(producto, 'testear'));

  Object.values(grupos).forEach(grupo => {
    grupo.cantidad_productos = grupo.productos.length;
    grupo.roas_objetivo = round(
      grupo.productos.reduce((sum, p) => sum + num(p.roas_objetivo_sugerido), 0) / Math.max(grupo.productos.length, 1),
      2
    );
    grupo.acos_maximo = grupo.roas_objetivo > 0 ? round(100 / grupo.roas_objetivo, 2) : 0;
    grupo.presupuesto_diario_sugerido = Math.min(
      grupo.productos.reduce((sum, p) => sum + num(p.presupuesto_sugerido), 0),
      grupo.campania.includes('Top Rentables') ? 8000 : 4000
    );
  });

  return Object.values(grupos).sort((a, b) => b.presupuesto_diario_sugerido - a.presupuesto_diario_sugerido);
}

function resumenAsistente({ escalar, testear, revisar, bloqueados, campanias }) {
  if (!escalar.length && !testear.length) {
    return 'No conviene activar campañas todavía: primero corregí costos faltantes, tarifas Flex faltantes, márgenes bajos o productos sin demanda reciente.';
  }

  const partes = [];

  if (campanias.length) {
    partes.push(`Conviene armar ${campanias.length} campaña${campanias.length === 1 ? '' : 's'} sugerida${campanias.length === 1 ? '' : 's'}.`);
  }

  if (escalar.length) partes.push(`${escalar.length} producto${escalar.length === 1 ? '' : 's'} aparecen aptos para escalar.`);
  if (testear.length) partes.push(`${testear.length} producto${testear.length === 1 ? '' : 's'} conviene testear con presupuesto chico.`);
  if (revisar.length) partes.push(`${revisar.length} producto${revisar.length === 1 ? '' : 's'} requieren revisión antes de invertir.`);
  if (bloqueados.length) partes.push(`${bloqueados.length} producto${bloqueados.length === 1 ? '' : 's'} no deberían entrar a Ads todavía.`);

  return partes.join(' ');
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  const account = req.query.account || DEFAULT_ACCOUNT;
  const desde = req.query.desde || DEFAULT_DESDE;
  const hasta = req.query.hasta || todayISO();

  try {
    const baseUrl = getBaseUrl(req);

    const [ventasData, adsData, costosData, localidadesData] = await Promise.all([
      fetchJson(`${baseUrl}/api/ventas?account=${encodeURIComponent(account)}&desde=${encodeURIComponent(desde)}&hasta=${encodeURIComponent(hasta)}`, req),
      fetchJson(`${baseUrl}/api/ads?account=${encodeURIComponent(account)}&desde=${encodeURIComponent(desde)}&hasta=${encodeURIComponent(hasta)}`, req).catch(error => ({ error: error.message, items: [] })),
      fetchJson(`${baseUrl}/api/costos?cb=${Date.now()}`, req),
      fetchJson(`${baseUrl}/api/costos?modulo=localidades&cb=${Date.now()}`, req).catch(error => ({ error: error.message, localidades: [], localidades_activas: [] })),
    ]);

    const costosMap = buildCostosMap(costosData.costos || {});
    const localidadesMap = buildLocalidadesMap(localidadesData || {});
    const agg = aggregateVentas(ventasData.orders || [], costosMap, localidadesMap);

    mergeAds(agg, adsData.items || []);

    const productos = Object.values(agg).map(producto => ({ ...producto }));

    const buckets = {
      escalar: [],
      testear: [],
      revisar: [],
      bloqueados: [],
    };

    productos.forEach(producto => {
      const bucket = clasificarProducto(producto);
      buckets[bucket].push(producto);
    });

    const productosEscalar = sortByPriority(buckets.escalar);
    const productosTestear = sortByPriority(buckets.testear);
    const productosRevisar = sortByPriority(buckets.revisar);
    const productosBloqueados = sortByPriority(buckets.bloqueados);
    const campanias = armarCampanias(productosEscalar, productosTestear);

    const totalFacturacion = round(productos.reduce((sum, p) => sum + num(p.facturacion), 0));
    const totalGananciaPreAds = round(productos.reduce((sum, p) => sum + num(p.ganancia_pre_ads), 0));
    const totalMensajeria = round(productos.reduce((sum, p) => sum + num(p.mensajeria_total), 0));
    const totalAdsGasto = round(productos.reduce((sum, p) => sum + num(p.ads_gasto), 0));
    const totalAdsIngresos = round(productos.reduce((sum, p) => sum + num(p.ads_ingresos), 0));
    const productosConTarifaFlexFaltante = productos.filter(p => p.falta_mensajeria_flex).length;

    res.status(200).json({
      ok: true,
      tipo: 'asistente_mercado_ads',
      account,
      desde,
      hasta,
      nota: 'La recomendación descuenta costos de producto desde la planilla y mensajería Flex desde Supabase. Las ventas no Flex no descuentan mensajería manual.',
      resumen: {
        productos_analizados: productos.length,
        productos_escalar: productosEscalar.length,
        productos_testear: productosTestear.length,
        productos_revisar: productosRevisar.length,
        productos_bloqueados: productosBloqueados.length,
        productos_con_tarifa_flex_faltante: productosConTarifaFlexFaltante,
        campanias_recomendadas: campanias.length,
        facturacion: totalFacturacion,
        ganancia_pre_ads: totalGananciaPreAds,
        mensajeria_flex_descontada: totalMensajeria,
        gasto_ads_historico: totalAdsGasto,
        ingresos_ads_historico: totalAdsIngresos,
        roas_ads_historico: totalAdsGasto > 0 ? round(totalAdsIngresos / totalAdsGasto, 2) : 0,
      },
      resumen_ia: resumenAsistente({
        escalar: productosEscalar,
        testear: productosTestear,
        revisar: productosRevisar,
        bloqueados: productosBloqueados,
        campanias,
      }),
      campanias_recomendadas: campanias,
      productos_escalar: productosEscalar.slice(0, 30),
      productos_testear: productosTestear.slice(0, 30),
      productos_revisar: productosRevisar.slice(0, 50),
      productos_bloqueados: productosBloqueados.slice(0, 80),
      debug: {
        ventas_returned: ventasData.returned,
        ads_error: adsData.error || null,
        ads_items: Array.isArray(adsData.items) ? adsData.items.length : 0,
        costos_cargados: Object.keys(costosData.costos || {}).length,
        localidades_error: localidadesData.error || null,
        localidades_cargadas: localidadesMap.rows.length,
        mensajeria_flex_descontada: totalMensajeria,
        productos_con_tarifa_flex_faltante: productosConTarifaFlexFaltante,
      },
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: 'Error armando recomendaciones de Mercado Ads',
      detail: error.message,
    });
  }
}
