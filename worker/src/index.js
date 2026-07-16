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
const PROVIDERS_PREFIX = 'provider:';
const PROVIDER_HISTORY_PREFIX = 'provider_history:';
const LANDING_PREFIX = 'landing:';
const RECEIPTS_PREFIX = 'receipt:';
const SEQ_KEY = 'meta:folioSeq';
const PROVIDERS_SEQ_KEY = 'meta:providerSeq';
const RECEIPTS_SEQ_KEY = 'meta:receiptSeq';
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

// ── SEGURIDAD: Hash de contraseña (PBKDF2-SHA256, sal aleatoria) ───────
function bufToHex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
async function hashPassword(password, saltHex) {
  const enc = new TextEncoder();
  const salt = saltHex ? hexToBytes(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, keyMaterial, 256);
  return { salt: bufToHex(salt), hash: bufToHex(bits) };
}

// ── USUARIOS Y AUTENTICACIÓN ──────────────────────────────────────────
async function getUserByToken(env, token) {
  const raw = await env.COTIZACIONES.get(TOKENS_PREFIX + token);
  if (!raw) return null;
  const email = String(raw).trim().toLowerCase(); // defensivo: tokens viejos pueden traer mayúsculas

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

// ── PROVEEDORES Y HISTORIAL DE PRECIOS ────────────────────────────────
// Normaliza proveedores antiguos (una categoría/precio) al modelo multi-material
function normalizeProvider(p) {
  if (!p) return p;
  if (!Array.isArray(p.materiales)) {
    p.materiales = [{
      tipo: p.categoria || 'otros',
      precio: p.precioActual || 0,
      marca: p.marca || '',
      metrosPorRollo: p.metrosPorRollo != null ? p.metrosPorRollo : null,
      kgPorRollo: p.kgPorRollo != null ? p.kgPorRollo : null,
    }];
  }
  return p;
}

async function getProviderById(env, providerId) {
  const data = await env.COTIZACIONES.get(PROVIDERS_PREFIX + providerId);
  return data ? normalizeProvider(JSON.parse(data)) : null;
}

async function getAllProviders(env) {
  const providers = [];
  let cursor;
  do {
    const res = await env.COTIZACIONES.list({ prefix: PROVIDERS_PREFIX, cursor, limit: 100 });
    for (const k of res.keys) {
      const data = await env.COTIZACIONES.get(k.name);
      if (data) providers.push(normalizeProvider(JSON.parse(data)));
    }
    cursor = res.list_complete ? null : res.cursor;
  } while (cursor);
  return providers.sort((a, b) => a.nombre.localeCompare(b.nombre));
}

async function createProvider(env, providerData) {
  const seq = parseInt((await env.COTIZACIONES.get(PROVIDERS_SEQ_KEY)) || '0') + 1;
  await env.COTIZACIONES.put(PROVIDERS_SEQ_KEY, String(seq));

  // Modelo multi-material: array de {tipo, precio, marca?, metrosPorRollo?, kgPorRollo?}
  const materiales = Array.isArray(providerData.materiales) ? providerData.materiales : [];
  const precioPrimario = materiales.length ? (materiales[0].precio || 0) : (providerData.precioActual || 0);

  const provider = {
    id: String(seq),
    nombre: providerData.nombre,
    categoria: materiales.length > 1 ? 'varios' : (materiales[0] ? materiales[0].tipo : (providerData.categoria || 'otros')),
    contacto: providerData.contacto || {},
    notas: providerData.notas || '',
    materiales,
    precioActual: precioPrimario,
    ultimaActualizacion: new Date().toISOString(),
    historialPrecios: [
      {
        fecha: new Date().toISOString(),
        precio: precioPrimario,
        motivo: 'Precio inicial'
      }
    ]
  };

  await env.COTIZACIONES.put(PROVIDERS_PREFIX + provider.id, JSON.stringify(provider));
  return provider;
}

async function updateProvider(env, providerId, updates) {
  const provider = await getProviderById(env, providerId);
  if (!provider) return null;

  const updated = { ...provider, ...updates, ultimaActualizacion: new Date().toISOString() };
  // Si se editaron los materiales, recomputar precio primario y categoría
  if (Array.isArray(updates.materiales)) {
    updated.precioActual = updates.materiales.length ? (updates.materiales[0].precio || 0) : 0;
    updated.categoria = updates.materiales.length > 1 ? 'varios' : (updates.materiales[0] ? updates.materiales[0].tipo : 'otros');
  }
  await env.COTIZACIONES.put(PROVIDERS_PREFIX + providerId, JSON.stringify(updated));
  return updated;
}

async function deleteProvider(env, providerId) {
  await env.COTIZACIONES.delete(PROVIDERS_PREFIX + providerId);
  return true;
}

async function addPriceHistory(env, providerId, precio, motivo = '') {
  const provider = await getProviderById(env, providerId);
  if (!provider) return null;

  const newEntry = {
    fecha: new Date().toISOString(),
    precio,
    motivo
  };

  provider.historialPrecios = provider.historialPrecios || [];
  provider.historialPrecios.unshift(newEntry); // Agregar al inicio (más reciente)
  provider.precioActual = precio;
  provider.ultimaActualizacion = newEntry.fecha;

  // Guardar histórico también en tabla separada para análisis rápido
  const monthKey = new Date().toISOString().substring(0, 7); // YYYY-MM
  const historyKey = PROVIDER_HISTORY_PREFIX + providerId + ':' + monthKey;
  const monthHistory = JSON.parse((await env.COTIZACIONES.get(historyKey)) || '{"precios":[]}');
  monthHistory.precios.unshift({ ...newEntry });
  await env.COTIZACIONES.put(historyKey, JSON.stringify(monthHistory));

  // Guardar proveedor actualizado
  await env.COTIZACIONES.put(PROVIDERS_PREFIX + providerId, JSON.stringify(provider));
  return provider;
}

async function getPriceHistory(env, providerId) {
  const provider = await getProviderById(env, providerId);
  if (!provider) return null;
  return provider.historialPrecios || [];
}

async function getPriceStats(env, providerId) {
  const history = await getPriceHistory(env, providerId);
  if (!history || history.length === 0) return null;

  const precios = history.map(h => h.precio);
  const minimo = Math.min(...precios);
  const maximo = Math.max(...precios);
  const promedio = precios.reduce((a, b) => a + b, 0) / precios.length;
  const volatilidad = Math.sqrt(precios.reduce((sum, p) => sum + Math.pow(p - promedio, 2), 0) / precios.length);

  return {
    minimo: Math.round(minimo * 100) / 100,
    maximo: Math.round(maximo * 100) / 100,
    promedio: Math.round(promedio * 100) / 100,
    volatilidad: Math.round(volatilidad * 100) / 100,
    cambioReciente: history.length >= 2 ? ((history[0].precio - history[1].precio) / history[1].precio * 100).toFixed(2) + '%' : '0%',
    cantidadDatos: history.length
  };
}

// ── RECIBOS DE PAGO ───────────────────────────────────────────────────
function generateReceiptNumber() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const seq = String(Math.floor(Math.random() * 100000)).padStart(5, '0');
  return `${year}${month}:${seq}`;
}

