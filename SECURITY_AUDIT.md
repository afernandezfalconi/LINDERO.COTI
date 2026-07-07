# Auditoría de Seguridad - LINDERO.COTI

**Fecha:** 2026-07-06  
**Versión:** 4.00

---

## 🔴 CRÍTICOS (Remediar inmediatamente)

### 1. **Landing Pages Sin Autenticación - Information Disclosure**
**Severidad:** CRÍTICA  
**Ubicación:** `GET /landing/:folio` (Worker)

**Problema:**
- Cualquier persona con el folio puede ver la cotización completa
- No hay validación de acceso - cualquiera puede enumerar folios (COT-001, COT-002, etc.)
- Exposición de cliente, ubicación, detalles técnicos

**Impacto:**
- Competencia puede ver tus cotizaciones
- Clientes pueden comparar precios entre cotizaciones
- Información de ubicación de propiedades expuesta

**Soluciones:**
1. Agregar token único (UUID) por cotización en lugar de folio
2. Generar token aleatorio de 32 caracteres al exportar
3. Guardar relación folio → token en KV
4. Validar token antes de mostrar landing
5. Opcionalmente: expiración de token (7-30 días)

---

### 2. **Contraseña Almacenada en localStorage (XSS Vulnerability)**
**Severidad:** CRÍTICA  
**Ubicación:** `index.html` líneas 1729-1730, 1742

**Problema:**
```javascript
function getAppPassword(){ return localStorage.getItem(PW_KEY)||''; }
function setAppPassword(pw){ localStorage.setItem(PW_KEY, pw); }
```

- Contraseña en localStorage es accesible via XSS
- Si hay XSS en cualquier script (CDN comprometida, inyección, etc.), atacante obtiene contraseña
- localStorage persiste, no hay expiración

**Impacto:**
- Acceso completo a todas las cotizaciones
- Capacidad de crear/editar/eliminar cotizaciones
- Cambio de contraseña

**Soluciones:**
1. Usar sessionStorage en lugar de localStorage (se limpia al cerrar navegador)
2. Implementar session tokens con expiración (ej: 1 hora)
3. Agregar logout automático después de inactividad
4. Hash de la contraseña (nunca guardar plaintext)
5. HTTP-only cookies (si es posible en Cloudflare Pages)

---

### 3. **Validación Insuficiente en Backend**
**Severidad:** CRÍTICA  
**Ubicación:** `worker/src/index.js` líneas 202-222

**Problema:**
```javascript
const body = await request.json();
const rec = { ...prev, ...body };  // Spread directo sin sanitizar
```

- No hay validación de tipos
- No hay límites en tamaño de objetos
- Inyección de propiedades arbitrarias
- Sin límite en campos de texto

**Impacto:**
- Inyección de código/malware en descripciones
- Deformación de datos
- DoS por payload grande

**Soluciones:**
1. Validación estricta de esquema (ej: Zod, Joi)
2. Whitelist de campos permitidos
3. Límite de tamaño por campo
4. Sanitización de strings

---

### 4. **Comparación de Contraseña con Timing Attack Mitigable**
**Severidad:** MEDIA-ALTA  
**Ubicación:** `worker/src/index.js` líneas 50-58

**Problema:**
```javascript
// Comparación en tiempo (casi) constante
if (!expected || pw.length !== expected.length) return false;
```

- La verificación de longitud es "casi" constante pero NO ES constante
- `pw.length !== expected.length` early-return revela longitud de contraseña
- Atacante puede descubrir longitud por timing

**Impacto:**
- Reducción del espacio de búsqueda para fuerza bruta
- Leak de metadata de la contraseña

**Soluciones:**
1. Usar crypto.subtle.timingSafeEqual() (Web Crypto API)
2. Siempre comparar longitud fija
3. No permitir early returns basados en longitud

---

## 🟡 ALTOS (Importante remediar)

