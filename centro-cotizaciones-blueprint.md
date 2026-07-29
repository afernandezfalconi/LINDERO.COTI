# Centro de Cotizaciones (LINDERO.COTI) — Blueprint

> Generado por The Architect el 2026-07-29
> Archetype: Internal Tool / Panel de control (feature dentro de una app existente)
> Proyecto base: **LINDERO.COTI** — cotizador PWA de cercado (un solo `index.html` + Cloudflare Worker + KV)

---

## 0. Contexto para el constructor (LEE ESTO PRIMERO)

Esto **no es un proyecto nuevo**: es una **feature** dentro de LINDERO.COTI, una app en producción. NO cambies el stack ni reescribas nada existente. Solo agregas:
1. Un **panel nuevo** ("Centro de Cotizaciones") en el `index.html`.
2. Un **endpoint de resumen liviano** + **denormalización de banderas** en la metadata de KV en el Worker.
3. Endpoints on-demand para traer imágenes pesadas (comprobantes, firma) solo al hacer clic.

**Ubicaciones reales:**
- Frontend: `index.html` (un solo archivo, vanilla JS, sin build). Deploy: GitHub Pages (`afernandezfalconi/LINDERO.COTI`, rama `main`).
- Backend: `worker/src/index.js`. Deploy: `cd worker && npx wrangler@4 deploy`.
- KV namespace: `COTIZACIONES` (id `c908b73db898406f88532f448a5198f9`).
- API base: `https://lindero-coti-api.lindero-coti.workers.dev`.
- Local: `python -m http.server 3003` (el Worker permite CORS solo en 3003 y en `afernandezfalconi.github.io`).

**⚠️ Gotchas obligatorios (ya nos mordieron):**
- El JS de cliente que vive dentro del *template literal* de la landing del Worker (`` const html = `...` ``) NO puede usar `\/` en regex (el `\/` se convierte en `/` y rompe el `<script>` entero), ni `${}`, ni `</script>` literal. Usa comparación de strings. **Valida siempre** el `<script>` servido con `node --check`.
- En Windows, **nunca** pipear `wrangler kv key get | python` (corrompe UTF-8 a CP1252). Usa redirección a archivo (`> archivo.json`) y lee con `encoding='utf-8'`.
- **Nunca borres una clave de KV antes de confirmar la escritura** de su reemplazo.
- No uses `sed` para editar HTML/JS en Windows.
- KV es **eventual-consistente**: al testear write→read, espera ~3s.

---

## 1. Project Overview

### Vision
Hoy, para verificar si una cotización está pagada, si tiene comprobante, si ya se le generó recibo al cliente o si el cliente firmó la autorización, el vendedor debe **abrir cada cotización una por una**. El **Centro de Cotizaciones** es un panel único donde, con filtros y de un vistazo, se ve el estado de pago de todas las cotizaciones y, con un clic en iconos, se consultan el/los comprobante(s), el recibo compartible y la firma del cliente — sin abrir cada una.

### Goals
- Ver el estado de pago/firma/recibo de **todas** las cotizaciones en una sola tabla con filtros y búsqueda.
- Consultar comprobantes (del vendedor y del cliente), firma de autorización y recibo **on-demand** (clic en icono), sin cargar imágenes pesadas al listar.
- Escalar a **cientos/miles** de cotizaciones sin volverse lento.
- Generar el recibo compartible para una cotización pagada que aún no lo tenga, desde el mismo panel.

### Success Metrics
- El panel carga la lista completa (cientos de filas) en **< 1s** (una sola llamada, sin imágenes).
- Verificar el estado de pago de N cotizaciones pasa de "abrir N modales" a **0 aperturas** (todo en la fila).
- Cero regresiones en el flujo existente de cotizar / pagar / firmar.

---

## 2. Tech Stack (FIJO — no cambiar)

| Capa | Tecnología | Por qué |
|---|---|---|
| Frontend | HTML/CSS/JS **vanilla**, un solo `index.html`, sin build | Es lo que ya existe; PWA instalable; despliegue trivial en GitHub Pages |
| Backend | **Cloudflare Worker** (`worker/src/index.js`) | Ya existe; edge, barato, sin servidor que mantener |
| Datos | **Cloudflare KV** (`COTIZACIONES`) | Ya existe; clave-valor con *metadata* por clave (clave para este diseño) |
| Auth | Token propio (`X-Auth-Token` + `X-User-Email`) + PBKDF2 | Ya existe; usuarios por email con permisos |
| Gráficas | Chart.js 4.4.1 (CDN) | Ya presente (Finanzas) |
| Iconos | `@tabler/icons-webfont` 3.34.1 (CDN) | Ya presente (estética HUD) |
| Hosting FE | GitHub Pages (fork `afernandezfalconi/LINDERO.COTI`) | Ya configurado |
| Deploy Worker | `npx wrangler@4 deploy` | Ya configurado |

