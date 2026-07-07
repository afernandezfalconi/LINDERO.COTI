# Sistema de Usuarios y Permisos - LINDERO.COTI v2

**Versión:** 2.0  
**Fecha:** 2026-07-06  
**Admin:** afernandezfalconi@gmail.com

---

## 🔐 Cambios de Seguridad Implementados

### ✅ Vulnerabilidades Críticas Remediadas

1. **Landing Pages con Token** (NO más folio predecible)
   - Token aleatorio de 32 caracteres
   - Expira en 30 días
   - URL: `/landing/abc123xyz...`

2. **Rate Limiting**
   - 100 requests/min por IP
   - 5 intentos auth/min por IP
   - Retorna error 429 si se excede

3. **Timing Attack Fix**
   - Comparación segura de contraseñas
   - Tiempo constante en todas las rutas

4. **Auditoría Completa**
   - Todas las acciones se registran
   - Quién, qué, cuándo, cambios específicos
   - Retención 90 días

5. **Seguridad Headers**
   - X-Content-Type-Options: nosniff
   - X-Frame-Options: DENY
   - Content-Security-Policy ready

---

## 👥 Sistema de Usuarios

### Roles Predefinidos

| Rol | Permisos |
|-----|----------|
| **ADMIN** | Acceso total + gestión usuarios |
| **EDITOR** | Ver + crear + editar propias |
| **VIEWER** | Solo ver cotizaciones |

### Permisos Granulares (Bit Flags)

```javascript
VIEW_COTIZACIONES      (1)    - Ver listado
CREATE_COTIZACIONES    (2)    - Crear nuevas
EDIT_OWN               (4)    - Editar propias
EDIT_ALL               (8)    - Editar todas
DELETE_OWN             (16)   - Borrar propias
DELETE_ALL             (32)   - Borrar todas
VIEW_AUDIT             (64)   - Ver bitácora
MANAGE_USERS           (128)  - Crear/editar usuarios
VIEW_LANDING           (256)  - Ver landing pages
```

---

## 🔑 Autenticación

### Flujo de Login

1. Usuario envía email/contraseña
2. Admin crea usuario en el sistema
3. Sistema genera **token de 64 caracteres**
4. Token expira en **7 días**
5. Usuario envía token en header `X-Auth-Token`

### Headers Requeridos

```http
X-Auth-Token: abc123xyz...  (token de 64 chars)
X-User-Email: user@email.com
Content-Type: application/json
```

---

## 📝 API de Usuarios

### Crear Usuario (ADMIN solo)

```bash
POST /api/users
Authorization: X-Auth-Token: <admin-token>
Content-Type: application/json

{
  "email": "editor@example.com",
  "role": "EDITOR"  # o "VIEWER"
}
```

**Respuesta:**
```json
{
  "email": "editor@example.com",
  "rol": "EDITOR",
  "permissions": 7,
  "creadoEn": "2026-07-06T10:00:00Z",
  "creadoPor": "afernandezfalconi@gmail.com"
}
```

### Listar Usuarios (ADMIN solo)

```bash
GET /api/users
Authorization: X-Auth-Token: <admin-token>
```

---

## 📊 API de Auditoría

### Ver Bitácora (ADMIN o usuario con VIEW_AUDIT)

```bash
GET /api/audit
Authorization: X-Auth-Token: <token>
```

**Respuesta:**
```json
{
  "items": [
    {
      "timestamp": "2026-07-06T10:15:30Z",
      "usuario": "editor@example.com",
      "accion": "EDIT",
      "recurso": "COT-001",
      "detalles": {
        "cambios": {
          "resumenTotal": {
            "anterior": "$5,000",
            "nuevo": "$5,500"
          }
        }
      }
    },
    ...
  ]
}
```

### Acciones Registradas

| Acción | Descripción |
|--------|------------|
| **LOGIN** | Usuario se loguea |
| **CREATE** | Nueva cotización |
| **EDIT** | Modificación (con cambios específicos) |
| **VIEW** | Lectura de cotización |
| **DELETE** | Borrado |
| **CREATE_USER** | Nuevo usuario agregado |
| **LIST_COTIZACIONES** | Listado consultado |

---

## 🚀 Configuración Inicial

### 1. Crear Admin (Manual en KV)

