# LINDERO.COTI — Cotizador de Posteo (PosteoCot)

Herramienta web **de uso interno** de Luna Grupo Inmobiliario para cotizar el
*posteo* (cercado con postes + alambre de púa) de lotes residenciales o rurales.

- **Tipo:** PWA de un solo archivo HTML autocontenido (`index.html`).
- **Versión actual local:** **V4.00** (extraída de Google Drive el 2026-06-23).
- **Origen Drive:** `PROYECTOS PWA / LINDERO.COTI`

### Repositorio y despliegue

- **Repo de trabajo (origin):** https://github.com/afernandezfalconi/LINDERO.COTI
  — fork bajo la cuenta personal, rama `main`. Aquí se hace `git push`.
- **Deploy propio (Pages):** https://afernandezfalconi.github.io/LINDERO.COTI/
- **Upstream original (org, solo lectura):** https://github.com/lunagrupoinmobiliario/LINDERO.COTI
  → https://lunagrupoinmobiliario.github.io/LINDERO.COTI/ (no se puede pushear con
  la cuenta actual; el fork se creó por eso).

> Flujo: editar → `git add` → `git commit` → `git push` publica en el Pages propio
> en ~1 min. Para llevar cambios al sitio de la org hay que abrir PR al upstream o
> pushear con una cuenta con permiso de escritura en la organización.

### Backend en la nube (Cloudflare Worker + KV)

Las cotizaciones se guardan en la nube y son **consultables desde cualquier
dispositivo**. El código del backend está en [`worker/`](worker/) (ver su README).

- **API:** `https://lindero-coti-api.lindero-coti.workers.dev`
- **Folio global:** lo asigna el servidor (consecutivo y único entre todos los
  equipos, ya no por-navegador).
- **Auth:** contraseña compartida del equipo (se pide una vez y se guarda en el
  navegador). Se envía en el header `X-App-Password`.
- **Migración:** si tenías cotizaciones guardadas solo en un navegador (versión
  anterior), en "Mis cotizaciones" aparece un botón para **subirlas a la nube**.
- Redeploy del backend: `cd worker && npx wrangler@4 deploy`.

## Estructura de la carpeta

```
LINDERO.COTI/
├── index.html                          # App completa (V4.00) — punto de entrada
├── worker/                             # Backend API (Cloudflare Worker + KV)
│   ├── src/index.js
│   ├── wrangler.toml
│   └── README.md
├── PROMPT-MAESTRO-PosteoCot-v0.5.txt   # Especificación funcional original (v0.5)
├── assets/
│   └── lindero-logo.svg                # Logo oficial
└── README.md
```

> Las imágenes de diseño/branding (PNG, paleta) quedan en el Drive; aquí solo se
> trajo lo necesario para dar continuidad al desarrollo.

## Stack / dependencias

Sin build. Es HTML + CSS + JS vanilla. Dependencias externas vía CDN:

- **Google Fonts:** Syne (titulares), IBM Plex Sans (cuerpo), IBM Plex Mono (números/labels).
- **pdf.js 3.11.174** (cdnjs) — render del plano PDF y trazado interactivo del lote.

## Cómo ejecutar

Abrir `index.html` en el navegador, o servirlo localmente:

```bash
# desde la carpeta del proyecto
python -m http.server 8080
# o
npx serve .
```

> Requiere conexión a internet para fuentes y pdf.js (CDN). El splash se oculta
> escribiendo la secuencia **O → F → Enter**.

## Qué hace (resumen funcional)

Layout de dos columnas: formulario scrolleable a la izquierda, resumen de
cotización *sticky* en tiempo real a la derecha. Secciones del formulario:

1. **Cliente** — nombre, folio/referencia, ubicación.
2. **Plano del lote** — sube un PDF, lo renderiza con pdf.js y permite **trazar
   el polígono del lote** sobre un canvas overlay (modo Trazar / Mover / Borrar /
   Confirmar). Cada vértice = un lado con color y etiqueta `L1, L2…`.
3. **Medidas** — nº de lados (mín. 4, se autoajusta al trazado), longitud por
   lado, manzana/lote, perímetro en tiempo real.
4. **Separación y material de postes** — 1.50 / 2.00 (default) / 3.00 m o
   personalizada; concreto vs. madera; comprar prefabricados vs. fabricar en
   obra. Esquineros siempre concreto 15×15 con zapata (uno por vértice).