---

## 3. Directory Structure (lo que se toca)

```
LINDERO.COTI/
  index.html                 # ← se AGREGA: modal "Centro de Cotizaciones" (HTML+CSS+JS) y botón en el header
  worker/
    src/index.js             # ← se AGREGA: computeFlags(), endpoint /resumen, /aceptacion,
                             #    /generar-recibo, migración; y se ACTUALIZA putRecord()/createReceipt()/
                             #    addPayment()/ruta aceptar para escribir banderas en metadata
    wrangler.toml            # sin cambios
  centro-cotizaciones-blueprint.md   # este archivo
```

No hay estructura nueva de carpetas: todo vive en los dos archivos existentes, respetando el estilo actual.

---

## 4. Data Model

### 4.1 Registro de cotización (`cot:COT-###`) — ya existe
Campos relevantes (el objeto completo `rec`):
| Campo | Tipo | Notas |
|---|---|---|
| `resumenFolio` / `resumenCliente` / `resumenTotal` | string | folio, nombre, total con formato `$x,xxx.xx` |
| `estatus` | string | `pendiente` \| `aprobada` \| `rechazada` \| `cancelada` |
| `pago` | objeto \| ausente | `{pagado:bool, montoRecibido:number, fechaPago:'YYYY-MM-DD', comprobante?}` (fuente: Recibos de Pago / landing) |
| `aceptacionCliente` | objeto \| ausente | `{firma:dataURL, comprobante:dataURL, nombre, aceptadoEn, ip}` (lo sube el cliente en la landing) |
| `campos` / `selects` / `mat` / `nL` / `lados` / `pts` / `snapshot` | varios | datos del lote (incluye imágenes base64 pesadas: `snapshot`) |
| `resumenDetalles` | objeto | textos del resumen para la landing/PDF |
| `guardadoEn` / `actualizadoEn` | ISO string | fechas |

### 4.2 Metadata de la clave `cot:` — SE EXTIENDE (núcleo de este diseño)
KV permite adjuntar `metadata` a cada clave, y `KV.list()` la devuelve **sin** hacer `get` por clave. Hoy la metadata es:
```js
{ folio, cliente, total, estatus, guardadoEn, actualizadoEn }
```
**Se agregan banderas denormalizadas** (calculadas por `computeFlags`, ver §5.3):
```js
{
  ...actual,
  estadoPago,          // 'pendiente' | 'parcial' | 'pagada'
  montoPagado,         // number
  saldo,               // number  (totalNum - montoPagado)
  fechaPago,           // 'YYYY-MM-DD' | ''
  tieneCompVendedor,   // bool  (algún receipt.historiaPagos[].comprobanteArchivo)
  tieneCompCliente,    // bool  (aceptacionCliente.comprobante presente)
  firmada,             // bool  (aceptacionCliente.firma presente)
  tieneRecibo,         // bool  (existe receipt: para el folio)
  reciboNumero         // string | ''  (numero del recibo más reciente, para compartir)
}
```
> **Límite:** la metadata de KV admite ~1 KB por clave. Estas banderas ocupan < 200 bytes. OK. **Nunca** metas imágenes en metadata.

### 4.3 Recibo (`receipt:YYYYMM:#####`) — ya existe
`{ numero, folio, fecha, cliente, detalles, impuestos, totales, pago:{metodo,monto,estado}, historiaPagos:[{fecha,monto,metodo,comprobante,comprobanteArchivo,descripcion}] }`

### Relationships
- `cot:` **1—N** `receipt:` (por `receipt.folio === cot.resumenFolio`).
- `cot:` **1—1** `aceptacionCliente` (embebido en el registro).
- `token:landing:<t>` → folio ; `token:recibo:<t>` → numero de recibo.

---

## 5. API Design (Worker)

