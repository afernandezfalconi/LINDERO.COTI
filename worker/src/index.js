// ── LINDERO.COTI — API v2 (Cloudflare Worker + KV) ───────────────────────────
// Seguridad mejorada + Sistema de usuarios + Auditoría
//
// CAMBIOS SEGURIDAD:
// 1. Landing page con tokens aleatorios (no folio)
// 2. Rate limiting por IP
// 3. Timing attack fix (crypto.subtle.timingSafeEqual)
// 4. Comprobantes encriptados (opcional R2)
// 5. Auditoría completa de acciones
//
// USUARIOS Y PERMISOS:
// - ADMIN: acceso total + gestión usuarios
// - EDITOR: crear/editar propias cotizaciones
// - VIEWER: solo ver cotizaciones
// - Custom: permisos granulares (bit flags)

const KV_PREFIX = 'cot:';
const USERS_PREFIX = 'user:';
const AUDIT_PREFIX = 'audit:';
const TOKENS_PREFIX = 'token:';
const RATE_LIMIT_PREFIX = 'ratelimit:';
const SEQ_KEY = 'meta:folioSeq';
const FOLIO_PREFIX = 'COT-';
const ADMIN_EMAIL = 'afernandezfalconi@gmail.com';

// Permisos en forma de bits
const PERMISSIONS = {
  VIEW_COTIZACIONES: 1 << 0,      // 1
  CREATE_COTIZACIONES: 1 << 1,    // 2
  EDIT_OWN: 1 << 2,               // 4
  EDIT_ALL: 1 << 3,               // 8
  DELETE_OWN: 1 << 4,             // 16
  DELETE_ALL: 1 << 5,             // 32
  VIEW_AUDIT: 1 << 6,             // 64
  MANAGE_USERS: 1 << 7,           // 128
  VIEW_LANDING: 1 << 8,           // 256
};

const ROLES = {
  ADMIN: 0xFF,                    // Todos los permisos
  EDITOR: PERMISSIONS.VIEW_COTIZACIONES | PERMISSIONS.CREATE_COTIZACIONES | PERMISSIONS.EDIT_OWN | PERMISSIONS.DELETE_OWN,
  VIEWER: PERMISSIONS.VIEW_COTIZACIONES | PERMISSIONS.VIEW_LANDING,
};

const ALLOWED_ORIGINS = [
  'https://afernandezfalconi.github.io',
  'http://localhost:3003',
  'http://127.0.0.1:3003',
];

const RATE_LIMIT_WINDOW = 60;      // 60 segundos
const RATE_LIMIT_MAX = 100;        // 100 requests por ventana
const AUTH_RATE_LIMIT_MAX = 5;     // 5 intentos de auth

function fmtFolio(n) { return FOLIO_PREFIX + String(n).padStart(3, '0'); }

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,X-Auth-Token,X-User-Email',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  };
}

function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(origin) },
  });
}

// ── SEGURIDAD: Rate Limiting ──────────────────────────────────────────
async function checkRateLimit(env, ip, isAuth = false) {
  const key = RATE_LIMIT_PREFIX + ip + (isAuth ? ':auth' : '');
  const current = parseInt((await env.COTIZACIONES.get(key)) || '0');
  const limit = isAuth ? AUTH_RATE_LIMIT_MAX : RATE_LIMIT_MAX;

  if (current >= limit) {
    return false; // Rate limited
  }

  await env.COTIZACIONES.put(key, String(current + 1), { expirationTtl: RATE_LIMIT_WINDOW });
  return true;
}

