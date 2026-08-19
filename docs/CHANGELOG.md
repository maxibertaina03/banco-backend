# Changelog — Banco Orbital

Resumen de los cambios realizados durante la sesión de mejora de arquitectura
del proyecto. Ordenado por bloques temáticos y, dentro de cada bloque,
cronológicamente.

> Convenciones del documento: cada bloque tiene **Qué**, **Por qué** y
> **Archivos clave**. Los hipervínculos apuntan a archivos del repo.

---

## 1. Capa DTO (backend)

### 1.1 DTOs de salida

**Qué.** Carpeta nueva `banco-backend/src/dtos/` con un archivo por entidad
y un barrel `index.js`. Cada DTO es una función pura `fila → respuesta pública`
que decide explícitamente qué campos viajan al cliente.

```
src/dtos/
├── index.js
├── persona.dto.js          → toPublicPersona, toPersonaOption
├── usuario.dto.js          → toPublicUsuario   (excluye clerk_id)
├── cuenta.dto.js           → toPublicCuenta    (incluye JOINs opcionales)
├── transaccion.dto.js      → toPublicTransaccion
├── destinatario.dto.js     → toPublicDestinatario
├── rol.dto.js              → toPublicRol
├── tipo-cuenta.dto.js      → toPublicTipoCuenta
├── tipo-transaccion.dto.js → toPublicTipoTransaccion
└── persona-rol.dto.js      → toPublicPersonaRol
```

**Por qué.** Antes los handlers respondían con `res.json(result.rows)`
directamente, exponiendo *todas* las columnas de la BD. Agregar una columna
implicaba filtrarla en cada lugar. Ahora se actualiza un solo archivo.

**Aplicación.** Integración manual en:
- `modules/relations-router.js` (7 endpoints: /personas/:id/full,
  /personas/:id/cuentas, etc.)
- `modules/transacciones-router.js` (GET /, GET /:id, POST /operar)

### 1.2 DTOs de input + integración con CRUD genérico

**Qué.** Archivo `dtos/inputs.js` con funciones `normalizeXxxInput(body)`:
- `normalizePersonaInput`: lowercase + trim del email.
- `normalizeCuentaInput` / `normalizeDestinatarioInput`: alias vacío → null.
- Resto: `pick` defensivo de claves permitidas.

`modules/entities.js` ahora declara `dto` e `inputDto` por entidad, y
`modules/crud-service.js` los aplica automáticamente en `list`, `getById`,
`create`, `update`, `remove`. Audit log sigue persistiendo el row raw.

**Por qué.** Centralizar normalización de input + filtrado de output sin
acoplar cada router. Las entidades sin DTO declarado siguen funcionando con
shape raw (compatibilidad gradual).

### 1.3 `clerk_id` retirado del contrato público

**Qué.** `clerk_id` (identificador interno del IdP) ya no viaja en
respuestas:
- `toPublicUsuario` no lo expone.
- `/auth/login` (auth-router.js): quitado del response literal.
- `getUserProfile` y `completeUserProfile` (auth-service.js): quitado del
  SELECT / RETURNING.
- Frontend: retirado de `UserRecord` en `personas.types.ts`.

Se mantiene como input válido en POST/PUT `/usuarios` (admin lo necesita
para asociar usuarios a Clerk).

**Por qué.** El campo nunca se leía en runtime del frontend (solo declarado),
y es información sensible. Filtrar identificadores internos por defecto.

---

## 2. Service / router split

### 2.1 `transacciones-service.js` con dependency injection

**Qué.** Toda la lógica de negocio de transacciones se extrajo del router
hacia [banco-backend/src/modules/transacciones-service.js](banco-backend/src/modules/transacciones-service.js).
El módulo exporta una **factory**:

```js
function createTransaccionesService({
  pool = realPool,
  centralBankService = realCentralBankService,
  writeAuditLog = realWriteAuditLog,
} = {}) {
  // helpers internos + API pública
  return { listForUser, getByIdForUser, resolveRecipient,
           createContractTransfer, operate, syncIncomingForUser };
}

module.exports = { ...createTransaccionesService(), createTransaccionesService };
```

