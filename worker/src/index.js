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

// Comparación en tiempo (casi) constante para la contraseña
function passwordOK(request, env) {
  const pw = request.headers.get('X-App-Password') || '';
  const expected = env.APP_PASSWORD || '';
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

    // Todo lo demás requiere contraseña
    if (!passwordOK(request, env)) {
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

      return json({ error: 'Ruta no encontrada' }, 404, origin);
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 500, origin);
    }
  },
};
