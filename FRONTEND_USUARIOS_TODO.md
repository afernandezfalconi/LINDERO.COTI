# Plan de Implementación - Sistema de Usuarios en Frontend

**Estado:** Planeado  
**Prioridad:** CRÍTICA  
**Estimado:** 3-4 horas de desarrollo

---

## 📋 Checklist de Implementación

### FASE 1: Autenticación (1 hora)

- [ ] Migrar a `sessionStorage` en lugar de `localStorage` para contraseña
- [ ] Cambiar flujo login:
  - [ ] En lugar de guardar contraseña, recibir **token**
  - [ ] Guardar token en sessionStorage
  - [ ] Guardar email en sessionStorage
  - [ ] Enviar headers: `X-Auth-Token` y `X-User-Email` en todas las requests
- [ ] Implementar logout automático (30 min inactividad)
- [ ] Mostrar usuario actual + rol en header
- [ ] Agregar contador de sesión activa

### FASE 2: Panel de Admin (1 hora)

**Nueva sección en menú:**
```
🏢 Datos de empresa
📂 Mis cotizaciones
💰 Finanzas
👥 Gestión de Usuarios    [NEW - Solo ADMIN]
📊 Auditoría               [NEW - Solo ADMIN/VIEW_AUDIT]
✚ Nueva
💾 Guardar
🔑 Contraseña
🔒 Salir
```

**Panel de usuarios:**
- [ ] Tabla de usuarios actuales
  - Email | Rol | Creado en | Creado por
- [ ] Formulario "Agregar usuario"
  - Input: Email
  - Select: Rol (ADMIN, EDITOR, VIEWER)
  - Botón: Agregar
- [ ] Generar + mostrar token automáticamente
- [ ] Opción para resend token
- [ ] Eliminar usuario (confirmación)

**UI:**
```html
<div id="admin-users-panel">
  <h2>👥 Gestión de Usuarios</h2>
  
  <table>
    <thead>
      <tr>
        <th>Email</th>
        <th>Rol</th>
        <th>Creado en</th>
        <th>Acciones</th>
      </tr>
    </thead>
    <tbody id="users-tbody"></tbody>
  </table>
  
  <h3>Agregar Usuario</h3>
  <input type="email" id="new-user-email" placeholder="usuario@example.com">
  <select id="new-user-role">
    <option value="VIEWER">VIEWER - Solo ver</option>
    <option value="EDITOR">EDITOR - Crear/editar propias</option>
    <option value="ADMIN">ADMIN - Acceso total</option>
  </select>
  <button onclick="agregarUsuario()">➕ Agregar</button>
</div>
```

### FASE 3: Auditoría (1 hora)

**Nueva pestaña "Auditoría":**
- [ ] Tabla de eventos
  - Timestamp | Usuario | Acción | Recurso | Cambios
- [ ] Filtros:
  - [ ] Por usuario (dropdown)
  - [ ] Por acción (dropdown: CREATE, EDIT, VIEW, LOGIN, DELETE)
  - [ ] Por fecha (desde - hasta)
  - [ ] Por recurso (búsqueda)
- [ ] Vista de cambios (expandible)
  - Antes | Después | Campo

**UI:**
```html
<div id="audit-panel">
  <h2>📊 Bitácora de Auditoría</h2>
  
  <div class="filters">
    <input type="text" id="audit-filter-usuario" placeholder="Usuario">
    <select id="audit-filter-accion">
      <option value="">Todas las acciones</option>
      <option value="CREATE">CREATE</option>
      <option value="EDIT">EDIT</option>
      <option value="VIEW">VIEW</option>
      <option value="LOGIN">LOGIN</option>
      <option value="DELETE">DELETE</option>
    </select>
    <input type="date" id="audit-filter-desde">
    <input type="date" id="audit-filter-hasta">
    <button onclick="filtrarAuditoria()">🔍 Filtrar</button>
  </div>
  
  <table>
    <thead>
      <tr>
        <th>Hora</th>
        <th>Usuario</th>
        <th>Acción</th>
        <th>Recurso</th>
        <th>Detalles</th>
      </tr>
    </thead>
    <tbody id="audit-tbody"></tbody>
  </table>
</div>
```

### FASE 4: Permisos en UI (30 min)

- [ ] Deshabilitar botones según permisos:
  - `CREATE_COTIZACIONES`: Botón "✚ Nueva"
  - `EDIT_OWN`: Botón "Editar" (propias)
  - `EDIT_ALL`: Botón "Editar" (todas)
  - `MANAGE_USERS`: Menú "Gestión de Usuarios"
  - `VIEW_AUDIT`: Menú "Auditoría"
- [ ] Mostrar avisos: "No tienes permiso para..."
- [ ] Colorear permisos faltantes

**Funciones:**
```javascript
async function puedeCrear() {
  return await hasPermission(user, PERMISSIONS.CREATE_COTIZACIONES);
}

async function puedeEditar(cotizacion) {
  const puedeEditar All = await hasPermission(user, PERMISSIONS.EDIT_ALL);
  const puedeEditarOwn = await hasPermission(user, PERMISSIONS.EDIT_OWN);
  return puedeEditarAll || (puedeEditarOwn && cotizacion.creador === user.email);
}
```

### FASE 5: Integración de Landing Pages (30 min)