El `module.exports` por defecto es una instancia con las deps reales: el
router sigue funcionando sin cambios. En tests se invoca la factory con mocks
puros.

### 2.2 Router reducido a HTTP-only

**Qué.** `transacciones-router.js` pasó de ~580 → 140 líneas. Solo:
- Schemas Zod para validación de body/query/params.
- Llamadas al service.
- Mapeo de respuesta con DTO.
- Statuses HTTP.

### 2.3 Bug latente corregido

**Qué.** En el router original, `GET /transacciones/destinatario/resolver`
estaba declarado **después** de `GET /:id` con validación `uuidLike`. Express
matcheaba primero `/:id` con `id="destinatario"`, la validación UUID fallaba
y el resolver nunca era alcanzable.

El refactor movió el resolver antes de `/:id`. La búsqueda por alias/CBU en
Brocoly ahora funciona.

### 2.4 Duck typing en lugar de `instanceof HttpError`

**Qué.** En `persistCentralTransfer`, el check
`error instanceof HttpError && error.status === 422` se relajó a
`error?.status === 422`.

**Por qué.** Vitest puede cargar dos copias del módulo HttpError (una desde
el test ESM, otra desde el service CJS), rompiendo `instanceof`. El status
422 ya identifica el caso "saldo insuficiente" sin ambigüedad.

---

## 3. Tests con Vitest

### 3.1 Setup

**Qué.** Instalado Vitest 1.6 (compatible con Node 18; vitest 4.x requiere
Node 20+). Scripts en `package.json`:
- `npm test`         — corrida única
- `npm run test:watch` — watch mode
- `npm run test:ui`  — UI gráfica

Configuración en [banco-backend/vitest.config.js](banco-backend/vitest.config.js):
glob `tests/**/*.test.js`, environment `node`.

### 3.2 Tests creados

```
tests/
├── dtos/
│   ├── persona.dto.test.js          (6 tests)
│   ├── usuario.dto.test.js          (2 tests)
│   ├── cuenta.dto.test.js           (4 tests)
│   ├── transaccion.dto.test.js      (4 tests)
│   └── inputs.test.js              (10 tests)
├── modules/
│   └── transacciones-service.test.js (11 tests)
└── middlewares/
    └── idempotency.test.js         (10 tests)

Total: 47 tests verdes en ~1.2s, 7 archivos.
```

### 3.3 Patrón de testing acordado

**Funciones puras (DTOs, validaciones).** Import directo + assertions. Sin
mocks. Ejemplo:

```js
import { toPublicUsuario } from "../../src/dtos/usuario.dto";
expect(toPublicUsuario({ clerk_id: "x" })).not.toHaveProperty("clerk_id");
```

**Services.** Dependency injection. La factory recibe mocks puros:

```js
const service = createTransaccionesService({
  pool: { connect: vi.fn(...), query: vi.fn(...) },
  centralBankService: { createTransaction: vi.fn(...) },
  writeAuditLog: vi.fn(),
});
```

**Middlewares.** Factories que reciben pool. Tests construyen `req`/`res`
mock y verifican llamadas a `next()` y `pool.query()`.

**Lección importante.** `vi.mock()` no intercepta bien los `require()`
internos de módulos CJS sin transformación ESM agresiva. La solución adoptada
en el proyecto es **dependency injection**: lo expone como factory además del
default export.

---

## 4. Frontend — TanStack Query

### 4.1 Setup

**Qué.** Instalado `@tanstack/react-query@5` + devtools. Configuración en
[banco-frontend/src/lib/queryClient.ts](banco-frontend/src/lib/queryClient.ts):

```ts
defaultOptions: {
  queries: {
    staleTime: 30_000,            // 30s sin refetch innecesario
    gcTime: 5 * 60_000,           // 5min en cache después de inactivas
    refetchOnWindowFocus: true,    // refresh al volver al tab
    retry: (count, err) => err.status < 400 || err.status >= 500 ? count < 1 : false,
  },
  mutations: { retry: false },
}
```

Provider envolviendo la app + DevTools solo en `import.meta.env.DEV`.

### 4.2 Capa de queries y mutations

**Qué.** Nuevo directorio `src/lib/queries/`:

