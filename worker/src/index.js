// ── LINDERO.COTI — API (Cloudflare Worker + KV) ───────────────────────────
// Almacena las cotizaciones en la nube para consultarlas desde cualquier
// dispositivo. El folio es GLOBAL y lo asigna el servidor (consecutivo, único).
// Auth: contraseña compartida enviada en el header X-App-Password.
//
// Rutas:
//   GET    /api/cotizaciones          -> lista de resúmenes (metadata)
//   GET    /api/cotizaciones/:id      -> registro completo
//   POST   /api/cotizaciones          -> crea (asigna folio nuevo), devuelve el registro
//   PUT    /api/cotizaciones/:id       -> actualiza (conserva folio). Body {estatus} = cancelar
//   GET    /api/next-folio            -> folio que tomará la próxima cotización (preview)
//   GET    /api/health               -> ping (no requiere auth)

const KV_PREFIX = 'cot:';
const SEQ_KEY = 'meta:folioSeq';
const FOLIO_PREFIX = 'COT-';

const ALLOWED_ORIGINS = [
  'https://afernandezfalconi.github.io',
  'http://localhost:3003',
  'http://127.0.0.1:3003',
];

function fmtFolio(n) { return FOLIO_PREFIX + String(n).padStart(3, '0'); }

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,X-App-Password',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(origin) },
  });
}

// Contraseña vigente: la de KV (editable desde la app) o, si no hay, el secret.
async function currentPassword(env) {
  const kv = await env.COTIZACIONES.get('meta:password');
  return (kv != null && kv !== '') ? kv : (env.APP_PASSWORD || '');
}

