import {
  getAccountLabel,
  getValidToken,
} from './_token.js';

// COMMIT 20B
// Agrega gastos fijos recurrentes al War Room
//
// Todo sigue dentro de /api/costos para no crear más funciones en Vercel.
//
// GET /api/costos
// GET /api/costos?modulo=localidades
// GET /api/costos?modulo=finanzas
//
// POST/PUT/DELETE /api/costos?modulo=finanzas
// type: cuenta | categoria | movimiento | gasto_fijo | gastos_fijos_generar

const SHEET_ID = '1AJRDGujWNkam2cWrH050zjTTz0Gmuo_niK_nMTTzKIM';
const SHEET_NAME = 'PRODUCTOS';

const MP_API = 'https://api.mercadopago.com';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function setCommonHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
}

function assertSupabaseConfig() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Faltan variables SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en Vercel');
  }
}

function getSupabaseHeaders(extra = {}) {
  assertSupabaseConfig();

  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

async function supabaseRequest(path, options = {}) {
  assertSupabaseConfig();

  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: getSupabaseHeaders(options.headers || {}),
  });

  const text = await response.text();
  let data = null;

  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    throw new Error(
      data?.message ||
      data?.error ||
      data?.hint ||
      `Error Supabase HTTP ${response.status}`
    );
  }

  return data;
}

function cleanText(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ');
}

function normalizeText(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');
}

function toNumber(value) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function round2(value) {
  return Math.round(toNumber(value) * 100) / 100;
}

function toBool(value, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return ['true', '1', 'si', 'sí', 'yes'].includes(String(value).trim().toLowerCase());
}

function emptyToNull(value) {
  if (value === undefined || value === null) return null;
  const clean = String(value).trim();
  return clean === '' ? null : clean;
}

function getBody(req) {
  if (!req.body) return {};

  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }

  return req.body;
}

function todayArgentinaISO() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function addDaysISO(dateISO, days) {
  const date = new Date(`${dateISO}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function dateOnly(value) {
  if (!value) return null;

  const raw = String(value);

  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
    return raw.slice(0, 10);
  }

  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return null;

  return date.toISOString().slice(0, 10);
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

async function mapLimit(items, limit, mapper) {
  const results = [];
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const currentIndex = index;
      index += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);

  return results;
}

function parseCosto(value) {
  if (typeof value === 'number') return value;

  const raw = String(value ?? '')
    .replace(/\$/g, '')
    .replace(/ARS/gi, '')
    .replace(/\s/g, '')
    .trim();

  if (raw === '') return null;

  if (raw.includes(',') && raw.includes('.')) {
    return Number(raw.replace(/\./g, '').replace(',', '.'));
  }

  if (raw.includes('.') && /^\d{1,3}(\.\d{3})+$/.test(raw)) {
    return Number(raw.replace(/\./g, ''));
  }

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
  const original = cleanText(key);
  const normalizada = String(key ?? '').trim().toLowerCase();

  if (!original) return;
  if (!Number.isFinite(Number(costo))) return;

  costos[original] = Number(costo);
  costos[normalizada] = Number(costo);
}

/* =========================================================
   LOCALIDADES / MENSAJERÍA
========================================================= */

async function getPartidos() {
  const rows = await supabaseRequest('envio_partidos?select=*&order=nombre.asc');
  return Array.isArray(rows) ? rows : [];
}

async function getLocalidades() {
  const rows = await supabaseRequest('v_envio_localidades?select=*&order=partido.asc,localidad.asc');
  return Array.isArray(rows) ? rows : [];
}

async function findPartidoByNorm(nombre) {
  const nombreNorm = normalizeText(nombre);
  if (!nombreNorm) return null;

  const rows = await supabaseRequest(
    `envio_partidos?nombre_norm=eq.${encodeURIComponent(nombreNorm)}&select=*&limit=1`
  );

  return Array.isArray(rows) ? rows[0] || null : null;
}

async function findLocalidadByNorm(partidoId, nombre) {
  const nombreNorm = normalizeText(nombre);
  if (!partidoId || !nombreNorm) return null;

  const rows = await supabaseRequest(
    `envio_localidades?partido_id=eq.${encodeURIComponent(partidoId)}&nombre_norm=eq.${encodeURIComponent(nombreNorm)}&select=*&limit=1`
  );

  return Array.isArray(rows) ? rows[0] || null : null;
}

async function createOrRestorePartido(nombre) {
  const cleanNombre = cleanText(nombre);
  if (!cleanNombre) throw new Error('El nombre del partido es obligatorio');

  const existing = await findPartidoByNorm(cleanNombre);

  if (existing) {
    const updated = await supabaseRequest(
      `envio_partidos?id=eq.${encodeURIComponent(existing.id)}`,
      {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          nombre: cleanNombre,
          activo: true,
        }),
      }
    );

    return Array.isArray(updated) ? updated[0] : updated;
  }

  const created = await supabaseRequest('envio_partidos', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      nombre: cleanNombre,
      activo: true,
    }),
  });

  return Array.isArray(created) ? created[0] : created;
}

async function createOrUpdateLocalidad({ partido_id, partido, localidad, nombre, tarifa, activo = true }) {
  const cleanLocalidad = cleanText(localidad || nombre);
  const cleanPartido = cleanText(partido);

  if (!cleanLocalidad) throw new Error('El nombre de la localidad es obligatorio');

  let partidoId = partido_id || null;

  if (!partidoId) {
    if (!cleanPartido) throw new Error('Tenés que indicar partido_id o nombre de partido');
    const partidoRow = await createOrRestorePartido(cleanPartido);
    partidoId = partidoRow.id;
  }

  const existing = await findLocalidadByNorm(partidoId, cleanLocalidad);

  const payload = {
    partido_id: partidoId,
    nombre: cleanLocalidad,
    tarifa: toNumber(tarifa),
    activo: toBool(activo, true),
  };

  if (existing) {
    const updated = await supabaseRequest(
      `envio_localidades?id=eq.${encodeURIComponent(existing.id)}`,
      {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(payload),
      }
    );

    return Array.isArray(updated) ? updated[0] : updated;
  }

  const created = await supabaseRequest('envio_localidades', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(payload),
  });

  return Array.isArray(created) ? created[0] : created;
}

async function updatePartido(body) {
  const id = body.id || body.partido_id;
  const nombre = cleanText(body.nombre || body.partido);

  if (!id) throw new Error('Falta id del partido');
  if (!nombre) throw new Error('El nombre del partido es obligatorio');

  const updated = await supabaseRequest(
    `envio_partidos?id=eq.${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        nombre,
        activo: toBool(body.activo, true),
      }),
    }
  );

  return Array.isArray(updated) ? updated[0] : updated;
}

