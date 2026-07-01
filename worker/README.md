# LINDERO.COTI — API (Cloudflare Worker + KV)

Backend que guarda las cotizaciones en la nube para consultarlas desde cualquier
dispositivo. El **folio es global** y lo asigna el servidor (consecutivo, único).

## Producción

- **URL del API:** `https://lindero-coti-api.lindero-coti.workers.dev`
- **Worker:** `lindero-coti-api`
- **KV namespace:** `COTIZACIONES` (id `c908b73db898406f88532f448a5198f9`)
- **Auth:** contraseña compartida en el header `X-App-Password` (secret `APP_PASSWORD`).

## Endpoints

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/health` | Ping (sin auth) |
| GET | `/api/next-folio` | Folio que tomará la próxima cotización |
| GET | `/api/cotizaciones` | Lista de resúmenes |
| GET | `/api/cotizaciones/:id` | Registro completo |
| POST | `/api/cotizaciones` | Crear (asigna folio nuevo) |
| PUT | `/api/cotizaciones/:id` | Actualizar (conserva folio). `{"estatus":"cancelada"}` = cancelar |
| POST | `/api/change-password` | Cambia la contraseña del equipo. Body `{"nueva":"…"}` (min 4) |

Todas menos `/api/health` requieren `X-App-Password`.

### Contraseña

La contraseña vigente se guarda en KV (`meta:password`) y **se puede cambiar
desde la app** (botón 🔑 Contraseña) o vía `/api/change-password`. El secret
`APP_PASSWORD` es solo el **valor inicial/respaldo**: se usa mientras `meta:password`
no exista. Para forzar un reset borra la clave KV:
`npx wrangler@4 kv key delete "meta:password" --namespace-id <id> --remote`.

## Operación

```bash
cd worker

# Desplegar cambios del código
npx wrangler@4 deploy

# Cambiar la contraseña compartida
npx wrangler@4 secret put APP_PASSWORD

# Ver / borrar datos (¡usar --remote para el KV de producción!)
npx wrangler@4 kv key list   --namespace-id c908b73db898406f88532f448a5198f9 --remote
npx wrangler@4 kv key delete "cot:COT-001" --namespace-id c908b73db898406f88532f448a5198f9 --remote
```

## Notas

- El folio se asigna desde `meta:folioSeq` y se autorrepara contra colisiones
  (no reutiliza folios, ni siquiera de cotizaciones canceladas).
- CORS permite `https://afernandezfalconi.github.io` y `localhost:3003` (dev).
- KV es *eventually consistent*: los listados pueden tardar unos segundos en
  reflejar cambios.