### 5. **Comprobantes en Base64 - Información Sensible**
**Severidad:** ALTO  
**Ubicación:** `worker/src/index.js` líneas 243-249

**Problema:**
- Comprobantes (fotos de pago) guardados como base64 en plaintext en KV
- Sin encriptación
- Accesibles vía API si alguien obtiene folio

**Impacto:**
- Fotos de comprobantes/recibos expuestas
- Información financiera
- Si se comparten landing pages, los comprobantes podrían estar accesibles

**Soluciones:**
1. Encriptar comprobantes antes de guardar (ej: AES-256-GCM)
2. Guardar en R2 (Cloudflare's object storage) en lugar de KV
3. Generar URLs con token para descargar
4. Expiración de acceso (ej: 30 días)
5. Validar que solo el dueño de la cotización pueda descargar

---

### 6. **Rate Limiting Ausente**
**Severidad:** ALTO  
**Ubicación:** Worker global

**Problema:**
- Sin protección contra fuerza bruta de contraseña
- Sin límite de requests por IP
- Sin límite en cambio de contraseña
- Vulnerable a DoS

**Impacto:**
- Atacante puede probar contraseñas sin restricción
- Consumo de recursos
- Disponibilidad comprometida

**Soluciones:**
1. Implementar rate limiting por IP (ej: 5 intentos/min para auth)
2. Usar Cloudflare Rate Limiting
3. Bloqueo temporal después de N fallos
4. Logging de intentos fallidos

---

### 7. **CORS Demasiado Permisivo**
**Severidad:** ALTO  
**Ubicación:** `worker/src/index.js` líneas 18-34

**Problema:**
```javascript
const ALLOWED_ORIGINS = [
  'https://afernandezfalconi.github.io',  // OK
  'http://localhost:3003',                 // Desarrollo - OK
  'http://127.0.0.1:3003',                 // Desarrollo - OK
];
```

- Solo hay un origen en producción
- Si GitHub Pages es comprometido, acceso total
- No hay verificación de subdominios

**Impacto:**
- XSS en GitHub Pages = robo de datos
- CSRF potencial

**Soluciones:**
1. Verificar origen estrictamente
2. No incluir localhost en producción
3. Considerar certificado de acceso específico por sesión
4. Implementar CSRF token para modificaciones

---

### 8. **No Hay Auditoría/Logging de Acciones**
**Severidad:** ALTO  
**Ubicación:** Worker

**Problema:**
- Sin logging de quién accedió/modificó qué
- Sin auditoría de cambios
- Imposible detectar acceso no autorizado
- Imposible recuperarse de errores

**Impacto:**
- No hay trazabilidad
- Imposible investigar incidentes
- Cumplimiento regulatorio

**Soluciones:**
1. Loguear todas las acciones (CREATE, UPDATE, DELETE)
2. Guardar IP, timestamp, usuario (contraseña hash no plaintext)
3. Guardar valor anterior y nuevo para ediciones
4. Retener logs por 90+ días
5. Alertar en cambios sospechosos (muchos cambios en corto tiempo)

---

## 🟠 MEDIOS (Considerar)

### 9. **Validación de Entrada Insuficiente en Frontend**
**Severidad:** MEDIO  
**Ubicación:** `index.html` - Formulario

**Problema:**
- Inputs numéricos sin validación de rango
- Sin sanitización de strings
- Sin escaping de HTML en output

**Impacto:**
- XSS almacenado si datos se muestran sin escaping
- Datos inválidos en base de datos

**Soluciones:**
1. Validar rango de números (ej: perímetro > 0)
2. Escapar HTML en landing page
3. Validar formato de fechas
4. Limitar longitud de strings

---

### 10. **Sesión Sin Expiración**
**Severidad:** MEDIO  
**Ubicación:** Frontend

**Problema:**
- localStorage persiste indefinidamente
- Sin timeout de sesión
- Computadora desatendida = acceso permanente

**Impacto:**
- Riesgo en computadoras compartidas
- Largo período de exposición

**Soluciones:**
1. Logout automático después de 30-60 min de inactividad
2. Usar sessionStorage (auto-limpia)
3. Mostrar advertencia antes de logout
4. Extender sesión en actividad

---

### 11. **API Expone Metadata Innecesaria**
**Severidad:** MEDIO  
**Ubicación:** `GET /api/cotizaciones`

**Problema:**
```javascript
return { items: out }  // Retorna todos los folios, clientes, totales
```

- Lista completa de cotizaciones (aunque sin detalles)
- Puede revelar patrones de negocio
- Información de clientes expuesta

**Impacto:**
- Leak de información de negocio
- Privacidad de clientes

**Soluciones:**
1. Paginar resultados (ej: 20 por página)
2. Limitar información en lista (solo folio, no cliente)
3. Filtrar por rango de fechas
4. Opcional: requerer contraseña para listar

---

### 12. **Falta Validación de Content-Type**
**Severidad:** MEDIO  
**Ubicación:** Worker

**Problema:**
- Acepta `application/json` pero no valida
- No rechaza otros content-types
- Sin límite de payload

**Impacto:**
- Inyección de tipos incorrectos
- Posible DoS por payload grande

**Soluciones:**
1. Validar Content-Type antes de parsear
2. Configurar límite máximo de payload (ej: 1MB)
3. Rechazar requests sin Content-Type requerido

---

## 🟢 BAJOS (Mejoras)

### 13. **Contraseña Muy Corta (Mínimo 4 caracteres)**
**Severidad:** BAJO  
**Ubicación:** `worker/src/index.js` línea 142

- Mínimo de 4 caracteres es muy débil
- Sugiere: mínimo 12-16 caracteres
- Requiere mayúsculas, números, símbolos

---

### 14. **JSON.parse Sin Try-Catch en Algunos Lugares**
**Severidad:** BAJO  
**Ubicación:** Varios

- Algunos JSON.parse() no tienen manejo de error
- Podría causar crashes

---

### 15. **Secrets en Wrangler.toml**
**Severidad:** BAJO  
**Ubicación:** Si existe `wrangler.toml`

- Verificar que APP_PASSWORD no esté en control de versiones
- Usar variables de entorno seguras

---

## 📋 Plan de Remediación Recomendado

### Fase 1 (CRÍTICA - Esta semana):
1. ✅ Implementar tokens únicos para landing pages (no usar folio)
2. ✅ Migrar contraseña a sessionStorage
3. ✅ Validación estricta en backend
4. ✅ Implementar rate limiting

### Fase 2 (ALTA - Próximas 2 semanas):
5. ✅ Encriptar comprobantes o mover a R2
6. ✅ Agregar logging/auditoría
7. ✅ Corregir timing attack en comparación de contraseña
8. ✅ Mejorar CORS

### Fase 3 (MEDIO - Próximo mes):
9. ✅ Sesión con timeout
10. ✅ Validación de entrada mejorada
11. ✅ Content-Type validation
12. ✅ Política de longitud de contraseña

---

## 🔐 Checklist de Seguridad

- [ ] Landing pages con tokens únicos (no folio)
- [ ] Contraseña en sessionStorage, no localStorage
- [ ] Validación de esquema en backend
- [ ] Rate limiting implementado
- [ ] Comprobantes encriptados o en R2
- [ ] Logging de auditoría completo
- [ ] Timing attack fix en auth
- [ ] CORS restringido
- [ ] Logout automático por inactividad
- [ ] Validación de entrada frontend
- [ ] Content-Type validation
- [ ] Mínimo 12 caracteres en contraseña
- [ ] HTTPS forzado (verificar headers)
- [ ] CSP headers configurados
- [ ] X-Frame-Options configurado
- [ ] X-Content-Type-Options configurado

