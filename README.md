# Banco Orbital — Backend

[![CI](https://github.com/maxibertaina03/banco-backend/actions/workflows/ci.yml/badge.svg)](https://github.com/maxibertaina03/banco-backend/actions/workflows/ci.yml)

API REST del sistema de homebanking **Orbital**. Cubre autenticación con
Clerk, operaciones de cuentas, transferencias internas y externas vía
Banco Central Brocoly, depósitos en efectivo y un audit log permanente
de cada operación.

Forma parte del proyecto integrador de Práctica Profesionalizante I. El
frontend vive en un repo separado: [banco-frontend](https://github.com/maxibertaina03/banco-frontend).

---

## 📚 Tabla de contenidos

- [Stack](#-stack)
- [Setup rápido](#-setup-rápido)
- [Variables de entorno](#-variables-de-entorno)
- [Scripts disponibles](#-scripts-disponibles)
- [Estructura del proyecto](#-estructura-del-proyecto)
- [Endpoints principales](#-endpoints-principales)
- [Arquitectura y patrones](#-arquitectura-y-patrones)
- [Tests](#-tests)
- [CI/CD](#-cicd)
- [Decisiones de seguridad](#-decisiones-de-seguridad)

---

## 🛠 Stack

| Capa | Tecnología | Por qué |
|---|---|---|
| Runtime | Node.js 18 LTS | LTS soportado por Supabase y la mayoría de hosts |
| Framework HTTP | Express 5 | Estándar de la industria, ecosistema enorme |
| Base de datos | PostgreSQL (Supabase) | ACID, transacciones reales, FOR UPDATE para race conditions |
| Auth | Clerk | Delegamos hash de contraseñas + flujos OAuth |
| Validación | Zod 4 | Type-safe, mismos schemas pueden compartirse con frontend |
| Logging | pino 10 + pino-http | JSON estructurado en prod, pretty en dev, request-id auto |
| HTTP client | Axios | Llamadas al Banco Central Brocoly |
| Testing | Vitest 1.6 | Compatible con Node 18, sintaxis moderna |

**Servicio externo:** Banco Central Brocoly (`https://centralbank.brocoly.cc`) maneja transferencias interbancarias.

---

## 🚀 Setup rápido

```bash
# 1. Clonar
git clone https://github.com/maxibertaina03/banco-backend.git
cd banco-backend

# 2. Dependencias
npm ci

# 3. Variables de entorno
cp .env.example .env
# Editar .env con tus credenciales

# 4. Base de datos
npm run db:setup          # corre schema.sql + seed.sql
# Aplicar migraciones manualmente (no se aplican automático):
psql "$DATABASE_URL" -f migrations/20260527_idempotency_keys.sql

# 5. Configurar Banco Central (una vez)
# Ver sección "Configuración del Banco Central" más abajo

# 6. Levantar API
npm run dev               # con watch
# o
npm start                 # producción
```

Por defecto escucha en `http://localhost:3001`.

**Healthcheck:** `GET http://localhost:3001/api/health` (público, no requiere auth).

---

## 🔐 Variables de entorno

```bash
# Server
PORT=3001                          # default 3001
NODE_ENV=development               # production en deploy
LOG_LEVEL=debug                    # debug | info | warn | error (default info en prod)

# Base de datos
DATABASE_URL=postgresql://...      # connection string completa de Supabase

# Auth (Clerk)
CLERK_SECRET_KEY=sk_...            # del dashboard de Clerk
CLERK_WEBHOOK_SIGNING_SECRET=whsec_...

# CORS
CORS_ORIGINS=http://localhost:5173,https://miapp.com   # coma-separado o '*' (no recomendado en prod)
```

> ⚠️ El secret de Clerk **no** se rota fácilmente — si lo expusiste, regenerá uno nuevo desde el dashboard.

---

## 📜 Scripts disponibles

| Script | Qué hace |
|---|---|
| `npm run dev` | Levanta el server con `node --watch` (reinicia al guardar) |
| `npm start` | Levanta el server en modo producción |
| `npm test` | Corre los 81 tests con Vitest una vez |
| `npm run test:watch` | Tests en modo watch |
| `npm run test:ui` | UI gráfica de tests |
| `npm run db:setup` | Ejecuta `schema.sql` + `seed.sql` (idempotente) |
| `npm run db:schema` | Solo el schema |
| `npm run db:seed` | Solo el seed |

---

## 📁 Estructura del proyecto

```
banco-backend/
├── src/
│   ├── app.js                        # Wiring de Express: middlewares globales, routers
│   ├── server.js                     # Entry point, conexión inicial a BD
│   ├── config/
│   │   └── env.js                    # Carga + valida variables de entorno
│   ├── db/
│   │   └── pool.js                   # Connection pool de pg (max 20)
│   ├── dtos/                         # Mapeos fila→respuesta pública (filtra campos sensibles)
│   │   ├── persona.dto.js
│   │   ├── usuario.dto.js
│   │   ├── cuenta.dto.js
│   │   ├── transaccion.dto.js
│   │   ├── destinatario.dto.js
│   │   ├── rol.dto.js
│   │   ├── inputs.js                 # Normaliza inputs (lowercase email, trim alias, etc.)
│   │   └── ...
│   ├── middlewares/
│   │   ├── clerk-auth.js             # Valida JWT de Clerk
│   │   ├── require-active-user.js    # Activo en BD
│   │   ├── require-complete-profile.js
│   │   ├── require-roles.js          # RBAC
│   │   ├── ownership.js              # "solo tus datos"
│   │   ├── validate.js               # Zod safeParse
│   │   ├── idempotency.js            # Idempotency-Key para POSTs sensibles
│   │   ├── error-handler.js
│   │   └── not-found.js
│   ├── modules/
│   │   ├── auth-router.js + auth-service.js
│   │   ├── transacciones-router.js + transacciones-service.js
│   │   ├── relations-router.js       # endpoints de personas/cuentas anidados
│   │   ├── central-bank-router.js + central-bank-service.js + central-bank-client.js
│   │   ├── clerk-webhook-router.js   # webhooks de Clerk para sincronización
│   │   ├── crud-router.js + crud-service.js  # CRUD genérico admin
│   │   └── entities.js               # Config de entidades CRUD
│   ├── utils/
│   │   ├── logger.js                 # pino instance
│   │   ├── http-error.js             # Error con status + details
│   │   ├── pagination.js             # paginationSchema (zod)
│   │   ├── audit.js                  # writeAuditLog
│   │   ├── sql.js                    # buildFilters, buildInsertQuery, etc.
│   │   ├── access-control.js
│   │   └── ttl-cache.js
│   └── routes/
│       └── index.js                  # Monta todos los routers bajo /api
├── tests/
│   ├── dtos/                         # 26 tests
│   ├── middlewares/                  # 10 tests (idempotency)
│   ├── modules/                      # 35 tests (auth + transacciones)
│   └── utils/                        # 10 tests (pagination)
├── migrations/
│   ├── 20260420_profile_onboarding.sql
│   ├── 20260421_central_bank_integration.sql
│   ├── 20260521_security_hardening.sql
│   └── 20260527_idempotency_keys.sql
├── scripts/
│   └── db-setup.js                   # Ejecuta schema + seed
├── schema.sql                        # DDL completo
├── seed.sql                          # Datos de prueba
├── vitest.config.js
└── .github/workflows/ci.yml          # CI: tests + audit
```

---

## 🔌 Endpoints principales

> Toda ruta bajo `/api` requiere JWT de Clerk + usuario activo + perfil completo.
>
> `GET /api/health` es **público** (smoke check).

### Auth

| Método | Path | Descripción |
|---|---|---|
| POST | `/auth/login` | Sincroniza usuario Clerk con BD |
| GET  | `/auth/profile` | Perfil del usuario autenticado |
| PUT  | `/auth/profile` | Completar perfil (DNI, fecha nac., etc.) |
| POST | `/auth/logout` | Stateless logout |

### Personas y cuentas

| Método | Path | Descripción |
|---|---|---|
| GET  | `/api/personas/:id/full` | Perfil completo (cuentas + destinatarios + roles) |
| GET  | `/api/personas/:id/cuentas` | Cuentas de la persona |
| GET  | `/api/personas/:id/transacciones` | Historial agregado por persona |
| GET  | `/api/cuentas/:id/transacciones` | Historial de una cuenta |
| POST | `/api/personas/:id/cuentas/apertura-basica` | Onboarding: abre Caja de Ahorro + intenta registrar en Brocoly |

### Transferencias y depósitos

| Método | Path | Descripción |
|---|---|---|
| GET  | `/api/transacciones` | Listar las propias (filtro automático por persona) |
| GET  | `/api/transacciones/:id` | Detalle |
| POST | `/api/transacciones` | Transferencia con contrato Banco Central. Acepta `Idempotency-Key` |
| POST | `/api/transacciones/operar` | Transferencia con destinatario/CBU/alias. Acepta `Idempotency-Key` |
| POST | `/api/transacciones/deposito` | **Depósito en efectivo** (solo admin/operador/tesoreria) |
| GET  | `/api/transacciones/destinatario/resolver?alias=…` o `?cbu=…` | Lookup en Brocoly con caché TTL 60s |
| POST | `/api/transacciones/sync-incoming` | Trae las transferencias entrantes desde Brocoly |

### Destinatarios (agenda)

| Método | Path | Descripción |
|---|---|---|
| GET    | `/api/destinatarios` | Solo los del usuario actual |
| POST   | `/api/destinatarios` | Agregar |
| PUT    | `/api/destinatarios/:id` | Editar |
| DELETE | `/api/destinatarios/:id` | Eliminar |

### Banco Central (Brocoly)

| Método | Path | Descripción |
|---|---|---|
| GET/PUT | `/api/central-bank/config` | Configuración (admin) |
| POST | `/api/central-bank/persons` | Registrar persona en Brocoly |
| GET  | `/api/central-bank/persons/alias/:alias` | Buscar por alias |
| GET  | `/api/central-bank/persons/:cbu` | Buscar por CBU |
| PUT  | `/api/central-bank/persons/:cbu/alias` | Asignar alias |
| POST | `/api/central-bank/sync/accounts/bulk` | Sincronizar todas las cuentas locales |
| POST | `/api/central-bank/sync/incoming` | Backoffice: traer entrantes para todos |

### CRUD genérico (admin)

`GET/POST/PUT/DELETE /api/{personas|usuarios|cuentas|...}` para administración interna vía Postman.

---

### Idempotencia

Los endpoints de transferencia y depósito aceptan el header `Idempotency-Key: <UUID v4>`. Si el cliente reintenta con la misma key:

- **Misma operación completada** → devuelve la respuesta cacheada (status + body) con header `Idempotent-Replay: true`.
- **Misma operación en curso** → 409.
- **Key reutilizada con body distinto** → 422.

TTL en BD: 24 horas. La limpieza es manual (cron externo): `DELETE FROM idempotency_keys WHERE expires_at < NOW();`.

---

## 🏗 Arquitectura y patrones

### Tres capas

```
Routers (HTTP)  →  Services (lógica de negocio)  →  Repository (pool de pg)
                                ↓
                          DTOs (filtran respuesta)
```

### Dependency Injection en services

Los services principales (`transacciones-service.js`, `auth-service.js`) exportan una **factory**:

```js
function createTransaccionesService({ pool, centralBankService, writeAuditLog } = {}) {
  // ...
  return { listForUser, getByIdForUser, createContractTransfer, operate, createDeposit, ... };
}

const defaultService = createTransaccionesService();   // usa deps reales
module.exports = { ...defaultService, createTransaccionesService };
```

En producción el router usa la instancia default. En tests se inyectan mocks puros:

```js
const service = createTransaccionesService({ pool: mockPool, centralBankService: mockBrocoly });
```

### DTOs como contrato de salida

`src/dtos/` mapea fila de BD → respuesta pública. Agregar una columna a la BD **no** la expone automáticamente — hay que actualizarla en el DTO. Esto previene leaks accidentales de campos sensibles (`clerk_id`, `password_hash`, etc.).

### Validación Zod en cada entrada

```js
router.post('/operar',
  idempotency,
  validate(transferSchema),         // Zod safeParse
  asyncHandler(async (req, res) => { /* ... */ })
);
```

Si la validación falla → 400 con `details` por campo.

---

## 🧪 Tests

**81 tests verdes en ~1.3s**. Sin BD real ni Clerk real — todo mockeado por DI.

```
tests/
├── dtos/                              (26 tests)
│   ├── persona.dto.test.js
│   ├── usuario.dto.test.js
│   ├── cuenta.dto.test.js
│   ├── transaccion.dto.test.js
│   └── inputs.test.js
├── middlewares/
│   └── idempotency.test.js            (10 tests)
├── modules/
│   ├── auth-service.test.js           (18 tests)
│   └── transacciones-service.test.js  (17 tests)
└── utils/
    └── pagination.test.js             (10 tests)
```

Correr:

```bash
npm test                # one-shot
npm run test:watch      # watch mode
```

---

## 🔄 CI/CD

GitHub Actions corre en cada push y PR. Ver [.github/workflows/ci.yml](.github/workflows/ci.yml).

| Job | Qué hace |
|---|---|
| `test` | `node --check` en todos los `.js` + `npm test` + smoke test `require('./src/app')` |
| `security-audit` | `npm audit --audit-level=high` (informativo) |

**No se puede mergear PR con CI rojo** si configurás branch protection en GitHub.

---

## 🔒 Decisiones de seguridad

1. **Contraseñas**: no las almacenamos. Clerk maneja el hash + flujos OAuth.
2. **Datos sensibles**: filtrados por DTOs. `clerk_id` no viaja al cliente.
3. **Authorization**: 4 chequeos por request (JWT → activo → perfil completo → ownership).
4. **Race conditions en transferencias**: `SELECT ... FOR UPDATE` + transacciones SQL.
5. **Doble-débito por retry**: middleware `idempotency` con `INSERT ... ON CONFLICT DO NOTHING`.
6. **DoS por filtros sin validar**: `paginationSchema` cap `limit ≤ 100`.
7. **Rate limit**: 300 req/15min global, 20 req/15min en `/auth`.
8. **Helmet + CORS** explícitos en `app.js`.
9. **Logs**: `pino.redact` esconde `Authorization`, `Idempotency-Key`, cookies, `password`, `token`, `secret`, `dni`.
10. **Audit log**: cada CREATE/UPDATE/DELETE queda en tabla `auditoria` con `payload_antes`/`payload_despues`.

---

## 📄 Documentación adicional

- [CHANGELOG.md](../CHANGELOG.md) — bitácora completa de decisiones arquitectónicas.
- Documentación API Brocoly: `api_banco_central_documentacion.pdf` en raíz del proyecto.
- Diagrama de BD: Schema Visualizer de Supabase (entregable 1.2).