async function updateLocalidad(body) {
  const id = body.id || body.localidad_id;
  const nombre = cleanText(body.nombre || body.localidad);

  if (!id) throw new Error('Falta id de la localidad');
  if (!nombre) throw new Error('El nombre de la localidad es obligatorio');

  const payload = {
    nombre,
    tarifa: toNumber(body.tarifa),
    activo: toBool(body.activo, true),
  };

  if (body.partido_id) {
    payload.partido_id = body.partido_id;
  } else if (body.partido) {
    const partidoRow = await createOrRestorePartido(body.partido);
    payload.partido_id = partidoRow.id;
  }

  const updated = await supabaseRequest(
    `envio_localidades?id=eq.${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(payload),
    }
  );

  return Array.isArray(updated) ? updated[0] : updated;
}

async function deleteOrDisablePartido(body) {
  const id = body.id || body.partido_id;
  if (!id) throw new Error('Falta id del partido');

  const updated = await supabaseRequest(
    `envio_partidos?id=eq.${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ activo: false }),
    }
  );

  return Array.isArray(updated) ? updated[0] : updated;
}

async function deleteOrDisableLocalidad(body) {
  const id = body.id || body.localidad_id;
  if (!id) throw new Error('Falta id de la localidad');

  const updated = await supabaseRequest(
    `envio_localidades?id=eq.${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ activo: false }),
    }
  );

  return Array.isArray(updated) ? updated[0] : updated;
}

async function migrateLocalStorageItems(items = []) {
  if (!Array.isArray(items)) throw new Error('items debe ser un array');

  const result = {
    recibidos: items.length,
    creados_o_actualizados: 0,
    omitidos: 0,
    errores: [],
  };

  for (const item of items) {
    try {
      const partido = cleanText(item.partido);
      const localidad = cleanText(item.localidad);
      const tarifa = toNumber(item.tarifa);

      if (!partido || !localidad) {
        result.omitidos += 1;
        continue;
      }

      await createOrUpdateLocalidad({
        partido,
        localidad,
        tarifa,
        activo: true,
      });

      result.creados_o_actualizados += 1;
    } catch (error) {
      result.errores.push({
        item,
        error: error.message,
      });
    }
  }

  return result;
}

function buildLocalidadesResponse({ partidos, localidades, extra = {} }) {
  const partidosActivos = partidos.filter(p => p.activo !== false);
  const localidadesActivas = localidades.filter(l => l.activo !== false);

  return {
    ok: true,
    modulo: 'localidades',
    partidos,
    localidades,
    partidos_activos: partidosActivos,
    localidades_activas: localidadesActivas,
    total_partidos: partidos.length,
    total_localidades: localidades.length,
    total_partidos_activos: partidosActivos.length,
    total_localidades_activos: localidadesActivas.length,
    nota: 'Tarifas de mensajería guardadas en Supabase.',
    ...extra,
  };
}

async function handleLocalidades(req, res) {
  try {
    let extra = {};

    if (req.method === 'GET') {
      const partidos = await getPartidos();
      const localidades = await getLocalidades();

      return res.status(200).json(buildLocalidadesResponse({
        partidos,
        localidades,
      }));
    }

    const body = getBody(req);
    const type = body.type || body.tipo || body.recurso;
    const action = body.action || body.accion || '';

    if (req.method === 'POST') {
      if (action === 'migrate' || action === 'migrar') {
        extra.migracion = await migrateLocalStorageItems(body.items || body.localidades || []);
      } else if (type === 'partido') {
        extra.partido = await createOrRestorePartido(body.nombre || body.partido);
      } else if (type === 'localidad') {
        extra.localidad = await createOrUpdateLocalidad(body);
      } else {
        throw new Error('POST requiere type partido/localidad o action migrate');
      }

      const partidos = await getPartidos();
      const localidades = await getLocalidades();

      return res.status(200).json(buildLocalidadesResponse({ partidos, localidades, extra }));
    }

    if (req.method === 'PUT' || req.method === 'PATCH') {
      if (type === 'partido') {
        extra.partido = await updatePartido(body);
      } else if (type === 'localidad') {
        extra.localidad = await updateLocalidad(body);
      } else {
        throw new Error('PUT requiere type partido o localidad');
      }

      const partidos = await getPartidos();
      const localidades = await getLocalidades();

      return res.status(200).json(buildLocalidadesResponse({ partidos, localidades, extra }));
    }

    if (req.method === 'DELETE') {
      if (type === 'partido') {
        extra.partido = await deleteOrDisablePartido(body);
      } else if (type === 'localidad') {
        extra.localidad = await deleteOrDisableLocalidad(body);
      } else {
        throw new Error('DELETE requiere type partido o localidad');
      }

      const partidos = await getPartidos();
      const localidades = await getLocalidades();

      return res.status(200).json(buildLocalidadesResponse({ partidos, localidades, extra }));
    }

    return res.status(405).json({
      ok: false,
      modulo: 'localidades',
      error: 'Método no permitido',
      method: req.method,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      modulo: 'localidades',
      error: 'Error en localidades',
      detail: error.message,
    });
  }
}

/* =========================================================
   FINANZAS
========================================================= */

function cleanFinanzasTipo(value, fallback = 'egreso') {
  const allowed = new Set([
    'ingreso',
    'egreso',
    'deuda',
    'proveedor',
    'impuesto',
    'reposicion',
    'transferencia',
    'ajuste',
    'otro',
  ]);

  const tipo = cleanText(value || fallback).toLowerCase();
  return allowed.has(tipo) ? tipo : fallback;
}

function cleanGastoFijoTipo(value, fallback = 'egreso') {
  const allowed = new Set([
    'egreso',
    'deuda',
    'proveedor',
    'impuesto',
    'reposicion',
    'otro',
  ]);

  const tipo = cleanText(value || fallback).toLowerCase();
  return allowed.has(tipo) ? tipo : fallback;
}

function cleanFinanzasEstado(value, fallback = 'pendiente') {
  const allowed = new Set(['pendiente', 'pagado', 'cobrado', 'cancelado']);
  const estado = cleanText(value || fallback).toLowerCase();
  return allowed.has(estado) ? estado : fallback;
}

function cleanCuentaTipo(value, fallback = 'otro') {
  const allowed = new Set(['mercado_pago', 'banco', 'efectivo', 'caja', 'reserva', 'otro']);
  const tipo = cleanText(value || fallback).toLowerCase();
  return allowed.has(tipo) ? tipo : fallback;
}

function clampDia(value) {
  const n = Math.trunc(toNumber(value || 10));
  if (n < 1) return 1;
  if (n > 31) return 31;
  return n;
}

function getPeriodoActual() {
  return todayArgentinaISO().slice(0, 7);
}

function lastDayOfMonth(year, monthNumber) {
  return new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
}

function vencimientoFromPeriodo(periodo, dia) {
  const [yearRaw, monthRaw] = String(periodo || getPeriodoActual()).split('-');
  const year = Number(yearRaw);
  const month = Number(monthRaw);

  if (!year || !month) return todayArgentinaISO();

  const last = lastDayOfMonth(year, month);
  const safeDay = Math.min(clampDia(dia), last);

  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(safeDay).padStart(2, '0')}`;
}

async function getFinanzasCuentas() {
  const rows = await supabaseRequest('finanzas_cuentas?select=*&order=orden.asc,nombre.asc');
  return Array.isArray(rows) ? rows : [];
}

async function getFinanzasCategorias() {
  const rows = await supabaseRequest('finanzas_categorias?select=*&order=orden.asc,nombre.asc');
  return Array.isArray(rows) ? rows : [];
}

async function getFinanzasMovimientos() {
  const rows = await supabaseRequest('v_finanzas_movimientos?select=*&order=fecha_vencimiento.asc.nullslast,fecha.desc,created_at.desc');
  return Array.isArray(rows) ? rows : [];
}

async function getFinanzasGastosFijos() {
  const rows = await supabaseRequest('finanzas_gastos_fijos?select=*&order=activo.desc,dia_vencimiento.asc,nombre.asc');
  return Array.isArray(rows) ? rows : [];
}

async function getFinanzasResumen() {
  const rows = await supabaseRequest('v_finanzas_resumen?select=*');
  return Array.isArray(rows) ? rows[0] || {} : {};
}

function enrichGastosFijos(gastosFijos, categorias, cuentas) {
  const categoriaMap = new Map(categorias.map(c => [c.id, c]));
  const cuentaMap = new Map(cuentas.map(c => [c.id, c]));

  return gastosFijos.map(g => {
    const categoria = categoriaMap.get(g.categoria_id);
    const cuenta = cuentaMap.get(g.cuenta_id);

    return {
      ...g,
      categoria: categoria?.nombre || null,
      categoria_tipo: categoria?.tipo || null,
      cuenta: cuenta?.nombre || null,
      cuenta_tipo: cuenta?.tipo || null,
    };
  });
}

function buildFinanzasResponse({ resumen, cuentas, categorias, movimientos, gastosFijos, liquidacionesMp = null, gastosFijosSync = null, extra = {} }) {
  const cuentasActivas = cuentas.filter(c => c.activo !== false);
  const categoriasActivas = categorias.filter(c => c.activo !== false);
  const movimientosActivos = movimientos.filter(m => m.activo !== false);
  const gastosFijosActivos = gastosFijos.filter(g => g.activo !== false);

  const pendientes = movimientosActivos.filter(m => m.estado === 'pendiente');
  const pagados = movimientosActivos.filter(m => m.estado === 'pagado' || m.estado === 'cobrado');
  const vencidos = pendientes.filter(m => m.vencido);
  const vence7Dias = pendientes.filter(m => m.vence_7_dias);
  const vence30Dias = pendientes.filter(m => m.vence_30_dias);

  const dineroDisponible = toNumber(resumen.dinero_disponible);
  const dineroManualOriginal = toNumber(resumen.dinero_a_cobrar);
  const manualMpExcluido = liquidacionesMp ? sumarIngresosManualMpExcluidos(movimientosActivos) : 0;
  const dineroManualSinMp = Math.max(0, dineroManualOriginal - manualMpExcluido);
  const liquidacionesPendientes = liquidacionesMp ? toNumber(liquidacionesMp.total_pendiente) : 0;
  const dineroACobrarTotal = round2(dineroManualSinMp + liquidacionesPendientes);
  const dineroAPagar = toNumber(resumen.dinero_a_pagar);
  const cajaProyectada = round2(dineroDisponible + dineroACobrarTotal - dineroAPagar);

  return {
    ok: true,
    modulo: 'finanzas',
    resumen: {
      dinero_disponible: dineroDisponible,
      dinero_a_cobrar: dineroACobrarTotal,
      dinero_a_cobrar_manual_original: dineroManualOriginal,
      dinero_a_cobrar_manual: dineroManualSinMp,
      ingresos_mp_manuales_excluidos: manualMpExcluido,
      liquidaciones_mp_pendientes: liquidacionesPendientes,
      dinero_a_pagar: dineroAPagar,
      pagos_vencidos: toNumber(resumen.pagos_vencidos),
      pagos_7_dias: toNumber(resumen.pagos_7_dias),
      pagos_30_dias: toNumber(resumen.pagos_30_dias),
      caja_proyectada: cajaProyectada,
    },
    cuentas,
    categorias,
    movimientos,
    gastos_fijos: gastosFijos,
    cuentas_activas: cuentasActivas,
    categorias_activas: categoriasActivas,
    movimientos_activos: movimientosActivos,
    gastos_fijos_activos: gastosFijosActivos,
    pendientes,
    pagados,
    vencidos,
    vence_7_dias: vence7Dias,
    vence_30_dias: vence30Dias,
    liquidaciones_mp: liquidacionesMp,
    gastos_fijos_sync: gastosFijosSync,
    total_cuentas: cuentas.length,
    total_categorias: categorias.length,
    total_movimientos: movimientos.length,
    total_gastos_fijos: gastosFijos.length,
    total_gastos_fijos_activos: gastosFijosActivos.length,
    total_pendientes: pendientes.length,
    total_pagados: pagados.length,
    total_vencidos: vencidos.length,
    nota: 'War Room: disponible + liquidaciones MP + ingresos manuales - pagos pendientes. Gastos fijos se generan por mes sin duplicarse.',
    ...extra,
  };
}

async function loadFinanzasResponse(extra = {}, liquidacionesMp = null, gastosFijosSync = null) {
  const [resumen, cuentas, categorias, movimientos, gastosFijosRaw] = await Promise.all([
    getFinanzasResumen(),
    getFinanzasCuentas(),
    getFinanzasCategorias(),
    getFinanzasMovimientos(),
    getFinanzasGastosFijos(),
  ]);

  const gastosFijos = enrichGastosFijos(gastosFijosRaw, categorias, cuentas);

  return buildFinanzasResponse({
    resumen,
    cuentas,
    categorias,
    movimientos,
    gastosFijos,
    liquidacionesMp,
    gastosFijosSync,
    extra,
  });
}

/* ========================
   GASTOS FIJOS
======================== */

function buildGastoFijoPayload(body, partial = false) {
  const payload = {};

  const set = (key, value) => {
    if (!partial || value !== undefined) payload[key] = value;
  };

  set('nombre', body.nombre !== undefined ? cleanText(body.nombre) : undefined);
  set('tipo', body.tipo !== undefined ? cleanGastoFijoTipo(body.tipo, 'egreso') : undefined);
  set('monto', body.monto !== undefined ? toNumber(body.monto) : undefined);
  set('moneda', body.moneda !== undefined ? cleanText(body.moneda || 'ARS') : undefined);
  set('categoria_id', body.categoria_id !== undefined ? emptyToNull(body.categoria_id) : undefined);
  set('cuenta_id', body.cuenta_id !== undefined ? emptyToNull(body.cuenta_id) : undefined);
  set('proveedor', body.proveedor !== undefined ? emptyToNull(body.proveedor) : undefined);
  set('dia_vencimiento', body.dia_vencimiento !== undefined ? clampDia(body.dia_vencimiento) : undefined);
  set('frecuencia', 'mensual');
  set('activo', body.activo !== undefined ? toBool(body.activo, true) : undefined);
  set('notas', body.notas !== undefined ? emptyToNull(body.notas) : undefined);

  Object.keys(payload).forEach(key => {
    if (payload[key] === undefined) delete payload[key];
  });

  return payload;
}

async function createFinanzasGastoFijo(body) {
  const nombre = cleanText(body.nombre);
  const monto = toNumber(body.monto);

  if (!nombre) throw new Error('El nombre del gasto fijo es obligatorio');
  if (monto <= 0) throw new Error('El monto del gasto fijo debe ser mayor a cero');

  const payload = {
    nombre,
    tipo: cleanGastoFijoTipo(body.tipo, 'egreso'),
    monto,
    moneda: cleanText(body.moneda || 'ARS'),
    categoria_id: emptyToNull(body.categoria_id),
    cuenta_id: emptyToNull(body.cuenta_id),
    proveedor: emptyToNull(body.proveedor),
    dia_vencimiento: clampDia(body.dia_vencimiento || 10),
    frecuencia: 'mensual',
    activo: toBool(body.activo, true),
    notas: emptyToNull(body.notas),
  };

  const created = await supabaseRequest('finanzas_gastos_fijos', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(payload),
  });

  return Array.isArray(created) ? created[0] : created;
}