### 5.1 Routes overview
| Método | Path | Descripción | Auth |
|---|---|---|---|
| GET | `/api/cotizaciones/resumen` | **NUEVO.** Lista liviana con banderas (metadata), con filtros/paginación. Alimenta el panel | Sí (VIEW) |
| GET | `/api/cotizaciones/:folio/aceptacion` | **NUEVO.** Devuelve `{firma, comprobante, nombre, aceptadoEn}` on-demand | Sí (VIEW) |
| POST | `/api/cotizaciones/:folio/generar-recibo` | **NUEVO.** Crea un recibo para una cotización pagada sin recibo | Sí (EDIT) |
| POST | `/api/admin/reindexar-flags` | **NUEVO (migración, una vez).** Recalcula banderas en metadata de todas las cotizaciones | Sí (ADMIN) |
| GET | `/api/cotizaciones/:folio/receipts` | *Ya existe.* Recibos del folio (comprobante del vendedor + datos del recibo) | Sí |
| POST | `/api/receipts/:numero/share` | *Ya existe.* Genera `token:recibo:` y URL pública `/recibo/:token` | Sí |
| GET | `/api/cotizaciones` / `/:id` / PUT / POST | *Ya existen.* No se rompen | Sí |

### 5.2 `GET /api/cotizaciones/resumen` (el endpoint clave)
**Query params (todos opcionales):** `estadoPago` (`pagada|parcial|pendiente`), `estatus`, `desde`/`hasta` (ISO date sobre `fechaPago` o `guardadoEn`), `q` (busca en folio/cliente), `cursor` (paginación KV), `limit` (default 100, máx 200).

**Lógica:**
```
res = KV.list({ prefix: 'cot:', cursor, limit })
rows = res.keys.map(k => ({ folio, cliente, total, estatus, ...k.metadata }))  // SIN get por clave
aplicar filtros q/estadoPago/estatus/fechas en memoria sobre rows
return { items: rows, cursor: res.list_complete ? null : res.cursor }
```
**Respuesta:**
```json
{ "items": [ { "folio":"COT-011","cliente":"...","total":"$16,000.03","estatus":"aprobada",
  "estadoPago":"pagada","montoPagado":16000,"saldo":0,"fechaPago":"2026-07-20",
  "tieneCompVendedor":true,"tieneCompCliente":true,"firmada":true,"tieneRecibo":true,"reciboNumero":"202607:82115" } ],
  "cursor": null }
```
**Reglas:** nunca incluir imágenes (`snapshot`, `firma`, `comprobante`) en esta respuesta.

### 5.3 `computeFlags(rec, receipts)` — helper puro (fuente única de verdad)
```
totalNum   = parseMoney(rec.resumenTotal)                    // "$16,000.03" -> 16000.03
pago       = rec.pago || null
montoPagado= pago?.montoRecibido || sum(receipts.flatMap(r=>r.historiaPagos).map(p=>p.monto)) || 0
estadoPago = montoPagado<=0 ? 'pendiente' : (montoPagado+0.01>=totalNum ? 'pagada' : 'parcial')
saldo      = max(0, totalNum - montoPagado)
fechaPago  = pago?.fechaPago || (último historiaPagos.fecha) || ''
tieneCompVendedor = receipts.some(r => r.historiaPagos?.some(p => p.comprobanteArchivo))
tieneCompCliente  = !!rec.aceptacionCliente?.comprobante
firmada           = !!rec.aceptacionCliente?.firma
reciboNumero      = receipts[0]?.numero || ''
tieneRecibo       = !!reciboNumero
```
> Devuelve el objeto de banderas de §4.2. Se usa en la migración y en cada punto de escritura.

### 5.4 Puntos de escritura donde hay que refrescar banderas
Para mantener la metadata al día **sin** recalcular en cada lectura:
- `putRecord(env, id, rec)`: al guardar/editar una cotización, si `rec.pago`/`rec.aceptacionCliente` cambian, recomputar banderas (con receipts si hace falta) y escribirlas en metadata.
- `createReceipt` / `addPayment`: tras crear/actualizar un recibo, **actualizar la metadata del `cot:` padre** (estadoPago, montoPagado, saldo, fechaPago, tieneCompVendedor, tieneRecibo, reciboNumero).
- Ruta `POST /landing/:token/aceptar`: tras guardar `aceptacionCliente`, actualizar `firmada` y `tieneCompCliente`.
- `POST /api/receipts/:numero/share`: asegurar `tieneRecibo=true` y `reciboNumero`.

