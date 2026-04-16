# Guía de Integración Clerk - Banco API

## ¿Qué se agregó?

Se integró **Clerk** como sistema de autenticación. Ahora puedes:
1. Registrar usuarios enlazando una persona existente con su Clerk ID
2. Loguearse con token JWT de Clerk
3. Obtener el perfil del usuario autenticado
4. Desloguearse

## Instalación y Configuración

### 1. Instalar Clerk (ya hecho)
```bash
npm install @clerk/express
```

### 2. Obtener Clerk Secret Key
- Ve a [dashboard.clerk.com](https://dashboard.clerk.com)
- Crea una aplicación
- En "API Keys", copia el **Secret Key**
- Agrégala al archivo `.env`:

```env
CLERK_SECRET_KEY=sk_test_xxxxxxxxxxxxx
DATABASE_URL=postgresql://...
PORT=3000
```

### 3. La estructura ahora es:

```
PERSONAS (usuarios del sistema)
   ↓
USUARIOS (enlace con Clerk)
   ├── persona_id → PERSONAS
   ├── clerk_id → Token de Clerk
   └── activo → Boolean
   
AUDITORIA (registra acciones)
   └── usuario_id → USUARIOS
```

## Endpoints de Autenticación

### POST /auth/login
**Autentica al usuario y sincroniza con BD.**

Requiere: Header `Authorization: Bearer <token_clerk>`

Respuesta (201):
```json
{
  "message": "Login exitoso.",
  "user": {
    "id": "uuid",
    "persona_id": "uuid",
    "clerk_id": "user_xxx",
    "nombre": "Juan",
    "apellido": "Pérez",
    "email": "juan@ejemplo.com",
    "activo": true
  }
}
```

### POST /auth/register
**Vincula una persona existente con su Clerk ID.**

Body (JSON):
```json
{
  "persona_id": "550e8400-e29b-41d4-a716-446655440000",
  "clerk_id": "user_xxx"
}
```

Respuesta (201):
```json
{
  "message": "Usuario registrado exitosamente.",
  "user": {
    "id": "uuid",
    "persona_id": "uuid",
    "clerk_id": "user_xxx",
    "activo": true,
    "created_at": "2026-04-16T10:00:00Z"
  }
}
```

### GET /auth/profile
**Obtiene el perfil completo del usuario autenticado.**

Requiere: Header `Authorization: Bearer <token_clerk>`

Respuesta (200):
```json
{
  "message": "Perfil obtenido.",
  "user": {
    "id": "uuid",
    "persona_id": "uuid",
    "clerk_id": "user_xxx",
    "nombre": "Juan",
    "apellido": "Pérez",
    "dni": "12345678",
    "email": "juan@ejemplo.com",
    "telefono": "555-1234",
    "fecha_nacimiento": "1990-01-01",
    "activo": true,
    "roles": [
      { "id": "uuid", "nombre": "Admin", "descripcion": "..." }
    ],
    "usuario_created_at": "2026-04-16T10:00:00Z",
    "persona_created_at": "2026-04-16T10:00:00Z"
  }
}
```

### POST /auth/logout
**Desactiva la sesión del usuario.**

Requiere: Header `Authorization: Bearer <token_clerk>`

Respuesta (200):
```json
{
  "message": "Logout exitoso."
}
```

## Flujo de Uso en el Frontend

### 1. Registrar persona primero (sin autenticación)
```javascript
// POST /api/personas
const persona = await fetch('http://localhost:3000/api/personas', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    nombre: 'Juan',
    apellido: 'Pérez',
    dni: '12345678',
    email: 'juan@ejemplo.com',
    telefono: '555-1234'
  })
});
const { id: persona_id } = await persona.json();
```

### 2. Usuario se loguea con Clerk
```javascript
// En tu frontend con Clerk JS:
const session = await clerk.session();
const token = await session.getToken();
```

### 3. Registrar usuario en la BD
```javascript
// POST /auth/register
const usuario = await fetch('http://localhost:3000/auth/register', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    persona_id: '550e8400-e29b-41d4-a716-446655440000',
    clerk_id: session.user.id
  })
});
```

### 4. Loguearse en la API
```javascript
// POST /auth/login
const login = await fetch('http://localhost:3000/auth/login', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  }
});
const { user } = await login.json();
```

### 5. Usar token en peticiones autenticadas
```javascript
// Ahora el usuario puede hacer peticiones a /api/...
// Puedes adjuntar el usuario_id a las peticiones para auditoria

const cuentas = await fetch('http://localhost:3000/api/cuentas', {
  headers: {
    'Authorization': `Bearer ${token}`
  }
});
```

## Arquitectura de Autenticación

```
┌─────────────────────────────────────┐
│       Frontend (Clerk)              │
│  - Clerk.js SDK                     │
│  - login/logout UI                  │
│  - getToken() para JWT              │
└────────────┬────────────────────────┘
             │ Authorization: Bearer <token>
             ↓
┌─────────────────────────────────────┐
│     Backend (Express + Clerk)       │
│  - Middleware: clerkAuth            │
│  - Verifica token JWT               │
│  - Adjunta req.auth (clerk_id)      │
└────────────┬────────────────────────┘
             │ usa clerk_id
             ↓
┌─────────────────────────────────────┐
│     Base de Datos (PostgreSQL)      │
│  - usuarios (clerk_id)              │
│  - personas (nombre, email, etc)    │
│  - auditoria (usuario_id, accion)  │
└─────────────────────────────────────┘
```

## Proteger Endpoints

Si quieres que un endpoint requiera autenticación, simplemente agrega el middleware:

```javascript
const { clerkAuth } = require('../middlewares/clerk-auth');

router.get('/mi-ruta-protegida',
  clerkAuth,  // ← Este middleware verifica el token
  asyncHandler(async (req, res) => {
    // req.auth contiene { clerk_id, ... }
    const clerkId = req.auth.clerk_id;
    res.json({ message: 'datos privados' });
  })
);
```

## Auditoría

Cada acción de un usuario debería registrarse en `auditoria`:

```javascript
await pool.query(
  `INSERT INTO auditoria 
   (usuario_id, accion, entidad, entidad_id, ip_address)
   VALUES ($1, $2, $3, $4, $5)`,
  [usuarioId, 'crear', 'cuentas', cuentaId, req.ip]
);
```

## Ejemplos en Postman

### 1. Login
```
POST http://localhost:3000/auth/login
Authorization: Bearer <token_de_clerk>
Content-Type: application/json
```

### 2. Register
```
POST http://localhost:3000/auth/register
Content-Type: application/json

{
  "persona_id": "550e8400-e29b-41d4-a716-446655440000",
  "clerk_id": "user_123456"
}
```

### 3. Profile
```
GET http://localhost:3000/auth/profile
Authorization: Bearer <token_de_clerk>
```

### 4. Logout
```
POST http://localhost:3000/auth/logout
Authorization: Bearer <token_de_clerk>
```

## Errores Comunes

| Error | Causa | Solución |
|-------|-------|----------|
| `Token no proporcionado` | Falta header Authorization | Agrega `Authorization: Bearer <token>` |
| `Token inválido o expirado` | Token de Clerk inválido/vencido | Obtén un nuevo token de Clerk |
| `Usuario no encontrado` | No existe usuario con ese clerk_id | Primero registra con `/auth/register` |
| `No existe la persona` | El persona_id no existe | Crea una persona primero con `POST /api/personas` |
| `CLERK_SECRET_KEY falta` | Variable de entorno no configurada | Agrega `CLERK_SECRET_KEY` al `.env` |

---

**Próximos pasos recomendados:**
1. Configurar auditoria automática para cada cambio
2. Agregar roles y permisos (ya están en la BD)
3. Proteger endpoints según el rol del usuario
4. Integrar con frontend en Clerk