async function updateFinanzasGastoFijo(body) {
  const id = body.id || body.gasto_fijo_id;
  if (!id) throw new Error('Falta id del gasto fijo');

  const payload = buildGastoFijoPayload(body, true);

  if (payload.nombre !== undefined && !payload.nombre) {
    throw new Error('El nombre del gasto fijo no puede quedar vacío');
  }

  if (payload.monto !== undefined && payload.monto <= 0) {
    throw new Error('El monto del gasto fijo debe ser mayor a cero');
  }

  const updated = await supabaseRequest(
    `finanzas_gastos_fijos?id=eq.${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(payload),
    }
  );

  return Array.isArray(updated) ? updated[0] : updated;
}

async function deleteOrDisableFinanzasGastoFijo(body) {
  const id = body.id || body.gasto_fijo_id;
  const hardDelete = body.hard_delete === true;

  if (!id) throw new Error('Falta id del gasto fijo');

  if (hardDelete) {
    await supabaseRequest(`finanzas_gastos_fijos?id=eq.${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { Prefer: 'return=minimal' },
    });

    return { id, deleted: true };
  }

  return updateFinanzasGastoFijo({
    id,
    activo: false,
  });
}

async function findMovimientoByReferencia(referencia) {
  const rows = await supabaseRequest(
    `finanzas_movimientos?referencia_externa=eq.${encodeURIComponent(referencia)}&select=*&limit=1`
  );

  return Array.isArray(rows) ? rows[0] || null : null;
}