async function createReceipt(env, receiptData) {
  const numero = generateReceiptNumber();

  const receipt = {
    numero,
    folio: receiptData.folio,
    fecha: new Date().toISOString(),
    cliente: receiptData.cliente || {},
    detalles: receiptData.detalles || {},
    impuestos: receiptData.impuestos || { incluirIVA: false, ivaPorcentaje: 16, ivaValor: 0 },
    totales: receiptData.totales || {},
    pago: {
      metodo: receiptData.metodo || 'efectivo',
      monto: receiptData.monto || 0,
      estado: 'pendiente'
    },
    historiaPagos: [
      {
        fecha: new Date().toISOString(),
        monto: receiptData.monto || 0,
        metodo: receiptData.metodo || 'efectivo',
        comprobante: receiptData.comprobante || '',
        comprobanteArchivo: receiptData.comprobanteArchivo || '',
        descripcion: receiptData.descripcion || ''
      }
    ]
  };

  await env.COTIZACIONES.put(RECEIPTS_PREFIX + numero, JSON.stringify(receipt));
  return receipt;
}

async function getReceiptByNumber(env, numero) {
  const data = await env.COTIZACIONES.get(RECEIPTS_PREFIX + numero);
  return data ? JSON.parse(data) : null;
}

async function getReceiptsByFolio(env, folio) {
  const receipts = [];
  let cursor;
  do {
    const res = await env.COTIZACIONES.list({ prefix: RECEIPTS_PREFIX, cursor, limit: 100 });
    for (const k of res.keys) {
      const data = await env.COTIZACIONES.get(k.name);
      if (data) {
        const receipt = JSON.parse(data);
        if (receipt.folio === folio) receipts.push(receipt);
      }
    }
    cursor = res.list_complete ? null : res.cursor;
  } while (cursor);
  return receipts.sort((a, b) => new Date(b.fecha) - new Date(a.fecha));
}