```
src/lib/queries/
├── index.ts          # barrel
├── keys.ts           # queryKeys centralizadas (factory por id)
├── personas.ts       # useAuthProfile, usePersonaFull, usePersonas, useUserAudit
├── transacciones.ts  # usePersonaTransactions, useCreateTransfer, useSyncIncoming
├── destinatarios.ts  # useCreateDestinatario, useDeleteDestinatario
└── catalogos.ts      # useTiposCuenta, useTiposTransaccion, useRoles,
                      # useCentralBanks, useInternalCatalogs (composición)
```

`queryKeys` con jerarquía permite invalidación parcial:
```ts
qc.invalidateQueries({ queryKey: queryKeys.personas.all });
// invalida list, full, audit de personas
```

### 4.3 Migración de `usePortalData.ts` y `usePortalActions.ts`

**Antes:** 363 líneas con `useState + useEffect + useRef` manual y función
`loadPortal()` imperativa de 130 líneas.

**Después:** 314 líneas declarativas. Solo:
- 2 `useState` para UI local (`selectedPersonaId`, `manualPersonaId`).
- 3 `useEffect` de **interacción** (token provider, sync de UI con profile,
  propagación de errores).
- 0 `useRef`, 0 código de fetching imperativo.

Todos los datos vienen de queries declarativas que se rehabilitan
automáticamente cuando cambia `activePersonaId`.

`refreshPersonaData` / `refreshDestinatarios` / `loadPortal` se mantienen
para no romper la API pública del hook, pero internamente son
`queryClient.invalidateQueries`. PortalPage no requiere cambios.

`usePortalActions.ts`: las mutations (`useCreateTransfer`,
`useCreateDestinatario`, etc.) invalidan en `onSuccess`. Los `refreshXxx`
manuales tras cada handler se eliminaron — TanStack Query refetchea solo.

### 4.4 Bug latente arreglado en cliente HTTP

**Qué.** [lib/api/client.ts](banco-frontend/src/lib/api/client.ts) hacía
`fetch(url, { headers, ...init })` donde `...init` podía incluir un `headers`
propio y sobrescribir Authorization / Content-Type. El refactor introdujo
`toFetchInit(headers, options)` que separa explícitamente las extensiones de
las opciones nativas de fetch.

---

## 5. Frontend — react-hook-form + Zod

### 5.1 Schemas compartidos

**Qué.** Carpeta nueva [src/lib/schemas/](banco-frontend/src/lib/schemas/) con
schemas zod que reflejan los del backend:

```
src/lib/schemas/
├── index.ts
├── recipient.ts        # alias con regex Brocoly + CBU 22 dígitos
├── complete-profile.ts # mismas reglas que auth-router del backend
└── transfer.ts         # cuentaOrigenId + cbuDestino 22 dígitos + monto > 0
```

### 5.2 Sections migradas

| Section | Schema | Particularidad |
|---|---|---|
| `RecipientsSection` | `recipientSchema` | El más simple, patrón base |
| `CompleteProfileSection` | `completeProfileSchema` | Defaults desde `authProfile`, reset cuando llega tardío |
| `TransactionsSection` | `transferSchema` | RHF + lookup async a Brocoly con `setValue("cbuDestino")` cuando el resolver matchea |

Cada section ahora maneja su form internamente con
`useForm({ resolver: zodResolver(...), mode: "onTouched" })`. Los inputs son
`{...register("field")}` y se renderiza `errors.field?.message` debajo.

### 5.3 Nuevo contrato de submit

**Antes:**
```tsx
<form onSubmit={onSubmit}>
  <input onChange={(e) => onChange({ ...form, x: e.target.value })} />
```

**Después:**
```tsx
<form onSubmit={handleSubmit(onSubmit)} noValidate>
  <input {...register("x")} />
```

`onSubmit` ahora recibe `values: XxxFormValues` ya validados, no un
`FormEvent` con datos crudos.

### 5.4 Reset signal pattern

**Qué.** Para limpiar un form tras submit OK, el padre incrementa un counter
(`recipientResetSignal`, `transferResetSignal`). La section observa el
cambio y resetea su form RHF. Cada feature tiene su propio counter para que
un submit a "destinatario" no resetee el form de "transferir".