async function generarGastoFijoDelPeriodo(gasto, periodo) {
  const referencia = `gasto_fijo:${gasto.id}:${periodo}`;
  const existente = await findMovimientoByReferencia(referencia);
  const fechaVencimiento = vencimientoFromPeriodo(periodo, gasto.dia_vencimiento);

  const payload = {
    tipo: cleanGastoFijoTipo(gasto.tipo, 'egreso'),
    estado: 'pendiente',
    descripcion: `${gasto.nombre} (${periodo})`,
    monto: toNumber(gasto.monto),
    moneda: cleanText(gasto.moneda || 'ARS'),
    cuenta_id: emptyToNull(gasto.cuenta_id),
    categoria_id: emptyToNull(gasto.categoria_id),
    fecha: todayArgentinaISO(),
    fecha_vencimiento: fechaVencimiento,
    proveedor: emptyToNull(gasto.proveedor),
    notas: gasto.notas ? `Gasto fijo mensual. ${gasto.notas}` : 'Gasto fijo mensual.',
    origen: 'sistema',
    referencia_externa: referencia,
    activo: true,
  };

  if (existente) {
    if (existente.estado !== 'pendiente') {
      return {
        gasto_fijo_id: gasto.id,
        movimiento_id: existente.id,
        referencia,
        accion: 'omitido',
        motivo: `Ya existe y está ${existente.estado}`,
      };
    }

    const updated = await supabaseRequest(
      `finanzas_movimientos?id=eq.${encodeURIComponent(existente.id)}`,
      {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(payload),
      }
    );

    const row = Array.isArray(updated) ? updated[0] : updated;

    return {
      gasto_fijo_id: gasto.id,
      movimiento_id: row.id,
      referencia,
      accion: 'actualizado',
    };
  }

  const created = await supabaseRequest('finanzas_movimientos', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(payload),
  });

  const row = Array.isArray(created) ? created[0] : created;

  return {
    gasto_fijo_id: gasto.id,
    movimiento_id: row.id,
    referencia,
    accion: 'creado',
  };
}