> Patrón helper sugerido: `async function refreshFlags(env, folio)` que carga el `cot:`, sus `receipts`, corre `computeFlags` y hace `put` con la nueva metadata (idempotente). Llamarlo desde cada punto de escritura. Es 1 list de receipts + 1 put; aceptable porque ocurre en eventos, no en cada lectura del panel.

---

## 6. Frontend Architecture

### 6.1 Acceso
Botón nuevo en el header: **"Centro"** (icono `ti-layout-dashboard`). Abre el modal `#modal-centro` (overlay a pantalla completa, mismo patrón que `#modal-finanzas-overlay`).

### 6.2 Estructura del panel
```
#modal-centro (overlay)
  ├─ Barra superior: título "Centro de Cotizaciones" + botón cerrar
  ├─ Barra de filtros (sticky):
  │    - buscador (folio/cliente)  [input, filtra en vivo]
  │    - chips estado de pago: Todas | Pagadas | Parciales | Pendientes
  │    - select estatus: Todas | Aprobadas | Canceladas | ...
  │    - rango de fechas (desde / hasta) — reusa date pickers oscuros
  │    - contador "N resultados"
  ├─ Tabla (#centro-tbody):
  │    Folio·Cliente | Total / Saldo | [badge estadoPago] | Fecha pago | [iconos]
  │    iconos por fila:
  │      👁️ ti-file-invoice   → comprobantes (menú si hay 2: "del vendedor" / "del cliente")
  │      📄 ti-receipt         → recibo (ver/compartir; si pagada sin recibo → "Generar")
  │      ✍️ ti-signature       → firma del cliente
  │    (icono en gris/deshabilitado si la bandera correspondiente es false)
  └─ Paginación: "Cargar más" (usa cursor) — no cargar todo de golpe
```

### 6.3 Flujo de datos
1. Al abrir: `apiFetch('/api/cotizaciones/resumen?...')` → pinta filas desde metadata (**sin** imágenes). Instantáneo.
2. Filtros/búsqueda: re-piden `/resumen` con params (o filtran el cache en memoria para el buscador en vivo).
3. Clic en icono → carga **on-demand** el asset:
   - Comprobante vendedor → `GET /api/cotizaciones/:folio/receipts` → abre `historiaPagos[].comprobanteArchivo` con `verArchivo()` (helper existente).
   - Comprobante/Firma cliente → `GET /api/cotizaciones/:folio/aceptacion` → `verArchivo(comprobante)` / muestra `<img src=firma>`.
   - Recibo → si `tieneRecibo`: `POST /api/receipts/:numero/share` (o reusa token) → modal "Link para compartir" (Copiar/Abrir/PDF) existente. Si pagada sin recibo → `POST /api/cotizaciones/:folio/generar-recibo` y luego compartir.
4. "Cargar más" → repite `/resumen` con `cursor`.

### 6.4 State management
- `centroCache = { items:[], cursor:null, filtros:{} }` en memoria (como `finanzasDataCache`).
- Sin framework, sin reactividad: re-render manual del `<tbody>` al cambiar filtros (igual que la lista actual).
- Reusar helpers existentes: `apiFetch`, `verArchivo`, `descargarArchivo`, `toast`, `$m` (formato money), y el modal de "Link para compartir".

---

## 7. Design System (reusar el existente — HUD/consola)

### Colors (tokens ya definidos en `:root`)
| Rol | Hex | Uso |
|---|---|---|
| Accent (verde menta) | `#89D7B7` | badges "pagada", acciones, glow |
| Accent2 (teal) | `#428475` | bordes activos |
| bg / bg2 / bg3 | `#0e1c18` / `#122720` / `#0a1511` | fondo, superficies, filas |
| Border / Border2 | `#2f5c50` / `#428475` | líneas de tabla |
| Text / Muted / Dim | `#fdf8ee` / `#8fb0a3` / `#5f8a7c` | texto |
| Red | `#f06060` | pendiente/errores/saldo |

Badges de estado de pago: 🟢 Pagada = `--accent` · 🟡 Parcial = `#ba7517`/ámbar · ⚪ Pendiente = `--muted`.

### Typography
- Títulos: `Syne` (`--fh`). Cuerpo: `IBM Plex Sans` (`--fb`). Números/mono: `IBM Plex Mono` (`--fm`) para montos y folios.