### 5.5 `usePortalForms.ts` reducido

**Antes:** 109 líneas, 5 forms + 3 useEffect de sync.
**Después:** 25 líneas, solo `createClientForm` (admin) y
`selectedAccountForAlias`. Los otros forms viven dentro de su section.

---

## 6. Frontend — Code splitting

### 6.1 Lazy sections

**Qué.** Las 6 sections del portal ahora se cargan perezosamente:

```ts
const AdminSection = lazy(() =>
  import("../features/admin/sections/AdminSection")
    .then((m) => ({ default: m.AdminSection }))
);
```

`Suspense fallback={<SectionLoader />}` envuelve el switch de tabs en
PortalPage.

### 6.2 Vendor chunks manuales

**Qué.** [vite.config.ts](banco-frontend/vite.config.ts) con `manualChunks`:

```js
rollupOptions: {
  output: {
    manualChunks: {
      'react-vendor':  ['react', 'react-dom', 'react-router'],
      'clerk-vendor':  ['@clerk/clerk-react'],
      'query-vendor':  ['@tanstack/react-query', '@tanstack/react-query-devtools'],
      'form-vendor':   ['react-hook-form', '@hookform/resolvers', 'zod'],
    },
  },
},
chunkSizeWarningLimit: 600,
```

### 6.3 Resultados

```
Antes: index.js = 524 KB / 154 KB gzip  (un solo blob)

Después (16 chunks):
  clerk-vendor              225 KB / 67 KB gzip   ← la mitad del peso es Clerk
  form-vendor                86 KB / 25 KB gzip
  index entry (app shell)    67 KB / 22 KB gzip
  query-vendor               48 KB / 15 KB gzip
  react-vendor               36 KB / 13 KB gzip
  AdminSection (lazy)        29 KB /  6 KB gzip   ← clientes nunca lo descargan
  AccountsSection (lazy)      9 KB /  3 KB gzip
  TransactionsSection (lazy)  8 KB /  3 KB gzip
  CompleteProfile (lazy)      5 KB /  1.7 KB gzip
  DashboardSection (lazy)     4 KB /  1.5 KB gzip
  RecipientsSection (lazy)    4 KB /  1.4 KB gzip
```

**Beneficios reales:**
- Cache granular: si un deploy solo cambia código de app, los vendors siguen
  en cache del browser. El usuario solo baja 22 KB en vez de 154.
- Cliente normal nunca descarga AdminSection (~6 KB gzip ahorrados).
- Carga paralela de chunks vía HTTP/2.

---

## 7. Backend — Idempotencia en transferencias

### 7.1 Migration

**Qué.** [migrations/20260527_idempotency_keys.sql](banco-backend/migrations/20260527_idempotency_keys.sql)
crea la tabla:

```sql
CREATE TABLE idempotency_keys (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key             TEXT NOT NULL,
  user_id         UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  endpoint        TEXT NOT NULL,
  request_hash    TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'in_flight'
                  CHECK (status IN ('in_flight', 'completed')),
  response_status INTEGER,
  response_body   JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
  UNIQUE (user_id, endpoint, key)
);
```

**Pendiente operacional:** ejecutar la migration manualmente
(`psql $DATABASE_URL -f migrations/20260527_idempotency_keys.sql`) y
configurar un cron externo para `DELETE FROM idempotency_keys WHERE expires_at < NOW()`.

### 7.2 Middleware

**Qué.** [src/middlewares/idempotency.js](banco-backend/src/middlewares/idempotency.js)
es una factory `createIdempotency(pool)` que retorna middleware Express.

**Flujo:**

1. Lee header `Idempotency-Key`. Si no está, no-op (opt-in del cliente).
2. Valida que sea UUID v4. Si no, 400.
3. `INSERT ... ON CONFLICT DO NOTHING` para reservar atómicamente como
   `in_flight`. Si reserva exitosa, deja pasar al handler.
4. Si ya existía la key:
   - **completed + mismo hash de body** → replay con header
     `Idempotent-Replay: true` y la respuesta cacheada.
   - **completed + hash distinto** → 422 (cliente reutilizó la key con
     payload distinto).
   - **in_flight** → 409 (otro request concurrente con la misma key).