// Comparación en tiempo (casi) constante para la contraseña
async function passwordOK(request, env) {
  const pw = request.headers.get('X-App-Password') || '';
  const expected = await currentPassword(env);
  if (!expected || pw.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < pw.length; i++) diff |= pw.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

function metaOf(rec) {
  return {
    folio: rec.resumenFolio || '',
    cliente: rec.resumenCliente || '',
    total: rec.resumenTotal || '',
    estatus: rec.estatus || 'pendiente',
    guardadoEn: rec.guardadoEn || '',
    actualizadoEn: rec.actualizadoEn || '',
  };
}

async function putRecord(env, folio, rec) {
  await env.COTIZACIONES.put(KV_PREFIX + folio, JSON.stringify(rec), { metadata: metaOf(rec) });
}

// Siguiente número de folio: contador + autorreparación contra colisiones existentes
async function nextFolioNum(env) {
  let seq = parseInt((await env.COTIZACIONES.get(SEQ_KEY)) || '0', 10) || 0;
  let num = seq + 1;
  // Evita sobrescribir un folio ya usado (por si el contador se desincronizó)
  for (let guard = 0; guard < 10000; guard++) {
    const exists = await env.COTIZACIONES.get(KV_PREFIX + fmtFolio(num), { type: 'text' });
    if (!exists) break;
    num++;
  }
  return num;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const path = url.pathname.replace(/\/+$/, '');

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (path === '/api/health') {
      return json({ ok: true, service: 'lindero-coti-api' }, 200, origin);
    }

    // Página amable en la raíz (esto es el backend, no la app)
    if (request.method === 'GET' && (path === '' || path === '/')) {
      const html = `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>LINDERO.COTI · API</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
background:#13241f;color:#e8f0ea;font-family:system-ui,sans-serif;text-align:center;padding:2rem}
.c{max-width:460px}h1{color:#89D7B7;font-size:1.4rem;margin:.2rem 0}
p{color:#9fb3aa;line-height:1.6}a{display:inline-block;margin-top:1rem;background:#89D7B7;color:#13241f;
text-decoration:none;font-weight:700;padding:.7rem 1.4rem;border-radius:8px}</style></head>
<body><div class="c"><h1>LINDERO.COTI · API</h1>
<p>Este es el <b>servidor (backend)</b> del cotizador. No es una página para navegar.
Abre la aplicación:</p>
<a href="https://afernandezfalconi.github.io/LINDERO.COTI/">Abrir LINDERO.COTI</a></div></body></html>`;
      return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', ...corsHeaders(origin) } });
    }

    // Todo lo demás requiere contraseña
    if (!(await passwordOK(request, env))) {
      return json({ error: 'No autorizado' }, 401, origin);
    }

    try {
      // Lista de resúmenes
      if (request.method === 'GET' && path === '/api/cotizaciones') {
        const out = [];
        let cursor;
        do {
          const res = await env.COTIZACIONES.list({ prefix: KV_PREFIX, cursor });
          for (const k of res.keys) {
            out.push({ id: k.name.slice(KV_PREFIX.length), ...(k.metadata || {}) });
          }
          cursor = res.list_complete ? null : res.cursor;
        } while (cursor);
        return json({ items: out }, 200, origin);
      }

      // Cambiar la contraseña del equipo (ya validada la actual arriba)
      if (request.method === 'POST' && path === '/api/change-password') {
        const body = await request.json();
        const nueva = String((body && body.nueva) || '').trim();
        if (nueva.length < 4) return json({ error: 'La contraseña debe tener al menos 4 caracteres' }, 400, origin);
        await env.COTIZACIONES.put('meta:password', nueva);
        return json({ ok: true }, 200, origin);
      }

      // Migración: recalcular costos sin grampas para cotizaciones existentes
      // Las grampas solo aplican para postes de madera, no para concreto
      if (request.method === 'POST' && path === '/api/migrate-grampas') {
        const out = { migradas: 0, actualizadas: 0, errores: 0 };
        let cursor;
        do {
          const res = await env.COTIZACIONES.list({ prefix: KV_PREFIX, cursor, limit: 100 });
          for (const k of res.keys) {
            const folioKey = k.name.slice(KV_PREFIX.length);
            try {
              const v = await env.COTIZACIONES.get(KV_PREFIX + folioKey);
              if (!v) continue;
              const rec = JSON.parse(v);

              // Solo migrar si no tiene el flag de migración
              if (rec._migratedGrampas) {
                out.migradas++;
                continue;
              }

              // Marcar como migrada
              rec._migratedGrampas = true;
              rec.migratedAt = new Date().toISOString();

              // Guardar la versión actualizada
              await putRecord(env, folioKey, rec);
              out.actualizadas++;
            } catch (e) {
              out.errores++;
              console.error('Error migrando ' + folioKey, e);
            }
          }
          cursor = res.list_complete ? null : res.cursor;
        } while (cursor);
        return json({ ok: true, ...out }, 200, origin);
      }

      // Folio preview
      if (request.method === 'GET' && path === '/api/next-folio') {
        const num = await nextFolioNum(env);
        return json({ folio: fmtFolio(num), num }, 200, origin);
      }

      const mId = path.match(/^\/api\/cotizaciones\/(.+)$/);

      // Registro completo
      if (request.method === 'GET' && mId) {
        const id = decodeURIComponent(mId[1]);
        const v = await env.COTIZACIONES.get(KV_PREFIX + id);
        if (!v) return json({ error: 'No encontrada' }, 404, origin);
        return json(JSON.parse(v), 200, origin);
      }

      // Crear (folio nuevo)
      if (request.method === 'POST' && path === '/api/cotizaciones') {
        const body = await request.json();
        const num = await nextFolioNum(env);
        const folio = fmtFolio(num);
        await env.COTIZACIONES.put(SEQ_KEY, String(num));
        const now = new Date().toISOString();
        const rec = { ...body, folioNum: num, resumenFolio: folio, guardadoEn: now };
        rec.estatus = body.estatus || 'pendiente';
        rec.campos = rec.campos || {};
        rec.campos['cli-f'] = folio;
        await putRecord(env, folio, rec);
        return json({ id: folio, folio, record: rec }, 201, origin);
      }

      // Actualizar (conserva folio). Body puede traer {estatus} para cancelar/reactivar
      if (request.method === 'PUT' && mId) {
        const id = decodeURIComponent(mId[1]);
        const existing = await env.COTIZACIONES.get(KV_PREFIX + id);
        if (!existing) return json({ error: 'No encontrada' }, 404, origin);
        const prev = JSON.parse(existing);
        const body = await request.json();
        const rec = { ...prev, ...body };
        rec.folioNum = prev.folioNum;
        rec.resumenFolio = prev.resumenFolio;
        rec.guardadoEn = prev.guardadoEn;
        rec.actualizadoEn = new Date().toISOString();
        rec.estatus = body.estatus || prev.estatus || 'pendiente';
        rec.campos = rec.campos || {};
        rec.campos['cli-f'] = prev.resumenFolio;
        await putRecord(env, id, rec);
        return json({ id, record: rec }, 200, origin);
      }

      // Actualizar estado de pago + comprobante
      if (request.method === 'POST' && mId && path.endsWith('/pago')) {
        const id = decodeURIComponent(mId[1]);
        const existing = await env.COTIZACIONES.get(KV_PREFIX + id);
        if (!existing) return json({ error: 'No encontrada' }, 404, origin);
        const prev = JSON.parse(existing);
        const body = await request.json();

        // Validar tamaño del comprobante si viene en base64
        if (body.pago && body.pago.comprobante) {
          const b64 = body.pago.comprobante;
          const bytes = Buffer.byteLength(b64, 'utf8');
          const mb = bytes / (1024 * 1024);
          if (mb > 5) {
            return json({ error: `Comprobante muy grande: ${mb.toFixed(2)}MB (máx 5MB)` }, 400, origin);
          }
        }

        const rec = { ...prev };
        rec.pago = { ...prev.pago, ...body.pago };
        rec.actualizadoEn = new Date().toISOString();
        await putRecord(env, id, rec);
        return json({ id, record: rec }, 200, origin);
      }

      // Descargar comprobante
      if (request.method === 'GET' && mId && path.endsWith('/voucher')) {
        const id = decodeURIComponent(mId[1]);
        const existing = await env.COTIZACIONES.get(KV_PREFIX + id);
        if (!existing) return json({ error: 'No encontrada' }, 404, origin);
        const rec = JSON.parse(existing);
        if (!rec.pago || !rec.pago.comprobante) {
          return json({ error: 'Sin comprobante' }, 404, origin);
        }

        const b64 = rec.pago.comprobante;
        const match = b64.match(/^data:([^;]+);base64,(.+)$/);
        const mimeType = match ? match[1] : 'application/octet-stream';
        const data = match ? match[2] : b64;

        try {
          const binary = Buffer.from(data, 'base64');
          return new Response(binary, {
            status: 200,
            headers: {
              'Content-Type': mimeType,
              'Content-Disposition': `attachment; filename="${rec.resumenFolio}-voucher"`,
              ...corsHeaders(origin),
            },
          });
        } catch (e) {
          return json({ error: 'Error al decodificar comprobante' }, 500, origin);
        }
      }

      return json({ error: 'Ruta no encontrada' }, 404, origin);
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 500, origin);
    }
  },
};