El admin ya es: `afernandezfalconi@gmail.com`

Para crear otros admins, ejecutar en CLI:

```bash
wrangler kv:key put \
  --binding=COTIZACIONES \
  "user:newadmin@example.com" \
  '{"email":"newadmin@example.com","rol":"ADMIN","permissions":255,"creadoEn":"2026-07-06T00:00:00Z","creadoPor":"system"}'
```

### 2. Generar Token Inicial

```bash
wrangler kv:key put \
  --binding=COTIZACIONES \
  "token:admin-initial-token-xyz..." \
  "afernandezfalconi@gmail.com" \
  --expiration-ttl 604800  # 7 días
```

### 3. Agregar Usuarios desde App

- Ir a Admin Panel (nuevo menú)
- Ingresar email nuevo usuario
- Seleccionar rol (ADMIN, EDITOR, VIEWER)
- Sistema genera token automáticamente

---

## 🛡️ Security Headers

Todos los endpoints retornan:

```http
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Access-Control-Allow-Origin: https://afernandezfalconi.github.io
Access-Control-Allow-Methods: GET,POST,PUT,DELETE,OPTIONS
Access-Control-Max-Age: 86400
```

---

## 📱 Landing Pages Seguras

### Generar Landing (en frontend)

Al exportar "Versión para Cliente":

1. Sistema crea token aleatorio
2. Guarda relación: token → folio
3. Genera URL: `/landing/token123abc...`
4. URL válida por 30 días
5. Expira automáticamente

### Acceder a Landing

```http
GET /landing/token123abc...
```

**Seguridad:**
- ✅ No se puede enumerar folios
- ✅ Token único, no predecible
- ✅ Expira en 30 días
- ✅ Sin autenticación requerida
- ✅ Información limitada (no costos)

---

## 🔍 Bitácora - Qué se Registra

### Campos Guardados por Acción

**CREATE Cotización:**
```json
{
  "timestamp": "2026-07-06T10:00:00Z",
  "usuario": "editor@example.com",
  "accion": "CREATE",
  "recurso": "COT-001",
  "detalles": {} // metadata de creación
}
```

**EDIT Cotización:**
```json
{
  "timestamp": "2026-07-06T10:15:00Z",
  "usuario": "editor@example.com",
  "accion": "EDIT",
  "recurso": "COT-001",
  "detalles": {
    "cambios": {
      "resumenTotal": {
        "anterior": "$5,000.00",
        "nuevo": "$5,500.00"
      },
      "margen": {
        "anterior": "10%",
        "nuevo": "15%"
      }
    }
  }
}
```

**VIEW Cotización:**
```json
{
  "timestamp": "2026-07-06T10:20:00Z",
  "usuario": "viewer@example.com",
  "accion": "VIEW",
  "recurso": "COT-001",
  "detalles": {}
}
```

---

## 📋 Próximos Pasos (Frontend)

1. **Panel de Admin**
   - Interfaz para crear/editar usuarios
   - Ver listado de usuarios con roles
   - Resend token si expira

2. **Auditoría Visual**
   - Tabla con historia de cambios
   - Filtrar por usuario, fecha, acción
   - Ver antes/después de valores

3. **Sesión Mejorada**
   - Usar sessionStorage (auto-limpia)
   - Logout automático (30 min inactividad)
   - Mostrar usuario actual + permisos

4. **Permisos en UI**
   - Botones de crear/editar deshabilitados si no tiene permisos
   - Mostrar avisos "sin permiso"

---

## 🐛 Troubleshooting

### "Token inválido o expirado"
- Token expira cada 7 días
- Admin genera nuevo en panel
- Guardar en sessionStorage, no localStorage

### "Sin permisos para..."
- Verificar rol del usuario
- Solo ADMIN puede editar usuario
- EDITOR solo puede crear/editar propias

### Rate limiting activado
- Esperar 60 segundos
- Máximo 100 requests/min por IP
- Auth: máximo 5 intentos/min

---

## 🔒 Cumplimiento de Normativas

- ✅ Auditoría completa (trazabilidad)
- ✅ Control de acceso basado en rol (RBAC)
- ✅ Cifrado en tránsito (HTTPS)
- ✅ Headers de seguridad
- ✅ Rate limiting
- ✅ Retención de logs (90 días)