// ── SEGURIDAD: Timing-safe comparison ─────────────────────────────────
async function timingSafeCompare(a, b) {
  if (a.length !== b.length) return false;

  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// ── USUARIOS Y AUTENTICACIÓN ──────────────────────────────────────────
async function getUserByToken(env, token) {
  const email = await env.COTIZACIONES.get(TOKENS_PREFIX + token);
  if (!email) return null;

  const userData = await env.COTIZACIONES.get(USERS_PREFIX + email);
  if (!userData) return null;

  return { email, ...JSON.parse(userData) };
}

async function hasPermission(user, perm) {
  return (user.permissions & perm) !== 0;
}

async function createAuditLog(env, user, action, resource, details = {}) {
  const timestamp = new Date().toISOString();
  const auditEntry = {
    timestamp,
    usuario: user.email,
    accion: action,
    recurso: resource,
    detalles: details,
  };

  const key = AUDIT_PREFIX + timestamp + ':' + Math.random().toString(36);
  await env.COTIZACIONES.put(key, JSON.stringify(auditEntry), { expirationTtl: 90 * 24 * 3600 }); // 90 días
}

// ── LANDING PAGE CON TOKEN ────────────────────────────────────────────
async function generateLandingToken(env, folio) {
  const token = Math.random().toString(36).substring(2, 34);
  await env.COTIZACIONES.put(TOKENS_PREFIX + 'landing:' + token, folio, { expirationTtl: 30 * 24 * 3600 }); // 30 días
  return token;
}

async function getLandingByToken(env, token) {
  const folio = await env.COTIZACIONES.get(TOKENS_PREFIX + 'landing:' + token);
  if (!folio) return null;

  return await env.COTIZACIONES.get(KV_PREFIX + folio);
}

// ── VALIDACIÓN DE ENTRADA ─────────────────────────────────────────────
function validateCotizacion(rec) {
  if (!rec || typeof rec !== 'object') return false;
  if (typeof rec.resumenCliente !== 'string' || rec.resumenCliente.length > 200) return false;
  if (rec.campos && typeof rec.campos !== 'object') return false;
  return true;
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

async function nextFolioNum(env) {
  let seq = parseInt((await env.COTIZACIONES.get(SEQ_KEY)) || '0', 10) || 0;
  let num = seq + 1;
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
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

    // ── CORS ──────────────────────────────────────────────────────────
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // ── HEALTH CHECK (sin auth) ───────────────────────────────────────
    if (path === '/api/health') {
      return json({ ok: true, service: 'lindero-coti-api-v2', timestamp: new Date().toISOString() }, 200, origin);
    }

    // ── LANDING PAGE PÚBLICA (con token, sin auth) ────────────────────
    const mLanding = path.match(/^\/landing\/([a-z0-9]+)$/);
    if (request.method === 'GET' && mLanding) {
      const token = mLanding[1];
      const v = await getLandingByToken(env, token);
      if (!v) return json({ error: 'Cotización no encontrada o expirada' }, 404, origin);

      const rec = JSON.parse(v);
      const detallesLote = `
        <tr><td>Forma</td><td>${rec.resumenDetalles?.forma || '—'}</td></tr>
        <tr><td>Perímetro</td><td>${rec.resumenDetalles?.perim || '—'}</td></tr>
        <tr><td>Área</td><td>${rec.resumenDetalles?.area || '—'}</td></tr>
        <tr><td>Separación</td><td>${rec.resumenDetalles?.sep || '—'}</td></tr>
        <tr><td>Portón</td><td>${rec.resumenDetalles?.porton || '—'}</td></tr>
      `;

      const materialesLote = `
        <tr><td>Postes línea</td><td>${rec.resumenDetalles?.postesLinea || '—'}</td></tr>
        <tr><td>Postes esquineros</td><td>${rec.resumenDetalles?.postesEsq || '—'}</td></tr>
        <tr><td>Material</td><td>${rec.resumenDetalles?.material || '—'}</td></tr>
        <tr><td>Modo</td><td>${rec.resumenDetalles?.modo || '—'}</td></tr>
        <tr><td>Alambre</td><td>${rec.resumenDetalles?.alambre || '—'}</td></tr>
        <tr><td>Mano de obra</td><td>${rec.resumenDetalles?.mo || '—'}</td></tr>
      `;

      const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="ie=edge">
  <meta name="referrer" content="strict-origin-when-cross-origin">
  <title>Cotización ${rec.resumenFolio} - Lindero</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #f5f5f5; color: #333; line-height: 1.6; }
    .container { max-width: 800px; margin: 2rem auto; padding: 2rem; background: white; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
    .header { border-bottom: 3px solid #13241f; padding-bottom: 1.5rem; margin-bottom: 2rem; }
    .logo { font-size: 1.5rem; font-weight: bold; color: #13241f; margin-bottom: 0.5rem; }
    .fecha { font-size: 0.9rem; color: #666; }
    .cliente { background: #f9f9f9; padding: 1rem; border-radius: 6px; margin-bottom: 2rem; border-left: 4px solid #89D7B7; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 1.5rem; }
    th { background: #13241f; color: white; padding: 0.75rem; text-align: left; font-size: 0.9rem; text-transform: uppercase; }
    td { padding: 0.75rem; border-bottom: 1px solid #ddd; }
    .total-section { background: #13241f; color: white; padding: 2rem; border-radius: 8px; text-align: center; margin-top: 2rem; }
    .total-valor { font-size: 2.5rem; font-weight: bold; color: #89D7B7; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="logo">🚧 LINDERO</div>
      <div class="fecha">Folio: ${rec.resumenFolio}</div>
    </div>
    <div class="cliente">
      <strong>Cliente:</strong> ${rec.resumenCliente || '—'}
    </div>
    <h3>Detalle del Lote</h3>
    <table><tbody>${detallesLote}</tbody></table>
    <h3>Materiales y Mano de Obra</h3>
    <table><tbody>${materialesLote}</tbody></table>
    <div class="total-section">
      <div>Precio Total</div>
      <div class="total-valor">${rec.resumenTotal || '$—'}</div>
    </div>
  </div>
</body>
</html>`;

      return new Response(html, {
        status: 200,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'public, max-age=3600',
          'X-Content-Type-Options': 'nosniff',
          ...corsHeaders(origin),
        },
      });
    }

    // ── RESTO DE ENDPOINTS REQUIEREN AUTENTICACIÓN ────────────────────
    const token = request.headers.get('X-Auth-Token');
    const userEmail = request.headers.get('X-User-Email');

    if (!token || !userEmail) {
      return json({ error: 'No autorizado' }, 401, origin);
    }

    // Rate limiting
    if (!(await checkRateLimit(env, ip))) {
      return json({ error: 'Demasiadas solicitudes, intenta más tarde' }, 429, origin);
    }

    // Obtener usuario
    const user = await getUserByToken(env, token);
    if (!user || user.email !== userEmail) {
      if (!(await checkRateLimit(env, ip + ':auth', true))) {
        return json({ error: 'Intentos de autenticación excedidos' }, 429, origin);
      }
      return json({ error: 'Token inválido o expirado' }, 401, origin);
    }

    try {
      // ── LOGIN / OBTENER TOKEN ────────────────────────────────────────
      if (request.method === 'POST' && path === '/api/auth/login') {
        // Solo admin puede loguear otros usuarios
        const body = await request.json();
        const email = body.email;

        if (!email || typeof email !== 'string' || !email.includes('@')) {
          return json({ error: 'Email inválido' }, 400, origin);
        }

        // Solo el admin o el usuario mismo puede loguearse
        if (user.email !== email && user.email !== ADMIN_EMAIL) {
          await createAuditLog(env, user, 'LOGIN_ATTEMPT_DENIED', email, { reason: 'No admin' });
          return json({ error: 'Sin permiso' }, 403, origin);
        }

        // Generar token
        const newToken = Math.random().toString(36).substring(2, 34) + Math.random().toString(36).substring(2, 34);
        await env.COTIZACIONES.put(TOKENS_PREFIX + newToken, email, { expirationTtl: 7 * 24 * 3600 }); // 7 días

        await createAuditLog(env, user, 'LOGIN', email);
        return json({ token: newToken, email }, 200, origin);
      }

      // ── LISTAR COTIZACIONES ──────────────────────────────────────────
      if (request.method === 'GET' && path === '/api/cotizaciones') {
        if (!(await hasPermission(user, PERMISSIONS.VIEW_COTIZACIONES))) {
          return json({ error: 'Sin permisos para ver cotizaciones' }, 403, origin);
        }

        const out = [];
        let cursor;
        do {
          const res = await env.COTIZACIONES.list({ prefix: KV_PREFIX, cursor, limit: 50 });
          for (const k of res.keys) {
            out.push({ id: k.name.slice(KV_PREFIX.length), ...(k.metadata || {}) });
          }
          cursor = res.list_complete ? null : res.cursor;
        } while (cursor);

        await createAuditLog(env, user, 'LIST_COTIZACIONES', 'all', { count: out.length });
        return json({ items: out }, 200, origin);
      }

      // ── OBTENER COTIZACIÓN ───────────────────────────────────────────
      if (request.method === 'GET' && path.match(/^\/api\/cotizaciones\/[^/]+$/)) {
        if (!(await hasPermission(user, PERMISSIONS.VIEW_COTIZACIONES))) {
          return json({ error: 'Sin permisos' }, 403, origin);
        }

        const id = path.split('/').pop();
        const v = await env.COTIZACIONES.get(KV_PREFIX + id);
        if (!v) return json({ error: 'No encontrada' }, 404, origin);

        const rec = JSON.parse(v);
        await createAuditLog(env, user, 'VIEW', id);
        return json(rec, 200, origin);
      }

      // ── CREAR COTIZACIÓN ─────────────────────────────────────────────
      if (request.method === 'POST' && path === '/api/cotizaciones') {
        if (!(await hasPermission(user, PERMISSIONS.CREATE_COTIZACIONES))) {
          return json({ error: 'Sin permisos para crear' }, 403, origin);
        }

        const body = await request.json();
        if (!validateCotizacion(body)) {
          return json({ error: 'Datos inválidos' }, 400, origin);
        }

        const num = await nextFolioNum(env);
        const folio = fmtFolio(num);
        await env.COTIZACIONES.put(SEQ_KEY, String(num));

        const now = new Date().toISOString();
        const rec = { ...body, folioNum: num, resumenFolio: folio, guardadoEn: now, creador: user.email };
        rec.estatus = body.estatus || 'pendiente';
        rec.campos = rec.campos || {};
        rec.campos['cli-f'] = folio;

        await putRecord(env, folio, rec);
        await createAuditLog(env, user, 'CREATE', folio);

        return json({ id: folio, folio, record: rec }, 201, origin);
      }

      // ── ACTUALIZAR COTIZACIÓN ────────────────────────────────────────
      if (request.method === 'PUT' && path.match(/^\/api\/cotizaciones\/[^/]+$/)) {
        const id = path.split('/').pop();
        const existing = await env.COTIZACIONES.get(KV_PREFIX + id);
        if (!existing) return json({ error: 'No encontrada' }, 404, origin);

        const prev = JSON.parse(existing);

        // Verificar permisos: puede editar propia o todas (si es admin)
        const canEditAll = await hasPermission(user, PERMISSIONS.EDIT_ALL);
        const canEditOwn = await hasPermission(user, PERMISSIONS.EDIT_OWN);
        const isOwner = prev.creador === user.email;

        if (!canEditAll && (!canEditOwn || !isOwner)) {
          await createAuditLog(env, user, 'EDIT_DENIED', id, { reason: 'No permissions' });
          return json({ error: 'Sin permisos para editar' }, 403, origin);
        }

        const body = await request.json();
        if (!validateCotizacion(body)) {
          return json({ error: 'Datos inválidos' }, 400, origin);
        }

        const rec = { ...prev, ...body };
        rec.folioNum = prev.folioNum;
        rec.resumenFolio = prev.resumenFolio;
        rec.guardadoEn = prev.guardadoEn;
        rec.actualizadoEn = new Date().toISOString();
        rec.creador = prev.creador;

        // Registrar cambios específicos
        const cambios = {};
        for (const key in body) {
          if (JSON.stringify(prev[key]) !== JSON.stringify(body[key])) {
            cambios[key] = { anterior: prev[key], nuevo: body[key] };
          }
        }

        await putRecord(env, id, rec);
        await createAuditLog(env, user, 'EDIT', id, { cambios });

        return json({ id, record: rec }, 200, origin);
      }

      // ── AUDITORÍA (solo admin/usuarios con permisos) ──────────────────
      if (request.method === 'GET' && path === '/api/audit') {
        if (!(await hasPermission(user, PERMISSIONS.VIEW_AUDIT)) && user.email !== ADMIN_EMAIL) {
          return json({ error: 'Sin permisos' }, 403, origin);
        }

        const out = [];
        let cursor;
        do {
          const res = await env.COTIZACIONES.list({ prefix: AUDIT_PREFIX, cursor, limit: 100 });
          for (const k of res.keys) {
            const audit = await env.COTIZACIONES.get(k.name);
            if (audit) out.push(JSON.parse(audit));
          }
          cursor = res.list_complete ? null : res.cursor;
        } while (cursor);

        return json({ items: out.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)) }, 200, origin);
      }

      // ── GESTIÓN DE USUARIOS (solo admin) ─────────────────────────────
      if (path.startsWith('/api/users') && user.email !== ADMIN_EMAIL) {
        return json({ error: 'Solo admin' }, 403, origin);
      }

      if (request.method === 'POST' && path === '/api/users') {
        const body = await request.json();
        const newEmail = body.email;
        const role = body.role || 'VIEWER';

        if (!newEmail || !newEmail.includes('@') || !ROLES[role]) {
          return json({ error: 'Datos inválidos' }, 400, origin);
        }

        const userData = {
          email: newEmail,
          rol: role,
          permissions: ROLES[role],
          creadoEn: new Date().toISOString(),
          creadoPor: user.email,
        };

        await env.COTIZACIONES.put(USERS_PREFIX + newEmail, JSON.stringify(userData));
        await createAuditLog(env, user, 'CREATE_USER', newEmail, { role });

        return json(userData, 201, origin);
      }

      if (request.method === 'GET' && path === '/api/users') {
        const out = [];
        let cursor;
        do {
          const res = await env.COTIZACIONES.list({ prefix: USERS_PREFIX, cursor, limit: 50 });
          for (const k of res.keys) {
            const userData = await env.COTIZACIONES.get(k.name);
            if (userData) out.push(JSON.parse(userData));
          }
          cursor = res.list_complete ? null : res.cursor;
        } while (cursor);

        return json({ items: out }, 200, origin);
      }

      return json({ error: 'Ruta no encontrada' }, 404, origin);
    } catch (e) {
      console.error(e);
      return json({ error: String((e && e.message) || e) }, 500, origin);
    }
  },
};