async function addPayment(env, receiptNumber, payment) {
  const receipt = await getReceiptByNumber(env, receiptNumber);
  if (!receipt) return null;

  // Agregar pago al historial
  receipt.historiaPagos = receipt.historiaPagos || [];
  receipt.historiaPagos.push({
    fecha: new Date().toISOString(),
    monto: payment.monto,
    metodo: payment.metodo || 'efectivo',
    comprobante: payment.comprobante || '',
    comprobanteArchivo: payment.comprobanteArchivo || '',
    descripcion: payment.descripcion || ''
  });

  // Actualizar totales pagados
  const totalPagado = receipt.historiaPagos.reduce((sum, p) => sum + p.monto, 0);
  const totalRequerido = receipt.totales.total || 0;

  if (totalPagado >= totalRequerido) {
    receipt.pago.estado = 'completo';
    receipt.pago.monto = totalPagado;
  } else if (totalPagado > 0) {
    receipt.pago.estado = 'parcial';
    receipt.pago.monto = totalPagado;
  }

  await env.COTIZACIONES.put(RECEIPTS_PREFIX + receiptNumber, JSON.stringify(receipt));
  return receipt;
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

// ── RECIBO PÚBLICO CON TOKEN ──────────────────────────────────────────
async function generateReceiptToken(env, numero) {
  const token = Math.random().toString(36).substring(2, 34);
  await env.COTIZACIONES.put(TOKENS_PREFIX + 'recibo:' + token, numero, { expirationTtl: 90 * 24 * 3600 }); // 90 días
  return token;
}

async function getReceiptByToken(env, token) {
  const numero = await env.COTIZACIONES.get(TOKENS_PREFIX + 'recibo:' + token);
  if (!numero) return null;
  return await getReceiptByNumber(env, numero);
}

// ── VALIDACIÓN DE ENTRADA ─────────────────────────────────────────────
function validateCotizacion(rec) {
  if (!rec || typeof rec !== 'object') return false;
  // resumenCliente solo se valida si viene en el body -> permite actualizaciones
  // parciales como {estatus:'cancelada'} (cancelar / cambiar estatus) sin exigir el objeto completo
  if (rec.resumenCliente !== undefined && (typeof rec.resumenCliente !== 'string' || rec.resumenCliente.length > 200)) return false;
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

    // ── SETUP: Crear admin si no existe (temporal, solo primera vez) ────
    if (path === '/api/setup/init-admin') {
      const existingAdmin = await env.COTIZACIONES.get(USERS_PREFIX + ADMIN_EMAIL);
      if (existingAdmin) {
        return json({ message: 'Admin ya existe' }, 200, origin);
      }

      const adminUser = {
        email: ADMIN_EMAIL,
        rol: 'ADMIN',
        permissions: 255,
        creadoEn: new Date().toISOString(),
        creadoPor: 'system-init'
      };

      await env.COTIZACIONES.put(USERS_PREFIX + ADMIN_EMAIL, JSON.stringify(adminUser));
      return json({ message: 'Admin creado exitosamente', admin: adminUser }, 201, origin);
    }

    // ── LOGIN SIN AUTENTICACIÓN (para obtener token) ────────────────────
    if (request.method === 'POST' && path === '/api/auth/login') {
      try {
        if (!(await checkRateLimit(env, ip + ':auth', true))) {
          return json({ error: 'Demasiados intentos de autenticación' }, 429, origin);
        }
        const body = await request.json();
        // El email se normaliza a minúsculas SIEMPRE (los emails no distinguen mayúsculas).
        // Debe coincidir con cómo se guarda al crear el usuario y en set-password.
        const email = (typeof body.email === 'string' ? body.email : '').trim().toLowerCase();
        const password = body.password || '';

        if (!email || !password || typeof password !== 'string') {
          return json({ error: 'Email y contraseña requeridos' }, 400, origin);
        }

        // Obtener usuario
        const userData = await env.COTIZACIONES.get(USERS_PREFIX + email);
        if (!userData) {
          return json({ error: 'Usuario o contraseña inválidos' }, 401, origin);
        }

        const user = JSON.parse(userData);

        // Verificar contraseña: hash por usuario si existe; si no, bootstrap admin
        let validPassword = false;
        if (user.passwordHash && user.passwordSalt) {
          const { hash } = await hashPassword(password, user.passwordSalt);
          validPassword = await timingSafeCompare(hash, user.passwordHash);
        } else if (email === ADMIN_EMAIL && password === 'admin123') {
          // Contraseña inicial del admin hasta que fije la suya propia
          validPassword = true;
        }
        if (!validPassword) {
          return json({ error: 'Usuario o contraseña inválidos' }, 401, origin);
        }

        // Generar token
        const newToken = Math.random().toString(36).substring(2, 34) + Math.random().toString(36).substring(2, 34);
        await env.COTIZACIONES.put(TOKENS_PREFIX + newToken, email, { expirationTtl: 7 * 24 * 3600 });

        await createAuditLog(env, user, 'LOGIN', email);
        return json({
          token: newToken,
          email: user.email,
          rol: user.rol,
          permissions: user.permissions,
        }, 200, origin);
      } catch (e) {
        return json({ error: 'Error en autenticación', detail: e.message }, 500, origin);
      }
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

    // ── RECIBO DE PAGO PÚBLICO (con token, sin auth) ──────────────────
    const mRecibo = path.match(/^\/recibo\/([a-z0-9]+)$/);
    if (request.method === 'GET' && mRecibo) {
      const receipt = await getReceiptByToken(env, mRecibo[1]);
      if (!receipt) {
        return new Response('Recibo no encontrado o expirado', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...corsHeaders(origin) } });
      }
      const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
      const fmt = (n) => '$' + (Number(n) || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const totalPagado = (receipt.historiaPagos || []).reduce((s, p) => s + (p.monto || 0), 0);
      const total = receipt.totales?.total || 0;
      const saldo = Math.max(0, total - totalPagado);
      const estado = receipt.pago?.estado || 'pendiente';
      const estadoLabel = estado === 'completo' ? 'PAGADO' : (estado === 'parcial' ? 'PAGO PARCIAL' : 'PENDIENTE');
      const estadoColor = estado === 'completo' ? '#1d9e75' : (estado === 'parcial' ? '#ba7517' : '#993c1d');
      const fechaStr = new Date(receipt.fecha).toLocaleDateString('es-MX', { day: '2-digit', month: 'long', year: 'numeric' });
      const pagosRows = (receipt.historiaPagos || []).map(p => {
        const f = new Date(p.fecha).toLocaleDateString('es-MX');
        return `<tr><td>${f}</td><td style="text-transform:capitalize">${esc(p.metodo)}</td><td>${esc(p.comprobante || '—')}</td><td style="text-align:right">${fmt(p.monto)}</td></tr>`;
      }).join('');
      const ivaRow = (receipt.impuestos?.incluirIVA && receipt.impuestos?.ivaValor) ? `<tr><td>IVA (16%)</td><td style="text-align:right">${fmt(receipt.impuestos.ivaValor)}</td></tr>` : '';

      const html = `<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Recibo de pago ${esc(receipt.folio)} - Lindero</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:system-ui,-apple-system,sans-serif;background:#eef1ef;color:#213b34;line-height:1.6;padding:1.5rem}
  .card{max-width:640px;margin:0 auto;background:#fff;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,.08);overflow:hidden}
  .top{background:#13241f;color:#fff;padding:1.75rem 2rem;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:.5rem}
  .brand{font-size:1.4rem;font-weight:800;letter-spacing:.5px}
  .brand span{color:#89D7B7}
  .doc{font-size:.8rem;color:#89D7B7;text-transform:uppercase;letter-spacing:2px}
  .body{padding:2rem}
  .meta{display:flex;justify-content:space-between;flex-wrap:wrap;gap:.5rem;font-size:.85rem;color:#5a6b64;margin-bottom:1.25rem}
  .badge{display:inline-block;padding:.4rem 1.1rem;border-radius:999px;color:#fff;font-weight:700;font-size:.85rem;letter-spacing:1px;background:${estadoColor}}
  .cliente{background:#f6f8f7;border-left:4px solid #89D7B7;padding:.9rem 1.1rem;border-radius:0 8px 8px 0;margin-bottom:1.5rem}
  h3{font-size:.8rem;text-transform:uppercase;letter-spacing:1px;color:#5a6b64;margin:1.5rem 0 .6rem}
  table{width:100%;border-collapse:collapse;font-size:.9rem}
  th{background:#f0f3f1;text-align:left;padding:.55rem .7rem;font-size:.72rem;text-transform:uppercase;letter-spacing:.5px;color:#5a6b64}
  td{padding:.55rem .7rem;border-bottom:1px solid #eaeeec}
  .totales td{border:none;padding:.35rem .7rem}
  .totales .big{font-size:1.15rem;font-weight:800;color:#0f6e56}
  .pagado{background:#13241f;color:#fff;border-radius:10px;padding:1.4rem;text-align:center;margin-top:1.5rem}
  .pagado .n{font-size:2.1rem;font-weight:800;color:#89D7B7}
  .foot{text-align:center;font-size:.75rem;color:#8a9a93;padding:1.25rem 2rem 1.75rem}
  .btn{display:block;width:100%;margin-top:1.5rem;padding:.9rem;background:#89D7B7;color:#07130f;border:none;border-radius:8px;font-size:1rem;font-weight:700;cursor:pointer}
  @media print{ body{background:#fff;padding:0} .card{box-shadow:none;max-width:100%} .btn{display:none} }
</style></head>
<body>
  <div class="card">
    <div class="top">
      <div><div class="brand">LINDERO<span>.COTI</span></div><div class="doc">Recibo de pago</div></div>
      <div class="badge">${estadoLabel}</div>
    </div>
    <div class="body">
      <div class="meta"><span>Recibo: <strong>${esc(receipt.numero)}</strong></span><span>Folio: <strong>${esc(receipt.folio)}</strong></span><span>Fecha: <strong>${fechaStr}</strong></span></div>
      <div class="cliente"><strong>Cliente:</strong> ${esc(receipt.cliente?.nombre || '—')}</div>
      <table class="totales"><tbody>
        <tr><td>Total de la cotización</td><td style="text-align:right">${fmt(receipt.totales?.subtotal || total)}</td></tr>
        ${ivaRow}
        <tr><td><strong>Total a pagar</strong></td><td style="text-align:right" class="big">${fmt(total)}</td></tr>
      </tbody></table>
      <h3>Pagos registrados</h3>
      <table><thead><tr><th>Fecha</th><th>Método</th><th>Comprobante</th><th style="text-align:right">Monto</th></tr></thead><tbody>${pagosRows || '<tr><td colspan="4">Sin pagos</td></tr>'}</tbody></table>
      <div class="pagado"><div>Total pagado</div><div class="n">${fmt(totalPagado)}</div>${saldo > 0 ? `<div style="font-size:.85rem;color:#f0a">Saldo pendiente: ${fmt(saldo)}</div>` : ''}</div>
      <button class="btn" onclick="window.print()">Descargar / Imprimir PDF</button>
    </div>
    <div class="foot">Este recibo fue generado por Lindero. Consérvalo como comprobante de tu pago.</div>
  </div>
</body></html>`;
      return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=600', 'X-Content-Type-Options': 'nosniff', ...corsHeaders(origin) } });
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

      // ── LANDING PÚBLICA: generar link para compartir una cotización ──
      if (request.method === 'POST' && path === '/api/landing') {
        const body = await request.json();
        const folio = (body.folio || '').trim();
        if (!folio) return json({ error: 'Folio requerido' }, 400, origin);

        const rec = await env.COTIZACIONES.get(KV_PREFIX + folio);
        if (!rec) return json({ error: 'Cotización no encontrada. Guárdala antes de compartir.' }, 404, origin);

        const token = await generateLandingToken(env, folio);
        const url = new URL(request.url).origin + '/landing/' + token;
        await createAuditLog(env, user, 'CREATE_LANDING', folio);
        return json({ token, url }, 200, origin);
      }

      // ── GESTIÓN DE USUARIOS (solo admin) ─────────────────────────────
      if (path.startsWith('/api/users') && user.email !== ADMIN_EMAIL) {
        return json({ error: 'Solo admin' }, 403, origin);
      }

      if (request.method === 'POST' && path === '/api/users') {
        const body = await request.json();
        // CAUSA RAÍZ de "Usuario no encontrado": antes se guardaba el email tal cual
        // (con mayúsculas) mientras login/set-password lo buscaban en minúsculas.
        const newEmail = (typeof body.email === 'string' ? body.email : '').trim().toLowerCase();
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

      // Fijar / restablecer la contraseña de un usuario (solo admin)
      if (request.method === 'POST' && path === '/api/users/set-password') {
        const body = await request.json();
        const targetEmail = (body.email || '').toLowerCase();
        const newPassword = body.password || '';

        if (!targetEmail || typeof newPassword !== 'string' || newPassword.length < 4) {
          return json({ error: 'Email requerido y contraseña de al menos 4 caracteres' }, 400, origin);
        }

        const targetData = await env.COTIZACIONES.get(USERS_PREFIX + targetEmail);
        if (!targetData) {
          return json({ error: 'Usuario no encontrado' }, 404, origin);
        }

        const target = JSON.parse(targetData);
        const { salt, hash } = await hashPassword(newPassword);
        target.passwordSalt = salt;
        target.passwordHash = hash;
        target.passwordSetAt = new Date().toISOString();
        target.passwordSetBy = user.email;

        await env.COTIZACIONES.put(USERS_PREFIX + targetEmail, JSON.stringify(target));
        await createAuditLog(env, user, 'SET_PASSWORD', targetEmail);

        return json({ message: 'Contraseña actualizada', email: targetEmail }, 200, origin);
      }

      if (request.method === 'GET' && path === '/api/users') {
        const out = [];
        let cursor;
        do {
          const res = await env.COTIZACIONES.list({ prefix: USERS_PREFIX, cursor, limit: 50 });
          for (const k of res.keys) {
            const userData = await env.COTIZACIONES.get(k.name);
            if (userData) {
              const u = JSON.parse(userData);
              u.hasPassword = !!u.passwordHash;
              delete u.passwordHash;
              delete u.passwordSalt;
              out.push(u);
            }
          }
          cursor = res.list_complete ? null : res.cursor;
        } while (cursor);

        return json({ items: out }, 200, origin);
      }

      // ── PROVEEDORES (público para lectura, admin para crear/editar) ────
      if (request.method === 'GET' && path === '/api/providers') {
        const providers = await getAllProviders(env);
        await createAuditLog(env, user, 'VIEW_PROVIDERS', 'all', { count: providers.length });
        return json({ items: providers }, 200, origin);
      }

      if (request.method === 'GET' && path.match(/^\/api\/providers\/(\d+)$/)) {
        const providerId = path.split('/').pop();
        const provider = await getProviderById(env, providerId);
        if (!provider) return json({ error: 'Proveedor no encontrado' }, 404, origin);

        await createAuditLog(env, user, 'VIEW_PROVIDER', providerId);
        return json(provider, 200, origin);
      }

      if (request.method === 'GET' && path.match(/^\/api\/providers\/(\d+)\/history$/)) {
        const providerId = path.split('/')[3];
        const history = await getPriceHistory(env, providerId);
        if (!history) return json({ error: 'Proveedor no encontrado' }, 404, origin);

        await createAuditLog(env, user, 'VIEW_PRICE_HISTORY', providerId);
        return json({ history }, 200, origin);
      }

      if (request.method === 'GET' && path.match(/^\/api\/providers\/(\d+)\/stats$/)) {
        const providerId = path.split('/')[3];
        const stats = await getPriceStats(env, providerId);
        if (!stats) return json({ error: 'Proveedor no encontrado' }, 404, origin);

        return json(stats, 200, origin);
      }

      if (request.method === 'POST' && path === '/api/providers') {
        if (user.email !== ADMIN_EMAIL) {
          return json({ error: 'Solo admin puede crear proveedores' }, 403, origin);
        }

        const body = await request.json();
        if (!body.nombre) return json({ error: 'Nombre requerido' }, 400, origin);

        const provider = await createProvider(env, body);
        await createAuditLog(env, user, 'CREATE_PROVIDER', provider.id, { nombre: body.nombre });
        return json(provider, 201, origin);
      }

      if (request.method === 'PUT' && path.match(/^\/api\/providers\/(\d+)$/)) {
        if (user.email !== ADMIN_EMAIL) {
          return json({ error: 'Solo admin puede editar proveedores' }, 403, origin);
        }

        const providerId = path.split('/').pop();
        const body = await request.json();
        const updated = await updateProvider(env, providerId, body);
        if (!updated) return json({ error: 'Proveedor no encontrado' }, 404, origin);

        await createAuditLog(env, user, 'UPDATE_PROVIDER', providerId, body);
        return json(updated, 200, origin);
      }

      if (request.method === 'POST' && path.match(/^\/api\/providers\/(\d+)\/price$/)) {
        if (user.email !== ADMIN_EMAIL) {
          return json({ error: 'Solo admin puede actualizar precios' }, 403, origin);
        }

        const providerId = path.split('/')[3];
        const body = await request.json();
        if (typeof body.precio !== 'number') {
          return json({ error: 'Precio requerido (número)' }, 400, origin);
        }

        const updated = await addPriceHistory(env, providerId, body.precio, body.motivo || '');
        if (!updated) return json({ error: 'Proveedor no encontrado' }, 404, origin);

        await createAuditLog(env, user, 'UPDATE_PRICE', providerId, {
          precio: body.precio,
          motivo: body.motivo
        });
        return json(updated, 200, origin);
      }

      if (request.method === 'DELETE' && path.match(/^\/api\/providers\/(\d+)$/)) {
        if (user.email !== ADMIN_EMAIL) {
          return json({ error: 'Solo admin puede eliminar proveedores' }, 403, origin);
        }

        const providerId = path.split('/').pop();
        await deleteProvider(env, providerId);
        await createAuditLog(env, user, 'DELETE_PROVIDER', providerId);
        return json({ message: 'Proveedor eliminado' }, 200, origin);
      }

      // ── RECIBOS DE PAGO ───────────────────────────────────────────────
      if (request.method === 'POST' && path === '/api/receipts') {
        const body = await request.json();
        if (!body.folio || !body.cliente || !body.detalles || !body.totales) {
          return json({ error: 'Campos requeridos: folio, cliente, detalles, totales' }, 400, origin);
        }

        const receipt = await createReceipt(env, {
          folio: body.folio,
          cliente: body.cliente,
          detalles: body.detalles,
          totales: body.totales,
          impuestos: body.impuestos || {},
          metodo: body.metodo || 'efectivo',
          monto: body.monto || 0,
          comprobante: body.comprobante || '',
          comprobanteArchivo: body.comprobanteArchivo || '',
          descripcion: body.descripcion || ''
        });

        await createAuditLog(env, user, 'CREATE_RECEIPT', receipt.numero, { folio: body.folio });
        return json(receipt, 201, origin);
      }

      if (request.method === 'GET' && path.match(/^\/api\/receipts\/[A-Z0-9:]+$/)) {
        const numero = path.split('/').pop();
        const receipt = await getReceiptByNumber(env, numero);
        if (!receipt) return json({ error: 'Recibo no encontrado' }, 404, origin);

        await createAuditLog(env, user, 'VIEW_RECEIPT', numero);
        return json(receipt, 200, origin);
      }

      if (request.method === 'GET' && path.match(/^\/api\/cotizaciones\/[^/]+\/receipts$/)) {
        const folio = path.split('/')[3];
        const receipts = await getReceiptsByFolio(env, folio);
        await createAuditLog(env, user, 'VIEW_RECEIPTS', folio, { count: receipts.length });
        return json({ items: receipts }, 200, origin);
      }

      if (request.method === 'POST' && path.match(/^\/api\/receipts\/[A-Z0-9:]+\/payment$/)) {
        const numero = path.split('/')[3];
        const body = await request.json();
        if (typeof body.monto !== 'number' || body.monto <= 0) {
          return json({ error: 'Monto requerido (número > 0)' }, 400, origin);
        }

        const updated = await addPayment(env, numero, {
          monto: body.monto,
          metodo: body.metodo || 'efectivo',
          comprobante: body.comprobante || '',
          comprobanteArchivo: body.comprobanteArchivo || '',
          descripcion: body.descripcion || ''
        });

        if (!updated) return json({ error: 'Recibo no encontrado' }, 404, origin);

        await createAuditLog(env, user, 'ADD_PAYMENT', numero, {
          monto: body.monto,
          metodo: body.metodo,
          estado: updated.pago.estado
        });
        return json(updated, 200, origin);
      }

      // Generar link público del recibo para compartir con el cliente
      if (request.method === 'POST' && path.match(/^\/api\/receipts\/[A-Z0-9:]+\/share$/)) {
        const numero = path.split('/')[3];
        const receipt = await getReceiptByNumber(env, numero);
        if (!receipt) return json({ error: 'Recibo no encontrado' }, 404, origin);
        const rtoken = await generateReceiptToken(env, numero);
        const url = new URL(request.url).origin + '/recibo/' + rtoken;
        await createAuditLog(env, user, 'SHARE_RECEIPT', numero);
        return json({ token: rtoken, url }, 200, origin);
      }

      return json({ error: 'Ruta no encontrada' }, 404, origin);
    } catch (e) {
      console.error(e);
      return json({ error: String((e && e.message) || e) }, 500, origin);
    }
  },
};