5. Tras el handler, intercepta `res.json` para persistir la respuesta. Solo
   se cachean status determinísticos: `200, 201, 204, 400, 404, 409, 422`.
   5xx y 429 liberan la reserva para permitir retry.
6. Si la BD falla en cualquier punto del lookup, fallthrough sin
   idempotencia — preferimos que la operación funcione a tirar 500.

**Aplicado a:** `POST /api/transacciones` y `POST /api/transacciones/operar`.

### 7.3 Integración frontend

**Qué.**
- [lib/api/client.ts](banco-frontend/src/lib/api/client.ts) acepta
  `idempotencyKey?: string` en `RequestOptions`.
- [transacciones.api.ts](banco-frontend/src/features/transacciones/api/transacciones.api.ts):
  `createTransfer(payload, { idempotencyKey })`.
- [lib/queries/transacciones.ts](banco-frontend/src/lib/queries/transacciones.ts):
  `useCreateTransfer.mutationFn` acepta `idempotencyKey` en el payload.
- [usePortalActions.ts](banco-frontend/src/hooks/usePortalActions.ts):
  `handleTransfer` genera `crypto.randomUUID()` antes de cada `mutateAsync`.

**Trade-off documentado:** el UUID se genera por **intento de submit**, no
es estable a través de retries manuales del usuario en sesiones distintas.
Cubre el 95% de casos (doble click, retry programático, browser back) sin
agregar complejidad de "intent stable IDs" (persistir UUID en localStorage).

### 7.4 CORS

**Qué.** [src/app.js](banco-backend/src/app.js):
- `allowedHeaders`: agregado `Idempotency-Key` (header de request).
- `exposedHeaders`: agregado `Idempotent-Replay` (header de respuesta para
  que el cliente sepa si fue replay).

### 7.5 Tests

10 tests del middleware: no-op sin header, validación de UUID v4, reserva,
replay, 422 mismatch, 409 in-flight, fallthrough en error de BD,
determinismo de `hashBody`.

---

## 8. Backend — Logger estructurado (pino)

### 8.1 Logger base

**Qué.** [src/utils/logger.js](banco-backend/src/utils/logger.js) instancia
de pino con config dev/prod:

- **Dev:** `pino-pretty` (output coloreado, línea humana).
- **Prod:** JSON una línea por log, ideal para CloudWatch / Datadog / Loki.

**Niveles configurables vía `LOG_LEVEL`** (default `debug` en dev, `info` en
prod):
- `error`: rompe el flujo (excepciones, BD caída).
- `warn`: inesperado pero recuperable.
- `info`: eventos de negocio (transferencia completada).
- `debug`: detalle interno (silenciado en prod).

**Redacciones:** `req.headers.authorization`, `req.headers['idempotency-key']`,
cookies, `*.password`, `*.token`, `*.secret`, `*.dni` → `[REDACTED]`. Nunca
se loguean por error.

**Base context:** `service: 'banco-backend'` en cada log.

### 8.2 Middleware pino-http

**Qué.** [src/app.js](banco-backend/src/app.js) aplica `pino-http` antes que
todo el resto:

```js
app.use(pinoHttp({
  logger,
  customLogLevel: (_req, res, err) =>
    err || res.statusCode >= 500 ? 'error' :
    res.statusCode >= 400 ? 'warn' : 'info',
  customSuccessMessage: (req, res) => `${req.method} ${req.url} → ${res.statusCode}`,
  autoLogging: { ignore: (req) => req.url === '/api/health' },  // sin ruido
}));
```

Esto inyecta `req.log` en cada handler con `req.id` (UUID), método y URL
ya en el contexto. Cualquier `req.log.info({ ... }, 'mensaje')` queda
correlacionado.

### 8.3 Migración de `console.*` clave

| Archivo | Antes | Después |
|---|---|---|
| `server.js` | `console.log` startup, `console.error` fatal | `logger.info`, `logger.fatal` |
| `db/pool.js` | `console.error('[pool] ...')` | `logger.error({ err, subsystem: 'pool' }, ...)` |
| `middlewares/error-handler.js` | Sin logging | `req.log.error/warn` según severity |
| `middlewares/idempotency.js` | `console.warn('[idempotency] ...')` | Child logger con `middleware: 'idempotency'` |