async function syncGastosFijosDelMes({ periodo = getPeriodoActual(), gastoFijoId = null } = {}) {
  const rows = await getFinanzasGastosFijos();

  const activos = rows.filter(g =>
    g.activo !== false &&
    (!gastoFijoId || g.id === gastoFijoId)
  );

  const result = {
    ok: true,
    periodo,
    recibidos: activos.length,
    creados: 0,
    actualizados: 0,
    omitidos: 0,
    errores: [],
    detalle: [],
  };

  for (const gasto of activos) {
    try {
      const item = await generarGastoFijoDelPeriodo(gasto, periodo);
      result.detalle.push(item);

      if (item.accion === 'creado') result.creados += 1;
      else if (item.accion === 'actualizado') result.actualizados += 1;
      else result.omitidos += 1;
    } catch (error) {
      result.errores.push({
        gasto_fijo_id: gasto.id,
        nombre: gasto.nombre,
        error: error.message,
      });
    }
  }

  return result;
}

/* ========================
   CUENTAS/CATEGORÍAS/MOVIMIENTOS
======================== */

async function createFinanzasCuenta(body) {
  const nombre = cleanText(body.nombre);
  if (!nombre) throw new Error('El nombre de la cuenta es obligatorio');

  const payload = {
    nombre,
    tipo: cleanCuentaTipo(body.tipo, 'otro'),
    saldo_actual: toNumber(body.saldo_actual ?? body.saldo ?? 0),
    moneda: cleanText(body.moneda || 'ARS'),
    activo: toBool(body.activo, true),
    orden: Math.trunc(toNumber(body.orden || 0)),
    notas: emptyToNull(body.notas),
  };

  const created = await supabaseRequest('finanzas_cuentas', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(payload),
  });

  return Array.isArray(created) ? created[0] : created;
}

async function updateFinanzasCuenta(body) {
  const id = body.id || body.cuenta_id;
  if (!id) throw new Error('Falta id de la cuenta');

  const payload = {};

  if (body.nombre !== undefined) payload.nombre = cleanText(body.nombre);
  if (body.tipo !== undefined) payload.tipo = cleanCuentaTipo(body.tipo, 'otro');
  if (body.saldo_actual !== undefined || body.saldo !== undefined) payload.saldo_actual = toNumber(body.saldo_actual ?? body.saldo);
  if (body.moneda !== undefined) payload.moneda = cleanText(body.moneda || 'ARS');
  if (body.activo !== undefined) payload.activo = toBool(body.activo, true);
  if (body.orden !== undefined) payload.orden = Math.trunc(toNumber(body.orden));
  if (body.notas !== undefined) payload.notas = emptyToNull(body.notas);

  const updated = await supabaseRequest(
    `finanzas_cuentas?id=eq.${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(payload),
    }
  );

  return Array.isArray(updated) ? updated[0] : updated;
}

async function deleteOrDisableFinanzasCuenta(body) {
  const id = body.id || body.cuenta_id;
  if (!id) throw new Error('Falta id de la cuenta');

  return updateFinanzasCuenta({
    id,
    activo: false,
  });
}

async function createFinanzasCategoria(body) {
  const nombre = cleanText(body.nombre);
  if (!nombre) throw new Error('El nombre de la categoría es obligatorio');

  const payload = {
    nombre,
    tipo: cleanFinanzasTipo(body.tipo, 'egreso'),
    activo: toBool(body.activo, true),
    orden: Math.trunc(toNumber(body.orden || 0)),
  };

  const created = await supabaseRequest('finanzas_categorias', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(payload),
  });

  return Array.isArray(created) ? created[0] : created;
}

async function updateFinanzasCategoria(body) {
  const id = body.id || body.categoria_id;
  if (!id) throw new Error('Falta id de la categoría');

  const payload = {};

  if (body.nombre !== undefined) payload.nombre = cleanText(body.nombre);
  if (body.tipo !== undefined) payload.tipo = cleanFinanzasTipo(body.tipo, 'egreso');
  if (body.activo !== undefined) payload.activo = toBool(body.activo, true);
  if (body.orden !== undefined) payload.orden = Math.trunc(toNumber(body.orden));

  const updated = await supabaseRequest(
    `finanzas_categorias?id=eq.${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(payload),
    }
  );

  return Array.isArray(updated) ? updated[0] : updated;
}

async function deleteOrDisableFinanzasCategoria(body) {
  const id = body.id || body.categoria_id;
  if (!id) throw new Error('Falta id de la categoría');

  return updateFinanzasCategoria({
    id,
    activo: false,
  });
}

function buildMovimientoPayload(body, partial = false) {
  const payload = {};

  const set = (key, value) => {
    if (!partial || value !== undefined) payload[key] = value;
  };

  set('tipo', body.tipo !== undefined ? cleanFinanzasTipo(body.tipo, 'egreso') : undefined);
  set('estado', body.estado !== undefined ? cleanFinanzasEstado(body.estado, 'pendiente') : undefined);
  set('descripcion', body.descripcion !== undefined ? cleanText(body.descripcion) : undefined);
  set('monto', body.monto !== undefined ? toNumber(body.monto) : undefined);
  set('moneda', body.moneda !== undefined ? cleanText(body.moneda || 'ARS') : undefined);
  set('cuenta_id', body.cuenta_id !== undefined ? emptyToNull(body.cuenta_id) : undefined);
  set('cuenta_destino_id', body.cuenta_destino_id !== undefined ? emptyToNull(body.cuenta_destino_id) : undefined);
  set('categoria_id', body.categoria_id !== undefined ? emptyToNull(body.categoria_id) : undefined);
  set('fecha', body.fecha !== undefined ? emptyToNull(body.fecha) : undefined);
  set('fecha_vencimiento', body.fecha_vencimiento !== undefined ? emptyToNull(body.fecha_vencimiento) : undefined);
  set('fecha_pago', body.fecha_pago !== undefined ? emptyToNull(body.fecha_pago) : undefined);
  set('proveedor', body.proveedor !== undefined ? emptyToNull(body.proveedor) : undefined);
  set('comprobante_url', body.comprobante_url !== undefined ? emptyToNull(body.comprobante_url) : undefined);
  set('notas', body.notas !== undefined ? emptyToNull(body.notas) : undefined);
  set('origen', body.origen !== undefined ? cleanText(body.origen || 'manual') : undefined);
  set('referencia_externa', body.referencia_externa !== undefined ? emptyToNull(body.referencia_externa) : undefined);
  set('activo', body.activo !== undefined ? toBool(body.activo, true) : undefined);

  Object.keys(payload).forEach(key => {
    if (payload[key] === undefined) delete payload[key];
  });

  return payload;
}

