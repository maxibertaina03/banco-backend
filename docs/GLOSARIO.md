# Glosario — lenguaje ubicuo de Banco Orbital

Este documento fija **un solo nombre por concepto**. No es una guía de estilo opcional: es el contrato de nomenclatura del sistema. Si un concepto no está acá, se agrega acá antes de usarlo en el código.

**Por qué existe:** el código tenía dos nombres para cada cosa. `cuenta` aparecía 307 veces y `Account` 291; `destinatario` 74 y `Recipient` 67; `transaccion` 96 y `Transaction` 148. Eso no es "código en inglés", es un código bilingüe donde cada concepto se llama de dos formas según el archivo. Un ejemplo real, de una sola función:

```js
const destination = await getLocalAccountById(client, cuenta_destino_id);
if (!destination.activa) { ... }
const amount = Number(monto);
await q.creditAccount(client, amount, destination.id);
```

Cuatro decisiones de idioma en cinco líneas.

---

## 1. Reglas generales

**Sin acentos ni `ñ` en identificadores.** `transaccion`, `auditoria`, `descripcion`, `anio`. Los acentos son legales en JavaScript pero rompen el flujo al tipear, complican los `import` y ensucian los diffs. La base de datos ya sigue esta regla (`descripcion`, `auditoria`).

Los acentos **sí** van en:
- comentarios y documentación
- strings que ve el usuario (`'La cuenta de origen no está activa.'`)
- claves de traducción y textos de UI

**`camelCase` en JavaScript/TypeScript, `snake_case` en la base de datos.** Sin cambios respecto de hoy: el código lee filas planas en `snake_case` que vienen de los `JOIN` (`persona_id`, `perfil_completo`) y eso se mantiene.

**Singular para una entidad, plural para colecciones.** `cuenta` / `cuentas`, `obtenerCuenta` / `listarCuentas`.

---

## 2. Sustantivos de dominio

| Inglés actual | **Nombre oficial** | Nota |
|---|---|---|
| `Account` | **cuenta** | Ya es la tabla `cuentas` |
| `Recipient` | **destinatario** | Ya es la tabla `destinatarios` |
| `Transaction` | **transaccion** | El registro. Ya es la tabla `transacciones` |
| `Transfer` | **transferencia** | Un **tipo** de transacción, no un sinónimo. Ver §3 |
| `Deposit` | **deposito** | Otro tipo de transacción |
| `Bank` | **banco** | |
| `Person` | **persona** | |
| `Role` | **rol** | Tabla `roles` |
| `User` | **usuario** | Tabla `usuarios` |
| `Audit` | **auditoria** | Tabla `auditoria` |
| `Profile` | **perfil** | |
| `Balance` | **saldo** | Ya es la columna `saldo` |
| `Owner` | **titular** | Es el término bancario. No "dueño" ni "propietario" |
| `Sender` | **emisor** | Quien envía la transferencia |
| `Origin` / `Destination` | **origen** / **destino** | Ya son las columnas `cuenta_origen_id`, `cbu_destino` |
| `Sync` | **sincronizacion** | Verbo: `sincronizar` |
| `Record` (tipo TS) | *(se elimina el sufijo)* | `AccountRecord` → `Cuenta`. Evita además chocar con el `Record<K,V>` de TypeScript |
| `Option` | **opcion** | |
| `Section` | **seccion** | Componentes: `AccountsSection` → `SeccionCuentas` |
| `Card` | **tarjeta** | `AccountCard` → `TarjetaCuenta` |
| `Dialog` | **dialogo** | `TransferReceiptDialog` → `DialogoComprobanteTransferencia` |

---

## 3. Tres distinciones que hoy están mezcladas

Estas no son traducciones: son conceptos que el código actual confunde y que conviene separar de una vez.

### `transaccion` ≠ `transferencia`

- **`transaccion`** es el registro en la tabla `transacciones`. Es el término genérico.
- **`transferencia`** y **`deposito`** son valores de `tipo_transaccion`. Son operaciones concretas.

Hoy conviven `createTransfer`, `createContractTransfer` y `TransactionRecord` para cosas del mismo nivel. Después del renombre: `crearTransferencia` crea una transacción de tipo transferencia; `listarTransacciones` lista todas sin importar el tipo.

### `monto` ≠ `importe`

Los dos existen hoy y se usan indistintamente. Se separan por origen:

- **`monto`** — el importe interno del sistema. Es la columna `monto` de la tabla.
- **`importe`** — sólo cuando se habla con el Banco Central, porque así se llama en su contrato (`importe`, `saldoOrigen`).

Regla práctica: si el valor cruza hacia `centralBankService`, se llama `importe`; en cualquier otro lado, `monto`.

### `cuenta` (bancaria) ≠ `usuario` (de acceso)

Ya está bien resuelto en la base (`cuentas` vs `usuarios`), pero en inglés `account` es ambiguo entre las dos. Al renombrar, `account` siempre es **cuenta bancaria**. La identidad de acceso es **usuario**.

---

## 4. Verbos

| Inglés | **Verbo oficial** |
|---|---|
| `create` | **crear** |
| `update` | **actualizar** |
| `delete` / `remove` | **eliminar** |
| `list` | **listar** |
| `get` | **obtener** |
| `find` | **buscar** |
| `resolve` | **resolver** |
| `assign` | **asignar** |
| `register` | **registrar** |
| `sync` | **sincronizar** |
| `build` | **armar** |
| `validate` | **validar** |
| `normalize` | **normalizar** |
| `extract` | **extraer** |
| `persist` | **guardar** |
| `load` | **cargar** |
| `refresh` | **refrescar** |
| `debit` / `credit` | **debitar** / **acreditar** |
| `toPublic` | **aPublico** |
| `handle` | **manejar** |