### Style
- Radio `6px` (`--radius`), tema oscuro (`color-scheme:dark`), touch targets ≥36px, `prefers-reduced-motion` respetado. **Función sobre forma**: tabla densa y rápida, sin animaciones pesadas.

---

## 8. Authentication & Authorization

- Toda ruta nueva usa el mismo gate: headers `X-Auth-Token` + `X-User-Email`, validados contra `token:<token>` en KV.
- `GET /resumen` y `/aceptacion` → permiso de **ver cotizaciones** (mismo que la lista actual).
- `POST /generar-recibo` → permiso de **editar** (EDIT_OWN/EDIT_ALL).
- `POST /admin/reindexar-flags` → solo **ADMIN** (`user.email === ADMIN_EMAIL` o permiso VIEW_AUDIT).
- El panel es interno: no expone nada público. (Las rutas públicas por token — `/landing`, `/recibo` — no se tocan.)

---

## 9. Build Order (LO MÁS IMPORTANTE — seguir en orden)

**Step 1 — `computeFlags` + `refreshFlags` (Worker).**
Agrega el helper puro `computeFlags(rec, receipts)` (§5.3) y `async refreshFlags(env, folio)` que carga `cot:`, lista sus `receipts` (por `getReceiptsByFolio`, ya existe) y hace `put` con metadata nueva. No cambia comportamiento aún. `node --check`.

**Step 2 — Extender `putRecord` para persistir banderas.**
Que `putRecord` incluya en la metadata las banderas calculadas a partir del `rec` (pago/aceptacion) — sin romper los campos de metadata actuales. Para banderas que dependen de recibos, dejar que `refreshFlags` las corrija en los puntos de pago.

**Step 3 — Enganchar `refreshFlags` en los puntos de escritura.**
Llamar `refreshFlags(env, folio)` al final de: `createReceipt`, `addPayment`, la ruta `POST /landing/:token/aceptar` (ya existe), y `POST /api/receipts/:numero/share`. Verificar con curl que tras registrar un pago, la metadata del `cot:` refleja `estadoPago`/`tieneRecibo`.

**Step 4 — Migración `POST /api/admin/reindexar-flags`.**
Recorre `cot:` (paginado), corre `refreshFlags` en cada uno. Devuelve `{procesadas:n}`. Ejecutar **una vez** tras desplegar (para poblar banderas de las cotizaciones viejas). Idempotente.

**Step 5 — `GET /api/cotizaciones/resumen`.**
Implementar §5.2 (list + metadata + filtros + cursor). Probar con curl: debe devolver banderas correctas sin imágenes y en una sola llamada.

**Step 6 — `GET /api/cotizaciones/:folio/aceptacion`.**
Devuelve `{firma, comprobante, nombre, aceptadoEn}` del `rec.aceptacionCliente`. Auth VIEW. (Endpoint on-demand para los iconos de cliente.)

**Step 7 — `POST /api/cotizaciones/:folio/generar-recibo`.**
Si la cotización está pagada (o parcial) y no tiene recibo, crea uno con `createReceipt` a partir de `rec.pago`/total. Devuelve `{numero}`. Auth EDIT. Refresca banderas.

**Step 8 — UI: botón "Centro" + modal + tabla base.**
Header + `#modal-centro`. Cargar `/resumen` y pintar filas (folio, cliente, total/saldo, badge, fecha). Sin iconos aún. Verificar velocidad con datos reales.

**Step 9 — Filtros + búsqueda + paginación.**
Chips de estado de pago, select de estatus, rango de fechas, buscador en vivo, "Cargar más" con cursor. Contador de resultados.

**Step 10 — Iconos on-demand.**
Cablear 👁️ (comprobantes: menú vendedor/cliente), 📄 (recibo: ver/compartir o generar), ✍️ (firma). Reusar `verArchivo`, `descargarArchivo`, modal de link. Deshabilitar icono cuando la bandera es false.

**Step 11 — Pruebas E2E + auditoría.**
Registrar pago → aparece "pagada" en el panel; cliente firma → aparece ✍️ y 👁️ cliente; generar recibo → 📄 comparte link. Log de auditoría en `generar-recibo`. Validar el `<script>` del panel (si hubiera) y que no hay imágenes en `/resumen`.

**Step 12 — Deploy.**
`cd worker && npx wrangler@4 deploy`; commit+push del `index.html`. Ejecutar migración (Step 4) una vez. `Ctrl+Shift+R` para ver el panel.