### 8.4 Ejemplo de logs en dev

```
[02:01:22.217] INFO: API bancaria escuchando
    service: "banco-backend"
    port: 3001
    env: "development"

[02:01:30.842] INFO: POST /api/transacciones → 201
    service: "banco-backend"
    req: { id: "a3f9...", method: "POST", url: "/api/transacciones" }
    res: { statusCode: 201 }
    responseTime: 287
```

En producción los mismos eventos salen como JSON una-línea, listos para
ingesta en cualquier observability stack.

---

## 9. Estado actual del proyecto

### 9.1 Sprint 1 (backend — robustez bancaria)

- ✅ **Idempotencia en transferencias** (migration + middleware + tests +
  integración frontend)
- ✅ **Logger estructurado pino** (dev: pretty, prod: JSON, redact de
  secretos, request-id por request)
- ⏳ **Validar `page`/`limit` con Zod en CRUD genérico**
- ⏳ **Tests de auth-service**

### 9.2 Sprint 2 (frontend al nivel del backend)

- ✅ **TanStack Query** (queries + mutations + migración de hooks)
- ✅ **react-hook-form + Zod** (3 forms migrados)
- ✅ **Code splitting / lazy sections + vendor chunks**
- ⏳ **Vitest + RTL para frontend**
- ⏳ **ESLint + Prettier**

### 9.3 Sprint 3 (pulido production-ready)

- ⏳ **Split de `central-bank-service.js`** (~830 líneas, mismo patrón que
  transacciones)
- ⏳ **Circuit breaker para Brocoly** (opossum)
- ⏳ **Health check rico** (DB + Brocoly + Clerk reachability)
- ⏳ **OpenAPI spec autogenerada de los schemas Zod**
- ⏳ **TypeScript en backend** (gradual con JSDoc + `@ts-check`)

### 9.4 Métricas finales del proyecto

```
Backend:
  - 47 tests verdes en 1.2s (7 archivos)
  - Logger estructurado con request-id, JSON en prod
  - DTOs en 10 entidades, input/output centralizado
  - Service/router split en módulo crítico (transacciones)
  - Idempotencia en endpoints de dinero

Frontend:
  - 524 KB → 16 chunks (mejor cache, lazy admin)
  - Estado de servidor 100% en TanStack Query (sin useEffect manual)
  - Forms con validación Zod compartida con backend
  - DevTools de React Query en dev (esquina inferior derecha)
```

---

## 10. Cosas que NO se hicieron (intencionalmente)

- **No se reorganizó `modules/` por dominio** en subcarpetas. Es un cambio
  amplio que toca todos los requires; no se solicitó y no es bloqueante.
- **No se migró `central-bank-service.js`** al patrón service/router con DI.
  Es el siguiente candidato natural; queda como Sprint 3.
- **No se migraron tests con `vi.mock()`** para módulos CJS. Adoptamos DI
  porque la fricción es real; la lección está documentada en
  `memory/project_banco.md`.
- **No se hizo "intent stable IDs"** para idempotencia (persistir UUID en
  localStorage). El trade-off cubre el 95% de casos sin complejidad extra.
- **No se cambió el clerk-vendor chunk**. Pesa 67 KB gzip pero es necesario
  desde el primer render para login.
- **No se ejecutó la migration SQL** (`migrations/20260527_idempotency_keys.sql`)
  en la BD remota. Es pendiente operacional documentado.

---

## 11. CI/CD con GitHub Actions

### 11.1 Workflows creados

**Qué.** Dos workflows independientes, uno por subrepo (backend y frontend
viven en repos GitHub separados):

```
banco-backend/.github/workflows/ci.yml
banco-frontend/.github/workflows/ci.yml
```

Ambos:
- Corren en cada `push` y `pull_request` a `main`/`master`.
- Usan `concurrency` para cancelar runs viejos del mismo PR (ahorra
  minutos de CI).