5. **Vano del portón** — sí/no, ancho (default 5 m), lado; se resta del perímetro.
6. **Costos de materiales** — precios de postes, alambre de púa cal. 12.5,
   grampas, concreto; modo comprar o fabricar. Mano de obra calculada automática.
7. **Margen de utilidad** — *(añadido en V4, no estaba en el prompt v0.5)*.

**Cálculo (en tiempo real):**
- **Perímetro** efectivo = perímetro − portón.
- **Área** del lote por fórmula *shoelace* sobre el polígono trazado + escala
  derivada de las medidas reales; alerta si discrepa del área del plano.
- **Postes** de línea = ceil(perím/separación); esquineros = nº vértices.
- **Alambre de púa** = perím × hebras (1/2/3 seleccionables); costo por uso
  exacto vs. rollos completos.
- **Fundición de postes:** cemento automático según volumen del hoyo
  (Ø = 3× ancho del poste, profundidad = largo/3, f'c = 150 kg/cm², 5.2 sacos/m³),
  con sección "Ver más" que explica metodología y fuentes.
- **Medidas de postes** (sección, diámetro, largo) editables → recalculan todo
  en cascada, incluidas etiquetas.
- **Mano de obra** por rendimiento (ref. 200 m² / 1.5 lotes por día,
  2 personas, $500/persona/día). Formato `es-MX`.

## Funcionalidades de negocio (V4.00)

El archivo superó ampliamente la spec original v0.5. Construido en Claude web:

- **Guardar/cargar cotizaciones** (localStorage) + **estados** pendiente /
  aprobada / rechazada con filtro.
- **Margen de utilidad** configurable (% con botones rápidos 15/20/30).
- **Catálogo de proveedores** (guardar/cargar sets de precios).
- **Comparador de escenarios** (concreto/madera × comprar/fabricar).
- **Exportar PDF con membrete** (logo, datos de empresa, tablas formales, firma).
- **Deshacer punto** al trazar + **"Nuevo lote (mismo plano)"**.
- **Folio consecutivo e irrepetible** (`COT-001`, `COT-002`…): se asigna
  automáticamente al guardar, **no es editable** y nunca se reutiliza. Contador en
  `localStorage` (`lindero:folioSeq`), autorreparable contra los registros
  existentes. Botón **✚ Nueva** para empezar otra cotización.
- **Editar cotización guardada:** al abrir una desde "Mis cotizaciones" entra en
  modo edición (botón pasa a "Actualizar"); corregir datos o costos **actualiza el
  mismo registro** y conserva su folio (no duplica).
- **Cancelar en vez de borrar:** la ✕ marca la cotización como **Cancelada** y la
  conserva en el histórico (filtro propio); el folio queda registrado y no se
  reutiliza. Se puede reactivar cambiando su estatus.
- **Splash screen** de inicio (secuencia O→F→Enter para entrar).
- **PWA móvil:** manifest + íconos embebidos (instalable en iOS/Android), soporte
  táctil completo (tap = vértice, arrastre = pan), CSS responsivo (una columna,
  inputs sin zoom iOS).

## Branding

- **Nombre:** LINDERO.COTI
- **Logo oficial** de Lindero en `assets/lindero-logo.svg` (extraído con
  `rsvg-convert`; `cairosvg` rompía la transparencia). Es el logo por defecto del
  PDF; opcionalmente se puede subir uno propio.
- **Paleta:** `#1A312C` verde bosque · `#428475` teal · `#89D7B7` menta ·
  `#FFF4E1` crema. Header con fondo crema para contraste con el logo.

## Bug histórico resuelto

Un `<div>` duplicado/huérfano rompía el *nesting* del DOM y atrapaba el panel de
resumen dentro del formulario en vez de mostrarlo como sidebar. Corregido y
verificado con balance de divs (303). Tenerlo presente al editar el HTML.

## Historial de versiones en Drive

`V1.00.00` → `V1.00.02` → `V2.00.00` → **`V4.00`** (actual). En esta carpeta solo
se mantiene la última como `index.html`.

## Pendientes / ideas

- (Vacío por ahora — anotar aquí lo que se vaya trabajando desde Claude Desktop.)