---

## 10. Environment Setup

### Prerequisites
- Node.js (para `node --check` y `npx wrangler@4`). Python 3 (server local en 3003).
- Estar logueado en wrangler con la cuenta Cloudflare `afernandezfalconi@gmail.com` (subdominio `lindero-coti`).

### Variables / IDs
| Nombre | Valor | Uso |
|---|---|---|
| KV namespace id | `c908b73db898406f88532f448a5198f9` | binding `COTIZACIONES` en `wrangler.toml` |
| API base | `https://lindero-coti-api.lindero-coti.workers.dev` | `API_BASE` en `index.html` |
| CORS permitido | `afernandezfalconi.github.io`, `localhost:3003`, `127.0.0.1:3003` | testing local en 3003 |

### Comandos
```bash
# Backend
cd worker && node --check src/index.js && npx wrangler@4 deploy
# Frontend local (probar el panel)
python -m http.server 3003     # abrir http://localhost:3003
# Migración (una vez, tras deploy) — con un token de admin válido:
curl -X POST "$API_BASE/api/admin/reindexar-flags" -H "X-Auth-Token: <tok>" -H "X-User-Email: <admin>"
```

---

## 11. Dependencies
No se agregan dependencias nuevas. Se reusa lo ya cargado por CDN (Tabler icons, Chart.js). Todo el código es vanilla JS + Web APIs (`KV`, `fetch`, `FileReader`, `canvas`).

---

## 12. Deployment Strategy
- **Worker:** `npx wrangler@4 deploy` (edge global, propaga en segundos).
- **Frontend:** commit + push a `main` → GitHub Pages (propaga ~1–2 min). El `index.html` lleva meta `no-cache`; aun así pedir `Ctrl+Shift+R` la primera vez.
- **Migración:** correr `/api/admin/reindexar-flags` **una sola vez** después de desplegar el Worker con `refreshFlags`, para poblar banderas históricas.
- Sin staging: es una feature aditiva; los endpoints nuevos no afectan los existentes. Si algo falla, el panel simplemente no se usa; el resto de la app sigue igual.

---

## 13. Testing Strategy
- **Sintaxis:** `node --check worker/src/index.js` antes de cada deploy. Si agregas `<script>` al panel, extrae y `node --check` el script servido.
- **Backend (curl):** probar `/resumen` (con y sin filtros, cursor), `/aceptacion`, `/generar-recibo`. Verificar que `/resumen` **no** trae imágenes (tamaño de respuesta pequeño).
- **Denormalización:** tras registrar un pago / firmar / compartir, releer la metadata (`KV.list` o el `/resumen`) y confirmar banderas correctas. Recordar la eventual-consistencia (~3s).
- **E2E en navegador (puerto 3003):** abrir panel → filtrar "Pagadas" → clic en cada icono → confirmar visor de comprobante/firma/recibo. Medir tiempo de carga con cientos de filas (sembrar datos si hace falta).
- **No romper:** correr el flujo actual (cotizar, pagar, Finanzas) para confirmar cero regresiones.

---

## 14. Skills to Use During Build
| Skill | Cuándo | Para qué |
|---|---|---|
| `ui-ux-pro-max` | Step 8–10 | Afinar la tabla densa, badges de estado y jerarquía visual del panel dentro del tema HUD |
| `code-review` | tras Step 11 | Revisar el diff del Worker + `index.html` (correctness, N+1, fugas de imágenes en `/resumen`) |
| `verify` | Step 11–12 | Ejercitar el panel end-to-end en el navegador antes de dar por cerrado |

---

## 15. CLAUDE.md for Target Project