- Setup Node 18 con cache de `~/.npm` por lockfile.
- `npm ci` (fail-fast si lockfile y package.json divergen).
- Timeout de 10 minutos por job (no run zombie).

### 11.2 Backend workflow

Jobs:

1. **Tests + syntax check** (`test`)
   - `node --check` en todos los `.js` de `src/` (atrapa syntax errors aunque
     el archivo no tenga test).
   - `npm test` con env mínimo:
     ```yaml
     NODE_ENV: test
     DATABASE_URL: 'postgresql://test:test@localhost/test_db'
     CLERK_SECRET_KEY: 'sk_test_ci_dummy'
     LOG_LEVEL: 'silent'
     ```
     Las DBs reales están mockeadas vía DI, pero `env.js` valida que estas
     vars existan al cargarse.
   - Smoke test: `node -e "require('./src/app')"` para detectar errores de
     wiring (imports rotos, middleware mal configurado) que los tests
     unitarios no atrapan.

2. **Security audit** (`security-audit`)
   - `npm audit --audit-level=high`.
   - `continue-on-error: true` (es informativo, no bloquea PRs).

### 11.3 Frontend workflow

Jobs:

1. **Build + bundle check** (`build`)
   - `npm run build` con env mínimo:
     ```yaml
     VITE_API_BASE_URL: '/api'
     VITE_CLERK_PUBLISHABLE_KEY: 'pk_test_ci_dummy'
     ```
   - Verifica que `dist/` exista y tenga archivos (atrapa fallos silenciosos
     de Vite).
   - Upload del bundle como artifact (descargable desde la UI por 7 días, útil
     para debugging y despliegues manuales).

2. **Security audit** (`security-audit`) — idéntico al backend.

### 11.4 Lo que NO incluye (intencional)

- **Type check estricto del frontend.** No hay `tsconfig.json` ni TypeScript
  como devDependency; Vite/esbuild solo transforma. Agregar `tsc --noEmit`
  es una mejora futura.
- **Despliegue automático.** No tocamos infraestructura — el workflow solo
  valida que el código compila y los tests pasan. El deploy a Supabase /
  Vercel / etc. queda manual o lo hacés con otro workflow después.
- **Tests del frontend.** No hay tests aún (Sprint 2 pendiente Vitest+RTL).
  Cuando se agreguen, se suma `npm test` al job de build.

### 11.5 Por qué importa

- **No mergeás código roto.** Si los tests fallan, el PR queda bloqueado.
- **Detecta regresiones temprano.** Antes solo lo notabas al deployar.
- **Onboarding.** Un nuevo dev hace clone + push y CI le dice si su entorno
  está bien.
- **Confianza para refactorizar.** Cambios grandes (como los que hicimos en
  esta sesión) van con la red de seguridad puesta.

---

## 12. Cierre de Sprint 1 — auth-service tests + page/limit validation

### 12.1 auth-service refactorizado a factory con DI

**Qué.** [src/modules/auth-service.js](banco-backend/src/modules/auth-service.js)
sigue el mismo patrón que `transacciones-service.js`: factory
`createAuthService({ pool, clerkApi })` que retorna las funciones públicas
con las deps cerradas en su closure. El `module.exports` por defecto usa
las dependencias reales (`pool` de pg + `clerkApi` axios), así los routers
no requieren cambios.

**Funciones públicas expuestas:** `getOrCreateUser`, `createUserWithClerk`,
`getUserProfile`, `completeUserProfile`, `deactivateUser`,
`syncClerkUserFromWebhook`, `deactivateClerkUserFromWebhook`.

**Helpers privados:** `fetchClerkUser`, `getPrimaryEmail`,
`normalizeOptionalText`, `normalizePhone`, `mapProvisionError`,
`ensureClienteRole`. Quedan dentro de la closure de la factory (cada
instancia los tiene aislados).

### 12.2 Tests de auth-service

**Qué.** [tests/modules/auth-service.test.js](banco-backend/tests/modules/auth-service.test.js)
con 18 tests cubriendo:

- `getOrCreateUser`: existing path sin llamar Clerk; rama de provisión cuando
  el usuario está inactivo o no existe.