- [ ] Al exportar versión cliente:
  - [ ] Request POST /api/cotizaciones/:id/landing-token
  - [ ] Recibir token único
  - [ ] Generar URL: `/landing/TOKEN`
  - [ ] Copiar al portapapeles
  - [ ] Mostrar en modal

---

## 🔧 Cambios en Funciones Existentes

### `apiFetch()` - Headers de autenticación

**Antes:**
```javascript
async function apiFetch(path, opts){
  opts = opts || {};
  const headers = Object.assign(
    {'X-App-Password': getAppPassword()},
    opts.headers || {}
  );
  // ...
}
```

**Después:**
```javascript
async function apiFetch(path, opts){
  opts = opts || {};
  const user = JSON.parse(sessionStorage.getItem('user') || '{}');
  const headers = Object.assign({
    'X-Auth-Token': sessionStorage.getItem('token') || '',
    'X-User-Email': user.email || ''
  }, opts.headers || {});
  // ...
}
```

### `validarPassword()` → `validarLogin()`

**Nueva función:**
```javascript
async function validarLogin(email, password) {
  try {
    const r = await fetch(API_BASE + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    
    if (!r.ok) return null;
    
    const data = await r.json();
    
    // Guardar token y usuario
    sessionStorage.setItem('token', data.token);
    sessionStorage.setItem('user', JSON.stringify({email: data.email}));
    
    return true;
  } catch(e) {
    return null;
  }
}
```

### `cerrarSesion()`

**Actualizar:**
```javascript
function cerrarSesion(){
  sessionStorage.removeItem('token');
  sessionStorage.removeItem('user');
  irAlHome();
}
```

---

## 📡 Llamadas API Nuevas

### Crear Usuario (Admin)

```javascript
async function crearUsuario(email, rol) {
  const resp = await apiFetch('/api/users', {
    method: 'POST',
    body: JSON.stringify({ email, role: rol })
  });
  if (!resp.ok) throw new Error('Error al crear usuario');
  return await resp.json();
}
```

### Listar Usuarios (Admin)

```javascript
async function listarUsuarios() {
  const resp = await apiFetch('/api/users');
  return await resp.json();
}
```

### Obtener Auditoría

```javascript
async function obtenerAuditoria(filtros = {}) {
  const resp = await apiFetch('/api/audit');
  let items = await resp.json();
  
  // Filtrar client-side
  if (filtros.usuario) {
    items = items.filter(a => a.usuario.includes(filtros.usuario));
  }
  if (filtros.accion) {
    items = items.filter(a => a.accion === filtros.accion);
  }
  if (filtros.desde) {
    items = items.filter(a => new Date(a.timestamp) >= new Date(filtros.desde));
  }
  
  return items;
}
```

---

## 🎨 Cambios de UI/UX

### Header Principal

```html
<!-- Agregar a la barra de navegación -->
<div class="user-info">
  <span>👤 User: <strong id="username"></strong></span>
  <span>🔐 Rol: <strong id="userrole"></strong></span>
  <span id="inactivity-warning" style="color:red;display:none;">
    ⚠️ Sesión se cierra en 5 min por inactividad
  </span>
</div>
```

### Mostrar Permisos en UI

```javascript
function actualizarUIPermisos(user, permissions) {
  if (!(permissions & PERMISSIONS.CREATE_COTIZACIONES)) {
    document.getElementById('btn-nueva').disabled = true;
    document.getElementById('btn-nueva').title = 'No tienes permiso';
  }
  
  if (!(permissions & PERMISSIONS.MANAGE_USERS)) {
    document.getElementById('menu-usuarios').style.display = 'none';
  }
  
  if (!(permissions & PERMISSIONS.VIEW_AUDIT)) {
    document.getElementById('menu-auditoria').style.display = 'none';
  }
  
  document.getElementById('username').textContent = user.email;
  document.getElementById('userrole').textContent = user.rol || 'VIEWER';
}
```

---

## 🧪 Testing

- [ ] Login con diferentes usuarios
- [ ] Verificar token expira (7 días)
- [ ] Verificar sesión logout (30 min inactividad)
- [ ] Admin puede crear usuarios
- [ ] VIEWER solo ve, no puede crear
- [ ] EDITOR puede crear/editar propias
- [ ] Auditoría registra cambios correctamente
- [ ] Landing page con token funciona
- [ ] Rate limiting activa (100 req/min)

---

## 📚 Variables Globales Nuevas

```javascript
const PERMISSIONS = {
  VIEW_COTIZACIONES: 1,
  CREATE_COTIZACIONES: 2,
  EDIT_OWN: 4,
  EDIT_ALL: 8,
  DELETE_OWN: 16,
  DELETE_ALL: 32,
  VIEW_AUDIT: 64,
  MANAGE_USERS: 128,
  VIEW_LANDING: 256,
};

let currentUser = null;    // {email, rol, permissions}
let userToken = null;      // String de 64 caracteres
let inactivityTimer = null; // Para logout automático
```

---

## ⏱️ Timeline

- **Hoy:** Fase 1-2 (Autenticación + Panel admin)
- **Mañana:** Fase 3-4 (Auditoría + Permisos en UI)
- **Testing:** Validar todo funciona

---

## 🚀 Despliegue

1. Actualizar index.html con nuevas funciones
2. Deployer Worker v2 (ya hecho ✓)
3. Probar en GitHub Pages
4. Comunicar a usuarios: "Nuevo sistema de usuarios"
5. Generar token para admin
6. Agregar otros usuarios