**Ejemplos aplicados:**

| Antes | Después |
|---|---|
| `getLocalAccountById` | `obtenerCuentaLocalPorId` |
| `creditAccount` | `acreditarEnCuenta` |
| `debitAccount` | `debitarDeCuenta` |
| `toPublicCuenta` | `aCuentaPublica` |
| `validateTransferLimit` | `validarLimiteDeTransferencia` |
| `persistCentralTransfer` | `guardarTransferenciaCentral` |
| `buildAuditContext` | `armarContextoDeAuditoria` |
| `resolveRecipient` | `resolverDestinatario` |
| `syncIncomingTransactions` | `sincronizarTransaccionesEntrantes` |

---

## 5. Frontend

**Los hooks conservan el prefijo `use`.** Es una convención de React que las reglas de lint verifican; sólo se traduce lo que sigue.

| Antes | Después |
|---|---|
| `usePersonaTransactions` | `useTransaccionesDePersona` |
| `useCreateTransfer` | `useCrearTransferencia` |
| `useAuthProfile` | `usePerfilAutenticado` |
| `useInternalCatalogs` | `useCatalogosInternos` |

**Tipos:** se elimina el sufijo `Record`. Los formularios usan el prefijo `Formulario`, y los props de componente conservan `Props`.

| Antes | Después |
|---|---|
| `AccountRecord` | `Cuenta` |
| `TransactionRecord` | `Transaccion` |
| `RecipientRecord` | `Destinatario` |
| `TransferFormValues` | `FormularioTransferencia` |
| `AccountCardProps` | `TarjetaCuentaProps` |
| `PersonaFullResponse` | `PersonaCompleta` |

**Archivos y carpetas:** las carpetas de `features/` ya están en español (`cuentas`, `personas`, `transacciones`, `destinatarios`). Los archivos siguen a su export: `AccountsSection.tsx` → `SeccionCuentas.tsx`.

---

## 6. Qué NO se renombra

Esta es la frontera entre nuestro código y el mundo. Tocar algo de esta lista rompe cosas.

| Ámbito | Ejemplos | Por qué |
|---|---|---|
| **APIs de librerías** | `req`, `res`, `next`, `router.get`, `useQuery`, `mutationFn`, `queryKey`, `useForm`, `handleSubmit` | Los define Express, React, TanStack Query y react-hook-form |
| **React** | `props`, `children`, `useState`, `useEffect`, `ref` | Idem |
| **Clerk** | `clerkId`, `publishableKey` | Proveedor de identidad externo |
| **Contrato del Banco Central** | `bankCode`, `createdAt`, `_id`, `apiKey` | Lo define su OpenAPI. Ojo: buena parte de ese contrato **ya está en español** (`cbuOrigen`, `importe`, `saldoOrigen`, `estado`) |
| **Estándar HTTP** | header `Idempotency-Key`, tabla `idempotency_keys`, `endpoint` | Nombre estandarizado del mecanismo |
| **[components/ui/](banco-frontend/src/components/ui/)** | 46 archivos, 5.122 líneas de shadcn/ui | Código vendorizado que se resincroniza desde upstream: cualquier renombre se pierde en la próxima actualización |
| **Base de datos** | tablas y columnas | Ya están en español. Renombrarlas exige migración y no aporta nada |
| **Rutas del API** | `/api/personas`, `/api/cuentas` | Ya están en español |
| **Todo lo que toca al Banco Central** | `/api/central-bank`, `bankCode`, `cbuOrigen`, `saldoOrigen`, `POST /accounts` | **Se queda en inglés a propósito.** Decisión de equipo: el contrato lo define su API, y traducir de este lado sólo agrega una capa de traducción que confunde al depurar. Si el Central lo llama `accounts`, nosotros también |
| **Config de tooling** | claves de `package.json`, `vite.config.ts`, `vitest.config.js` | Las define la herramienta |

---

## 7. Cómo se aplica

Concepto por concepto, no todo junto. Cada concepto es un paso completo y revertible:

1. Renombrar en el backend: `dtos/` → `services/` → `routers/`
2. Correr `npm test` — deben quedar los 139 en verde
3. Renombrar en el frontend: `types/` → `api/` → `queries/` → componentes
4. Correr `npx vite build`
5. Commit de ese concepto

Orden sugerido, del más aislado al más transversal:

| # | Concepto | Por qué en ese orden |
|---|---|---|
| 1 | `Recipient` → `destinatario` | El más chico y contenido |
| 2 | `Account` → `cuenta` | Grande pero muy mecánico |
| 3 | `Transaction` / `Transfer` | Requiere aplicar la distinción de §3 |
| 4 | `User` / `Role` / `Audit` | Tocan auth y permisos |
| 5 | `Bank` / `Sync` | Módulo de Banco Central. **Ojo:** sólo se renombra lo que es nuestro; los campos de su contrato (`bankCode`, `cbuOrigen`) no se tocan |
| 6 | Verbos sueltos | Barrido final de lo que quedó |

La red de seguridad son los **139 tests** del backend y el build de Vite en el frontend. Nada de esto cambia comportamiento: si un test se pone en rojo, es un error de renombre, no un cambio de contrato.
