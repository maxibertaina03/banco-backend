# Guía de Integración Clerk - Banco API

## Estado actual

La integración ya permite:
1. Crear usuarios en Clerk a partir de la base local
2. Reconciliar `clerk_id` en la tabla `usuarios`
3. Autenticar requests del backend con JWT de Clerk
4. Obtener el perfil local usando el usuario autenticado de Clerk
5. Resolver el usuario autenticado desde el claim `sub` del token

## Variables de entorno

Archivo `.env` del backend:

```env
PORT=3001
DATABASE_URL=postgresql://...
CLERK_SECRET_KEY=sk_test_...
```

## Flujo real de migración usado

### 1. Normalizar datos en la base

Antes de importar, los usuarios deben tener datos compatibles con Clerk:
- email válido
- username compatible
- estrategia de autenticación coherente con la instancia

### 2. Exportar usuarios desde PostgreSQL

```bash
npm run clerk:export
```

Genera:

```text
usuarios-para-clerk.csv
```

### 3. Importar usuarios en Clerk por API

```bash
npm run clerk:import
```

Este paso crea los usuarios directamente en Clerk usando la Backend API.

### 4. Reconciliar `clerk_id` en la base local

```bash
npm run clerk:reconcile
```

Esto busca usuarios en Clerk por email y actualiza la tabla `usuarios`.

## Estructura de datos

```text
PERSONAS
  └── datos personales base

USUARIOS
  ├── persona_id
  ├── clerk_id
  └── activo

AUDITORIA
  └── usuario_id
```

## Endpoints de Autenticación

### POST /auth/login
**Autentica al usuario contra Clerk y devuelve el usuario local vinculado.**

Requiere: Header `Authorization: Bearer <token_clerk>`

Respuesta (200):
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
**Vincula una persona existente con el usuario autenticado en Clerk.**

Requiere: Header `Authorization: Bearer <token_clerk>`

Body (JSON):
```json
{
  "persona_id": "550e8400-e29b-41d4-a716-446655440000"
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
**Desactiva localmente el usuario.**

Requiere: Header `Authorization: Bearer <token_clerk>`

Respuesta (200):
```json
{
  "message": "Logout exitoso."
}
```

## Flujo real del frontend

### 1. El usuario inicia sesión en Clerk

Se probó correctamente con:
- `username + password`

### 2. Next.js obtiene la sesión y el token

El route handler del frontend consulta:
- datos del usuario en Clerk
- perfil local en el backend

### 3. El backend resuelve el usuario autenticado

El backend toma el identificador real desde el claim `sub` del token de Clerk y busca ese `clerk_id` en `usuarios`.

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
│  - Adjunta req.auth (userId/sub)    │
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
const { clerkAuth, extractClerkUserId } = require('../middlewares/clerk-auth');

router.get('/mi-ruta-protegida',
  clerkAuth,  // ← Este middleware verifica el token
  asyncHandler(async (req, res) => {
    // req.auth contiene el token decodificado y req.auth.userId
    const clerkId = extractClerkUserId(req.auth);
    res.json({ message: 'datos privados' });
  })
);
```

## Estado observado en la UI

- el login con Clerk ya funciona en el frontend
- el dashboard muestra el usuario autenticado de Clerk
- el route handler del frontend intenta consultar el backend en este orden:
  - `BACKEND_API_URL`
  - `NEXT_PUBLIC_API_URL`
  - `http://localhost:3001`
  - `http://localhost:3000`

Esto reduce errores locales cuando frontend y backend quedan levantados en puertos distintos.

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
POST http://localhost:3001/auth/login
Authorization: Bearer <token_de_clerk>
Content-Type: application/json
```

### 2. Register
```
POST http://localhost:3001/auth/register
Authorization: Bearer <token_de_clerk>
Content-Type: application/json

{
  "persona_id": "550e8400-e29b-41d4-a716-446655440000"
}
```

### 3. Profile
```
GET http://localhost:3001/auth/profile
Authorization: Bearer <token_de_clerk>
```

### 4. Logout
```
POST http://localhost:3001/auth/logout
Authorization: Bearer <token_de_clerk>
```

## Errores Comunes

| Error | Causa | Solución |
|-------|-------|----------|
| `Token no proporcionado` | Falta header Authorization | Agrega `Authorization: Bearer <token>` |
| `Token inválido o expirado` | Token de Clerk inválido/vencido | Obtén un nuevo token de Clerk |
| `Usuario no encontrado` | No existe usuario con ese `clerk_id` en tabla `usuarios` | Ejecutar reconciliación o vincular usuario |
| `No existe la persona` | El persona_id no existe | Crea una persona primero con `POST /api/personas` |
| `CLERK_SECRET_KEY falta` | Variable de entorno no configurada | Agrega `CLERK_SECRET_KEY` al `.env` |

---

## Próximos pasos recomendados

1. Reemplazar el `logout` local por un flujo de cierre de sesión real de Clerk
2. Proteger rutas del API por rol
3. Eliminar credenciales expuestas y rotar claves
4. Agregar una guía de reseteo de password para usuarios migrados
