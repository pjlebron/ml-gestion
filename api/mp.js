import {
  buildMpAuthUrl,
  disconnectMercadoPago,
  exchangeMpCodeAndSave,
  getMercadoPagoTokenStatus,
} from './_mp_token.js';

import {
  getAccountKeys,
  getAccountLabel,
  normalizeAccount,
} from './_token.js';

function setCommonHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
}

function redirect(res, url) {
  res.statusCode = 302;
  res.setHeader('Location', url);
  return res.end();
}

function getBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

function htmlPage({ title, message, detail = '', success = true, redirectUrl = '/finanzas.html' }) {
  const color = success ? '#20703a' : '#a32d2d';

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<style>
body{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f5f5f5;color:#111;margin:0;padding:30px}
.card{max-width:720px;margin:60px auto;background:#fff;border:1px solid #ddd;border-radius:18px;padding:24px;box-shadow:0 2px 8px rgba(0,0,0,.05)}
h1{margin:0 0 10px;font-size:24px}
.status{font-weight:900;color:${color};font-size:18px;margin-bottom:10px}
p{color:#555;line-height:1.5}
pre{background:#fafafa;border:1px solid #eee;border-radius:12px;padding:12px;white-space:pre-wrap;font-size:12px}
a{display:inline-flex;margin-top:12px;background:#111;color:white;text-decoration:none;border-radius:10px;padding:10px 14px;font-weight:800;font-size:13px}
</style>
</head>
<body>
<div class="card">
  <h1>${title}</h1>
  <div class="status">${message}</div>
  ${detail ? `<pre>${detail}</pre>` : ''}
  <p>Volvé al War Room financiero. El próximo paso es usar este token para traer saldo disponible real de Mercado Pago. Porque aparentemente saber cuánta plata hay requiere una peregrinación OAuth.</p>
  <a href="${redirectUrl}">Volver a Finanzas</a>
</div>
</body>
</html>`;
}

export default async function handler(req, res) {
  setCommonHeaders(res);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const action = String(req.query.action || req.query.accion || 'status').trim().toLowerCase();
    const account = normalizeAccount(req.query.account || req.query.cuenta || 'lebron');

    if (req.method !== 'GET') {
      return res.status(405).json({
        ok: false,
        error: 'Método no permitido. Usá GET.',
      });
    }

    if (action === 'auth' || action === 'connect' || action === 'conectar') {
      const url = buildMpAuthUrl(req, account);
      return redirect(res, url);
    }

    if (action === 'callback') {
      const code = req.query.code;
      const state = req.query.state;
      const error = req.query.error || req.query.error_description;

      if (error) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.status(400).send(htmlPage({
          title: 'Mercado Pago',
          message: 'No se pudo conectar Mercado Pago',
          detail: String(error),
          success: false,
        }));
      }

      if (!code) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.status(400).send(htmlPage({
          title: 'Mercado Pago',
          message: 'Falta el código de autorización',
          detail: 'Mercado Pago volvió sin ?code=...',
          success: false,
        }));
      }

      const result = await exchangeMpCodeAndSave({
        req,
        code,
        state,
      });

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).send(htmlPage({
        title: 'Mercado Pago conectado',
        message: `${result.label} conectado correctamente`,
        detail: JSON.stringify(result, null, 2),
        success: true,
        redirectUrl: `${getBaseUrl(req)}/finanzas.html?mp_connected=${encodeURIComponent(result.account)}`,
      }));
    }

    if (action === 'disconnect' || action === 'logout' || action === 'desconectar') {
      const result = await disconnectMercadoPago(account);

      return res.status(200).json({
        ok: true,
        action,
        ...result,
      });
    }

    if (action === 'links') {
      const baseUrl = getBaseUrl(req);

      return res.status(200).json({
        ok: true,
        action,
        redirect_uri_recomendada: `${baseUrl}/api/mp?action=callback`,
        cuentas: getAccountKeys().map(key => ({
          account: key,
          label: getAccountLabel(key),
          conectar: `${baseUrl}/api/mp?action=auth&account=${key}`,
          desconectar: `${baseUrl}/api/mp?action=disconnect&account=${key}`,
        })),
        nota: 'Usá una sola Redirect URI en Mercado Pago: /api/mp?action=callback',
      });
    }

    const status = await getMercadoPagoTokenStatus();

    return res.status(200).json({
      ok: true,
      modulo: 'mercado_pago_oauth',
      action: 'status',
      cuentas: Object.fromEntries(
        getAccountKeys().map(key => [
          key,
          {
            label: getAccountLabel(key),
            ...(status[key] || {}),
          },
        ])
      ),
      links: Object.fromEntries(
        getAccountKeys().map(key => [
          key,
          `/api/mp?action=auth&account=${key}`,
        ])
      ),
      nota: 'OAuth real de Mercado Pago listo. Falta Commit 20B para usar estos tokens y leer saldo disponible.',
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      modulo: 'mercado_pago_oauth',
      error: error.message,
    });
  }
}