async function createFinanzasMovimiento(body) {
  const descripcion = cleanText(body.descripcion);
  const monto = toNumber(body.monto);

  if (!descripcion) throw new Error('La descripción del movimiento es obligatoria');
  if (monto <= 0) throw new Error('El monto del movimiento debe ser mayor a cero');

  const payload = {
    tipo: cleanFinanzasTipo(body.tipo, 'egreso'),
    estado: cleanFinanzasEstado(body.estado, 'pendiente'),
    descripcion,
    monto,
    moneda: cleanText(body.moneda || 'ARS'),
    cuenta_id: emptyToNull(body.cuenta_id),
    cuenta_destino_id: emptyToNull(body.cuenta_destino_id),
    categoria_id: emptyToNull(body.categoria_id),
    fecha: emptyToNull(body.fecha) || todayArgentinaISO(),
    fecha_vencimiento: emptyToNull(body.fecha_vencimiento),
    fecha_pago: emptyToNull(body.fecha_pago),
    proveedor: emptyToNull(body.proveedor),
    comprobante_url: emptyToNull(body.comprobante_url),
    notas: emptyToNull(body.notas),
    origen: cleanText(body.origen || 'manual'),
    referencia_externa: emptyToNull(body.referencia_externa),
    activo: toBool(body.activo, true),
  };

  const created = await supabaseRequest('finanzas_movimientos', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(payload),
  });

  return Array.isArray(created) ? created[0] : created;
}