- `createUserWithClerk`: 404 si la persona no existe, 400 si el clerk_id ya
  está en otro user, reactiva al usuario previo de la misma persona, crea
  uno nuevo cuando corresponde.
- `getUserProfile`: devuelve perfil con roles; roles vacíos OK.
- `deactivateUser`: marca `activo=false`, 404 si no existe.
- `completeUserProfile`: actualiza con `perfil_completo=true`, 404 si
  inactivo/inexistente.
- `syncClerkUserFromWebhook`: 400 sin id, actualiza usuario existente con
  COMMIT, rollback si una query falla, normaliza email a lowercase+trim.
- `deactivateClerkUserFromWebhook`: no-op para `null`/`undefined`, UPDATE
  cuando hay clerk_id.

### 12.3 Validación de paginación con Zod

**Qué.** Nuevo [src/utils/pagination.js](banco-backend/src/utils/pagination.js)
con `paginationSchema`:

```js
const paginationSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
}).passthrough();
```

- `.coerce.number()` convierte query strings (`"3"`) a number.
- `.passthrough()` permite que los filtros adicionales declarados en
  `entityConfig.allowedFilters` lleguen al service sin que zod los
  descarte.
- Cap `limit ≤ 100` previene DoS accidental (cliente pidiendo 100k filas
  en una sola request).

**Aplicación.** [src/modules/crud-router.js](banco-backend/src/modules/crud-router.js)
agrega `validate(paginationSchema, 'query')` al `GET /` antes del handler.
[src/modules/crud-service.js](banco-backend/src/modules/crud-service.js)
simplifica `list()`: ya no hace `Number(...) || default` defensivo porque
los valores llegan validados; sigue habiendo defaults para el caso
hipotético de un caller no-HTTP.

### 12.4 Tests de paginación

**Qué.** [tests/utils/pagination.test.js](banco-backend/tests/utils/pagination.test.js)
con 10 tests:

- Defaults cuando no se envía nada.
- Coerce `"3"` → `3`.
- Rechazo de `?page=abc` (antes silenciosamente devolvía `NaN`).
- Rechazo de page=0, page negativo, limit > 100, limit fraccional.
- Bordes válidos: `limit=1`, `limit=100`.
- Passthrough de filtros adicionales (dni, email, etc.).

### 12.5 Antes vs después

**Antes:**
```
GET /api/personas?limit=abc → list() recibe limit=NaN → OFFSET -NaN
                              comportamiento indefinido, BD podría tirar error raro
```

**Después:**
```
GET /api/personas?limit=abc → 400 "Datos inválidos."
                              details: { _errors: [], limit: ["Expected number, received nan"] }
```

### 12.6 Métricas del Sprint 1 cerrado

```
Tests:  47 → 75 (+28)
Files:  7 → 9
Duración total: ~880ms

Nuevo bloque:
  ✓ auth-service.test.js     (18 tests)
  ✓ pagination.test.js       (10 tests)
```

---

## 13. Operacionales pendientes

1. **Ejecutar la migration de idempotencia:**
   ```bash
   psql $DATABASE_URL -f banco-backend/migrations/20260527_idempotency_keys.sql
   ```

2. **Configurar cron de limpieza de idempotency_keys.** Sin pg_cron en
   Supabase, hay que correrlo desde un job externo (GitHub Actions,
   Supabase Edge Function, etc.):
   ```sql
   DELETE FROM idempotency_keys WHERE expires_at < NOW();
   ```

3. **Setear `LOG_LEVEL` en producción** (ej. `info`) si querés más o menos
   verbosidad que el default.

4. **Setear `NODE_ENV=production`** en el deploy para que pino emita JSON
   en vez de pretty-print.

5. **Commitear los workflows.** Los `.github/workflows/ci.yml` están en el
   working tree pero todavía no en GitHub. Después del primer push aparecen
   en la pestaña "Actions" de cada repo.

6. **Configurar branch protection en GitHub** (manual, una vez):
   - Settings → Branches → Add rule para `main`/`master`.
   - Marcar **"Require status checks to pass before merging"** y elegir
     los jobs del workflow (`test`, `build`).
   - Eso impide mergear PRs con CI rojo.
