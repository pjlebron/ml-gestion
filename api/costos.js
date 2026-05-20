// COMMIT 18B CORREGIDO
// Nombre del commit:
// Integra localidades dentro de API costos
//
// Archivo:
// api/costos.js
//
// Motivo:
// Vercel Hobby permite hasta 12 Serverless Functions.
// No podemos crear api/localidades.js porque suma una función nueva.
// Por eso integramos Localidades dentro de api/costos.js, que ya existía.
//
// Rutas:
// GET /api/costos
//   Mantiene el comportamiento actual: lee costos desde Google Sheets.
//
// GET /api/costos?modulo=localidades
//   Lista partidos y localidades desde Supabase.
//
// POST /api/costos?modulo=localidades
//   Crea partido, localidad o migra desde localStorage.
//
// PUT /api/costos?modulo=localidades
//   Edita partido, localidad o tarifa.
//
// DELETE /api/costos?modulo=localidades
//   Desactiva o borra partido/localidad.

const SHEET_ID = '1AJRDGujWNkam2cWrH050zjTTz0Gmuo_niK_nMTTzKIM';
const SHEET_NAME = 'PRODUCTOS';

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
  const original = normalizarTexto(key);
  const normalizada = normalizarClave(key);

  if (!original) return;
  if (!Number.isFinite(Number(costo))) return;

  costos[original] = Number(costo);
  costos[normalizada] = Number(costo);
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

function normalizeText(value) {
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

function toNumber(value) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toBool(value, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return ['true', '1', 'si', 'sí', 'yes'].includes(String(value).trim().toLowerCase());
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

  if (!cleanNombre) {
    throw new Error('El nombre del partido es obligatorio');
  }

  const existing = await findPartidoByNorm(cleanNombre);

  if (existing) {
    if (existing.activo === false || existing.nombre !== cleanNombre) {
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

    return existing;
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

  if (!cleanLocalidad) {
    throw new Error('El nombre de la localidad es obligatorio');
  }

  let partidoId = partido_id || null;

  if (!partidoId) {
    if (!cleanPartido) {
      throw new Error('Tenés que indicar partido_id o nombre de partido');
    }

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
  const hardDelete = body.hard_delete === true;

  if (!id) throw new Error('Falta id del partido');

  if (hardDelete) {
    await supabaseRequest(`envio_partidos?id=eq.${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { Prefer: 'return=minimal' },
    });

    return { id, deleted: true };
  }

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
  const hardDelete = body.hard_delete === true;

  if (!id) throw new Error('Falta id de la localidad');

  if (hardDelete) {
    await supabaseRequest(`envio_localidades?id=eq.${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { Prefer: 'return=minimal' },
    });

    return { id, deleted: true };
  }

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
  if (!Array.isArray(items)) {
    throw new Error('items debe ser un array');
  }

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
    total_localidades_activas: localidadesActivas.length,
    nota: 'Tarifas de mensajería guardadas en Supabase dentro de /api/costos?modulo=localidades.',
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

      return res.status(200).json(buildLocalidadesResponse({
        partidos,
        localidades,
        extra,
      }));
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

      return res.status(200).json(buildLocalidadesResponse({
        partidos,
        localidades,
        extra,
      }));
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

      return res.status(200).json(buildLocalidadesResponse({
        partidos,
        localidades,
        extra,
      }));
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

async function handleCostos(req, res) {
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

  if (req.method !== 'GET') {
    return res.status(405).json({
      ok: false,
      error: 'Método no permitido para costos. Para localidades usá /api/costos?modulo=localidades',
      method: req.method,
    });
  }

  return handleCostos(req, res);
}