async function updateFinanzasMovimiento(body) {
  const id = body.id || body.movimiento_id;
  if (!id) throw new Error('Falta id del movimiento');

  const payload = buildMovimientoPayload(body, true);

  if (payload.descripcion !== undefined && !payload.descripcion) {
    throw new Error('La descripción del movimiento no puede quedar vacía');
  }

  if (payload.monto !== undefined && payload.monto <= 0) {
    throw new Error('El monto del movimiento debe ser mayor a cero');
  }

  const updated = await supabaseRequest(
    `finanzas_movimientos?id=eq.${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(payload),
    }
  );

  return Array.isArray(updated) ? updated[0] : updated;
}

async function deleteOrDisableFinanzasMovimiento(body) {
  const id = body.id || body.movimiento_id;
  if (!id) throw new Error('Falta id del movimiento');

  return updateFinanzasMovimiento({
    id,
    activo: false,
  });
}

/* ========================
   LIQUIDACIONES MP
======================== */

function isManualMercadoPagoLiquidacion(m) {
  if (!m || m.tipo !== 'ingreso' || m.estado !== 'pendiente') return false;

  const source = normalizeText(`${m.descripcion || ''} ${m.proveedor || ''} ${m.categoria || ''}`);

  return source.includes('mercado pago') &&
    (
      source.includes('liquidar') ||
      source.includes('liberar') ||
      source.includes('a cobrar') ||
      source.includes('pendiente')
    );
}

function sumarIngresosManualMpExcluidos(movimientos = []) {
  return movimientos
    .filter(isManualMercadoPagoLiquidacion)
    .reduce((sum, m) => sum + toNumber(m.monto), 0);
}

function getPaymentNetAmount(payment, fallback = 0) {
  return round2(
    toNumber(payment?.transaction_details?.net_received_amount) ||
    toNumber(payment?.net_received_amount) ||
    toNumber(payment?.transaction_amount) ||
    toNumber(fallback)
  );
}

function getPaymentReleaseDate(payment) {
  return dateOnly(
    payment?.money_release_date ||
    payment?.money_release_schema?.release_date ||
    payment?.transaction_details?.money_release_date ||
    payment?.date_last_updated ||
    payment?.date_approved
  );
}

function shouldConsiderPaymentForLiquidacion(payment) {
  const status = String(payment?.status || '').toLowerCase();
  return ['approved', 'in_process', 'pending', 'authorized'].includes(status);
}

function buildEmptyLiquidaciones(error = null) {
  return {
    ok: !error,
    error,
    generado_en: new Date().toISOString(),
    desde: null,
    hasta: null,
    total_pendiente: 0,
    hoy: 0,
    manana: 0,
    proximos_7_dias: 0,
    proximos_30_dias: 0,
    sin_fecha: 0,
    pagos_consultados: 0,
    pagos_validos: 0,
    pagos_con_error: 0,
    por_fecha: [],
    por_cuenta: [],
    pagos: [],
    errores: [],
    nota: 'Liquidaciones MP calculadas dinámicamente desde pagos futuros.',
  };
}

function summarizeLiquidaciones(pagos = [], errores = [], desde = null, hasta = null) {
  const today = todayArgentinaISO();
  const tomorrow = addDaysISO(today, 1);
  const day7 = addDaysISO(today, 7);
  const day30 = addDaysISO(today, 30);

  const summary = buildEmptyLiquidaciones();
  summary.desde = desde;
  summary.hasta = hasta;
  summary.pagos_consultados = pagos.length + errores.length;
  summary.pagos_con_error = errores.length;
  summary.errores = errores;

  const byDate = new Map();
  const byAccount = new Map();

  pagos.forEach(pago => {
    const monto = toNumber(pago.monto_neto);
    const fecha = pago.money_release_date;
    const cuentaKey = pago.cuenta_key || pago.account || 'sin_cuenta';
    const cuenta = pago.cuenta || cuentaKey;

    if (!fecha) {
      summary.sin_fecha += monto;
      return;
    }

    if (fecha < today) {
      return;
    }

    summary.pagos_validos += 1;
    summary.total_pendiente += monto;

    if (fecha === today) summary.hoy += monto;
    if (fecha === tomorrow) summary.manana += monto;
    if (fecha >= today && fecha <= day7) summary.proximos_7_dias += monto;
    if (fecha >= today && fecha <= day30) summary.proximos_30_dias += monto;

    const dateRow = byDate.get(fecha) || {
      fecha,
      monto: 0,
      pagos: 0,
      cuentas: {},
    };

    dateRow.monto += monto;
    dateRow.pagos += 1;
    dateRow.cuentas[cuenta] = round2(toNumber(dateRow.cuentas[cuenta]) + monto);
    byDate.set(fecha, dateRow);

    const accountRow = byAccount.get(cuentaKey) || {
      cuenta_key: cuentaKey,
      cuenta,
      monto: 0,
      pagos: 0,
      hoy: 0,
      proximos_7_dias: 0,
      proximos_30_dias: 0,
    };

    accountRow.monto += monto;
    accountRow.pagos += 1;
    if (fecha === today) accountRow.hoy += monto;
    if (fecha >= today && fecha <= day7) accountRow.proximos_7_dias += monto;
    if (fecha >= today && fecha <= day30) accountRow.proximos_30_dias += monto;
    byAccount.set(cuentaKey, accountRow);
  });

  summary.total_pendiente = round2(summary.total_pendiente);
  summary.hoy = round2(summary.hoy);
  summary.manana = round2(summary.manana);
  summary.proximos_7_dias = round2(summary.proximos_7_dias);
  summary.proximos_30_dias = round2(summary.proximos_30_dias);
  summary.sin_fecha = round2(summary.sin_fecha);

  summary.por_fecha = Array.from(byDate.values())
    .map(row => ({
      ...row,
      monto: round2(row.monto),
    }))
    .sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)));

  summary.por_cuenta = Array.from(byAccount.values())
    .map(row => ({
      ...row,
      monto: round2(row.monto),
      hoy: round2(row.hoy),
      proximos_7_dias: round2(row.proximos_7_dias),
      proximos_30_dias: round2(row.proximos_30_dias),
    }))
    .sort((a, b) => String(a.cuenta).localeCompare(String(b.cuenta)));

  summary.pagos = pagos
    .filter(pago => pago.money_release_date && pago.money_release_date >= today)
    .sort((a, b) => String(a.money_release_date).localeCompare(String(b.money_release_date)))
    .slice(0, 120);

  return summary;
}

async function fetchMercadoPagoPayment(paymentId, token) {
  const response = await fetch(`${MP_API}/v1/payments/${paymentId}`, {
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      'Content-Type': 'application/json',
    },
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data?.message || data?.error || `Error MP HTTP ${response.status}`);
  }

  return data;
}

async function getMercadoPagoLiquidaciones(req, res) {
  const desde = req.query?.desde_liquidaciones || req.query?.desde || '2026-01-01';
  const hasta = req.query?.hasta || todayArgentinaISO();
  const account = req.query?.account || 'all';

  try {
    const baseUrl = getBaseUrl(req);
    const ventasUrl = `${baseUrl}/api/ventas?account=${encodeURIComponent(account)}&desde=${encodeURIComponent(desde)}&hasta=${encodeURIComponent(hasta)}`;

    const ventasData = await fetchInternalJson(ventasUrl, req);
    const orders = Array.isArray(ventasData.orders) ? ventasData.orders : [];

    const paymentRows = new Map();

    orders.forEach(order => {
      const paymentIds = Array.isArray(order.payment_ids) ? order.payment_ids : [];
      const cuentaKey = order.cuenta_key || order.account || 'lebron';

      paymentIds.forEach(paymentId => {
        if (!paymentId) return;

        const key = `${cuentaKey}:${paymentId}`;

        if (!paymentRows.has(key)) {
          paymentRows.set(key, {
            key,
            payment_id: paymentId,
            cuenta_key: cuentaKey,
            cuenta: order.cuenta || getAccountLabel(cuentaKey),
            account: cuentaKey,
            order_id: order.order_id || order.id,
            pack_id: order.pack_id || null,
            envio_id: order.envio_id || null,
            comprador: order.comprador || order.buyer_nickname || '—',
            producto: order.producto || '—',
            monto_fallback: toNumber(order.mp_net_received_amount) || toNumber(order.cobro_neto),
            fecha_venta: order.fecha || null,
          });
        }
      });
    });

    const rows = Array.from(paymentRows.values());
    const tokenCache = {};
    const pagos = [];
    const errores = [];

    await mapLimit(rows, 8, async row => {
      try {
        if (!tokenCache[row.cuenta_key]) {
          tokenCache[row.cuenta_key] = await getValidToken(req, res, row.cuenta_key);
        }

        const token = tokenCache[row.cuenta_key];

        if (!token) {
          throw new Error(`Token no disponible para ${row.cuenta}`);
        }

        const payment = await fetchMercadoPagoPayment(row.payment_id, token);

        if (!shouldConsiderPaymentForLiquidacion(payment)) {
          return;
        }

        const releaseDate = getPaymentReleaseDate(payment);
        const montoNeto = getPaymentNetAmount(payment, row.monto_fallback);

        if (montoNeto <= 0) return;

        pagos.push({
          payment_id: row.payment_id,
          order_id: row.order_id,
          pack_id: row.pack_id,
          envio_id: row.envio_id,
          cuenta_key: row.cuenta_key,
          cuenta: row.cuenta,
          comprador: row.comprador,
          producto: row.producto,
          fecha_venta: row.fecha_venta,
          money_release_date: releaseDate,
          monto_neto: montoNeto,
          transaction_amount: toNumber(payment?.transaction_amount),
          total_paid_amount: toNumber(payment?.transaction_details?.total_paid_amount || payment?.total_paid_amount),
        });
      } catch (error) {
        errores.push({
          payment_id: row.payment_id,
          cuenta_key: row.cuenta_key,
          cuenta: row.cuenta,
          order_id: row.order_id,
          error: error.message,
        });
      }
    });

    const summary = summarizeLiquidaciones(pagos, errores, desde, hasta);
    summary.ventas_consultadas = orders.length;
    summary.pagos_detectados = rows.length;
    summary.ok = true;

    return summary;
  } catch (error) {
    return buildEmptyLiquidaciones(error.message);
  }
}

/* ========================
   HANDLER FINANZAS
======================== */

async function handleFinanzas(req, res) {
  try {
    let extra = {};

    if (req.method === 'GET') {
      const syncLiquidaciones = String(req.query?.sync_liquidaciones ?? '1') !== '0';
      const syncGastosFijos = String(req.query?.sync_gastos_fijos ?? '1') !== '0';
      const periodo = req.query?.periodo || getPeriodoActual();

      let liquidacionesMp = null;
      let gastosFijosSync = null;

      if (syncGastosFijos) {
        gastosFijosSync = await syncGastosFijosDelMes({ periodo });
      }

      if (syncLiquidaciones) {
        liquidacionesMp = await getMercadoPagoLiquidaciones(req, res);
      }

      const response = await loadFinanzasResponse(extra, liquidacionesMp, gastosFijosSync);
      return res.status(200).json(response);
    }

    const body = getBody(req);
    const type = body.type || body.tipo || body.recurso;
    const action = body.action || body.accion || '';

    if (req.method === 'POST') {
      if (type === 'cuenta') {
        extra.cuenta = await createFinanzasCuenta(body);
      } else if (type === 'categoria' || type === 'categoría') {
        extra.categoria = await createFinanzasCategoria(body);
      } else if (type === 'movimiento') {
        extra.movimiento = await createFinanzasMovimiento(body);
      } else if (type === 'gasto_fijo') {
        extra.gasto_fijo = await createFinanzasGastoFijo(body);
      } else if (type === 'gastos_fijos_generar' || action === 'generar_gastos_fijos') {
        extra.gastos_fijos_sync = await syncGastosFijosDelMes({
          periodo: body.periodo || getPeriodoActual(),
          gastoFijoId: body.gasto_fijo_id || null,
        });
      } else {
        throw new Error('POST requiere type cuenta, categoria, movimiento, gasto_fijo o gastos_fijos_generar');
      }

      const response = await loadFinanzasResponse(extra, null, null);
      return res.status(200).json(response);
    }

    if (req.method === 'PUT' || req.method === 'PATCH') {
      if (type === 'cuenta') {
        extra.cuenta = await updateFinanzasCuenta(body);
      } else if (type === 'categoria' || type === 'categoría') {
        extra.categoria = await updateFinanzasCategoria(body);
      } else if (type === 'movimiento') {
        extra.movimiento = await updateFinanzasMovimiento(body);
      } else if (type === 'gasto_fijo') {
        extra.gasto_fijo = await updateFinanzasGastoFijo(body);
      } else {
        throw new Error('PUT requiere type cuenta, categoria, movimiento o gasto_fijo');
      }

      const response = await loadFinanzasResponse(extra, null, null);
      return res.status(200).json(response);
    }

    if (req.method === 'DELETE') {
      if (type === 'cuenta') {
        extra.cuenta = await deleteOrDisableFinanzasCuenta(body);
      } else if (type === 'categoria' || type === 'categoría') {
        extra.categoria = await deleteOrDisableFinanzasCategoria(body);
      } else if (type === 'movimiento') {
        extra.movimiento = await deleteOrDisableFinanzasMovimiento(body);
      } else if (type === 'gasto_fijo') {
        extra.gasto_fijo = await deleteOrDisableFinanzasGastoFijo(body);
      } else {
        throw new Error('DELETE requiere type cuenta, categoria, movimiento o gasto_fijo');
      }

      const response = await loadFinanzasResponse(extra, null, null);
      return res.status(200).json(response);
    }

    return res.status(405).json({
      ok: false,
      modulo: 'finanzas',
      error: 'Método no permitido',
      method: req.method,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      modulo: 'finanzas',
      error: 'Error en finanzas',
      detail: error.message,
    });
  }
}

/* =========================================================
   COSTOS GOOGLE SHEETS
========================================================= */

async function handleCostos(req, res) {
  try {
    const cacheBuster = Date.now();
    const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json&sheet=${encodeURIComponent(SHEET_NAME)}&cb=${cacheBuster}`;

    const r = await fetch(url, {
      cache: 'no-store',
      headers: {
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
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
      const sku = cleanText(getCell(row, skuIdx));
      const itemId = cleanText(getCell(row, itemIdIdx));
      const costoRaw = getCell(row, costoIdx);
      const costoParseado = parseCosto(costoRaw);
      const costoValido = costoRaw !== null && costoRaw !== undefined && String(costoRaw).trim() !== '' && Number.isFinite(Number(costoParseado));

      if (!sku && !itemId) return;

      filas_leidas.push({
        fila: index + 2,
        sku,
        item_id: itemId,
        costo: costoValido ? Number(costoParseado) : null,
        costo_raw: costoRaw,
      });

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

    return res.status(200).json({
      costos,
      total_claves: Object.keys(costos).length,
      total_filas_leidas: filas_leidas.length,
      productos_sin_costo,
      actualizado: new Date().toISOString(),
      nota: 'Costo 0 se considera válido para productos bonificados.',
    });
  } catch (err) {
    return res.status(500).json({
      error: 'Error al leer la planilla',
      detail: err.message,
    });
  }
}

/* =========================================================
   HANDLER PRINCIPAL
========================================================= */

export default async function handler(req, res) {
  setCommonHeaders(res);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const modulo = String(
    req.query?.modulo ||
    req.query?.module ||
    req.query?.tipo ||
    req.query?.resource ||
    ''
  ).trim().toLowerCase();

  if (modulo === 'localidades' || modulo === 'envios' || modulo === 'mensajeria') {
    return handleLocalidades(req, res);
  }

  if (modulo === 'finanzas' || modulo === 'warroom' || modulo === 'war-room') {
    return handleFinanzas(req, res);
  }

  if (req.method !== 'GET') {
    return res.status(405).json({
      ok: false,
      error: 'Método no permitido para costos. Para localidades usá /api/costos?modulo=localidades. Para finanzas usá /api/costos?modulo=finanzas.',
      method: req.method,
    });
  }

  return handleCostos(req, res);
}