```markdown
# LINDERO.COTI — Centro de Cotizaciones (feature)

Panel interno para ver estado de pago, comprobantes, recibo y firma de todas las cotizaciones desde un solo lugar. Feature dentro de la app existente LINDERO.COTI (cotizador de cercado).

## Commands
- `python -m http.server 3003` — server local del frontend (CORS del Worker permite 3003)
- `cd worker && node --check src/index.js` — validar sintaxis del Worker
- `cd worker && npx wrangler@4 deploy` — desplegar el Worker
- `git add -A && git commit && git push origin main` — publicar el frontend (GitHub Pages)

## Tech Stack
HTML/CSS/JS vanilla (un solo `index.html`, sin build) + Cloudflare Worker (`worker/src/index.js`) + Cloudflare KV (`COTIZACIONES`, id c908b73db898406f88532f448a5198f9) + auth por token (X-Auth-Token/X-User-Email, PBKDF2). API: https://lindero-coti-api.lindero-coti.workers.dev

## Architecture
- **Frontend:** todo en `index.html`. El panel es un modal overlay (`#modal-centro`) al estilo `#modal-finanzas-overlay`. Re-render manual del `<tbody>` (sin framework). Reusa helpers: `apiFetch`, `verArchivo`, `descargarArchivo`, `toast`, `$m`, modal de "Link para compartir".
- **Backend:** rutas se resuelven por `method+path` en `export default { fetch }`. Respuestas con helper `json(data,status,origin)`. KV con `metadata` por clave.
- **Data flow:** el panel lee `GET /api/cotizaciones/resumen`, que hace UN `KV.list({prefix:'cot:'})` y devuelve las **banderas de metadata** (estadoPago, saldo, firmada, tieneRecibo, etc.) SIN imágenes. Las imágenes (comprobantes/firma/recibo) se piden on-demand al hacer clic en un icono.
- **Denormalización:** las banderas viven en la metadata de `cot:` y se refrescan con `refreshFlags(env, folio)` en cada evento (crear/actualizar recibo, aceptar en landing, compartir recibo). Migración `POST /api/admin/reindexar-flags` puebla las históricas.

## Code Organization Rules
1. NO reescribir lo existente. Solo agregar el panel y los endpoints nuevos.
2. `/api/cotizaciones/resumen` NUNCA devuelve imágenes (`snapshot`, `firma`, `comprobante`). Solo banderas.
3. JS de cliente dentro del template literal del Worker: sin `\/` en regex, sin `${}`, sin `</script>` literal. Validar con `node --check` el `<script>` servido.
4. En Windows: no `wrangler kv get | python` (usa `> archivo` + utf-8). No `sed` en HTML/JS. No borrar KV antes de confirmar la escritura.
5. KV es eventual-consistente: esperar ~3s al testear write→read.
6. Función sobre forma: tabla densa y rápida; paginar (cursor); nada de cargar todo de golpe.

## Design System
Tema oscuro HUD (tokens en `:root`): accent `#89D7B7`, accent2 `#428475`, bg `#0e1c18`, bg2 `#122720`, bg3 `#0a1511`, border `#2f5c50`, text `#fdf8ee`, muted `#8fb0a3`, red `#f06060`. Radio 6px. Fuentes: Syne (títulos), IBM Plex Sans (cuerpo), IBM Plex Mono (montos/folios). Badges pago: verde `#89D7B7` (pagada), ámbar `#ba7517` (parcial), muted (pendiente). Iconos Tabler.

## Environment
- KV id: c908b73db898406f88532f448a5198f9 · API_BASE en index.html · CORS: github.io + localhost:3003.

## Reglas No Negociables
1. Cero regresiones en cotizar/pagar/firmar/Finanzas.
2. `/resumen` liviano (sin imágenes) o el panel no escala — es el punto del diseño.
3. Mantener banderas de metadata sincronizadas vía `refreshFlags` en TODOS los puntos de escritura.
4. Deploy Worker con `node --check` previo. Frontend con commit+push.
5. Correr la migración `reindexar-flags` una vez tras desplegar.
```

---

## 16. Reglas No Negociables (para el constructor)

1. **No reescribir** nada existente; esta feature es **aditiva**. Los endpoints/flujos actuales deben seguir idénticos.
2. **`/api/cotizaciones/resumen` jamás devuelve imágenes** — solo banderas de metadata. Si necesitas una imagen, es on-demand por su propio endpoint.
3. **Denormalización sincronizada:** cada punto que cambia pago/firma/recibo llama `refreshFlags`. Si se te olvida uno, el panel muestra estados viejos.
4. **Validar el Worker** con `node --check` antes de cada deploy; validar cualquier `<script>` servido igual.
5. **Windows/KV safety:** redirección a archivo (no pipe a python), UTF-8 explícito, nunca borrar KV antes de confirmar escritura, esperar ~3s por eventual-consistencia.
6. **Paginar** (cursor) — pensado para cientos/miles; nunca traer todo de golpe.
7. **Correr la migración** `reindexar-flags` una sola vez tras el primer deploy con banderas.
8. **Auditoría** en acciones de escritura (`generar-recibo`) usando el `createAuditLog` existente.
```
