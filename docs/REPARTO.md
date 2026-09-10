# Reparto de trabajo — Maxi y Gonza

Quién hace qué, en qué orden, y qué necesita cada cosa para poder arrancar.
Complementa [PLAN.md](PLAN.md), que tiene el porqué de cada fase.

**La regla que hace que esto funcione:** el contrato ya está escrito y aprobado
([openapi-banco-orbital.yaml](openapi-banco-orbital.yaml)), así que **el frontend no
espera al backend**. Gonza mockea las respuestas del YAML y construye; Maxi implementa
detrás. Se encuentran cuando los dos lados están listos.

---

## Gonza

### 1. Traer el chatbot del backend a `main` — *en curso*

**Estado al 10/9: el merge ya está hecho, faltan 6 conflictos por resolver.**

> ⚠️ **No borrar `crud-router.js`, `crud-service.js` ni `entities.js`.** No están
> obsoletos: en `main` montan **nueve grupos de rutas** (personas, roles,
> personas-roles, usuarios, tipos-cuenta, cuentas, tipos-transaccion,
> destinatarios y auditoría). Borrarlos deja el banco sin media API.
>
> Los services por dominio que aparecen en el merge (cuentas, tarjetas,
> préstamos, plazos fijos) son para lo que el CRUD genérico **no puede** hacer:
> `FOR UPDATE`, llamadas al Banco Central, cálculo financiero. Son un
> complemento, no un reemplazo. Prisma tampoco reemplaza nada: es fuente de
> verdad del schema y las migraciones, y los services siguen en SQL crudo por
> decisión deliberada (ver `prisma/README.md`).

**Por qué la lista de "Changes to be committed" es tan larga.** No es un refactor
a revisar archivo por archivo: la rama está 41 commits atrás, así que el merge
trae todo lo que `main` sumó desde abril y git lo lista como "new file". Es lo
normal en un merge así.

**Los 6 conflictos se resuelven todos igual.** Comparados contra el ancestro
común, **la rama de Gonza no cambió ninguno de los seis**; sólo los cambió `main`:

| Archivo | Cambios de la rama | Cambios de `main` |
|---|---|---|
| `schema.sql` | ninguno | +51 −5 |
| `src/middlewares/error-handler.js` | ninguno | +36 −6 |
| `src/modules/crud-router.js` | ninguno | +17 −3 |
| `src/modules/crud-service.js` | ninguno | +120 −19 |
| `src/modules/entities.js` | ninguno | +126 −4 |
| `src/modules/transacciones-router.js` | ninguno | +238 −102 |

Así que no hay nada que preservar y no hay decisión de arquitectura que tomar:

```bash
git checkout --theirs schema.sql \
                      src/middlewares/error-handler.js \
                      src/modules/crud-router.js \
                      src/modules/crud-service.js \
                      src/modules/entities.js \
                      src/modules/transacciones-router.js
git add schema.sql src/middlewares/error-handler.js src/modules/crud-router.js \
        src/modules/crud-service.js src/modules/entities.js src/modules/transacciones-router.js
```

En un merge, `--theirs` es la rama que se está trayendo, o sea `main`.

**El `package-lock.json`** se regenera, no se resuelve a mano:

```bash
rm -f package-lock.json && npm install
```

**El import de `clerk-auth` en `chatbot-router.js`.** No aparece en el
`git status` porque ya está commiteado en la rama, pero sigue mal: la línea 7
tiene `const clerkAuth = require(...)` y en `main` ese módulo exporta un objeto.
Además `app.js` ya aplica `clerkAuth` sobre todo `/api`, así que en el router
sobra. **Lo más limpio es borrar el import y sacar `clerkAuth` de la línea 33.**

**Y la consulta de saldos, que es lo que más importa.** En `chatbot-service.js`,
cambiar `SELECT c.cbu, NULL::text AS alias, c.numero_cuenta, c.saldo, c.activa`
por `SELECT c.cbu, c.alias, c.numero_cuenta, c.saldo, c.moneda, c.activa`, y
agregar `currency: account.moneda` al objeto de abajo. Sin esto el asistente le
dice al cliente "tenés 420.000 y 100" sin aclarar que lo segundo son dólares.

**Cerrar, en este orden:**

```bash
git commit                       # cierra el merge
npm test                         # 267 de main + los del chatbot
node -e "require('./src/app')"   # ESTE es el que caza los imports rotos
npm run dev                      # y probar el chat
```

El tercero no se saltea: **ni los tests ni el build detectan un import roto**,
sólo aparece al arrancar la app.

### 2. El asistente, de solo lectura — *después del punto 1*

Responde sobre saldo, movimientos, elegibilidad para un préstamo y datos del cliente
autenticado. **No ejecuta ninguna acción**, ni siquiera bloquear una tarjeta: todo lo
que sea operar se deriva a la app o a un humano.

Los guardarrailes que ya tiene cubren buena parte. Lo que falta es darle acceso de
lectura a los datos y, sobre todo, **el test que hay que escribir sí o sí**: que no
pueda contestar sobre *otro* cliente, aunque se lo pidan de formas rebuscadas. Ese es
el criterio de cierre de la fase.

### 3. `banco-proveedores` — ✅ **construido y andando** (10/9)

**Repo:** <https://github.com/maxibertaina03/banco-proveedores> — público, con
`main` y `develop`, y el CI en verde. Implementa los 5 endpoints del contrato con
23 tests.

```bash
cd banco-proveedores && npm install && cp .env.example .env && npm run dev
curl -H "x-api-key: orbital-proveedores-2026" http://localhost:4000/empresas
```

Trae su propia colección de Postman, CI y README. Lo que queda para Gonza es
**consumirlo desde el banco**: un cliente HTTP en el backend con timeout y
manejo de caída, más las pantallas del portal para pagar servicios y recargar.

Tres cosas del mock que conviene saber antes de integrar:

- **No mueve plata.** El débito de la cuenta lo hace el banco; el proveedor sólo
  confirma que cobró.
- **Un cliente al día devuelve `200` con lista vacía, no `404`.**
- **Los números terminados en `0000` se rechazan con `422` a propósito**, para
  poder probar el manejo de error sin apagar el servicio.

Repo nuevo, mocks de terceros. El contrato está escrito:
[openapi-banco-proveedores.yaml](openapi-banco-proveedores.yaml), 5 endpoints.

| Endpoint | Qué hace |
|---|---|
| `GET /empresas` | Catálogo de empresas de servicios |
| `GET /empresas/{id}/deuda` | Facturas impagas de un número de cliente |
| `POST /empresas/{id}/pagos` | Marcar una factura como pagada |
| `GET /operadoras` | Operadoras de celular con sus montos |
| `POST /operadoras/{id}/recargas` | Acreditar saldo prepago |

API key fija por header `x-api-key`. Tiene un caso de rechazo reproducible a propósito:
la operadora rechaza los números terminados en `0000`, para que el banco tenga cómo
probar el manejo de error sin apagar el servicio.

**Importante:** el proveedor **no mueve plata**. El débito de la cuenta lo hace el banco;
el proveedor sólo confirma que cobró.

### 4. Frontend de las fases 3 a 5 — *puede arrancar ya, con mocks*

Acá está el grueso del trabajo. El contrato de la API tiene 24 endpoints aprobados, así
que se puede construir toda la pantalla antes de que exista el backend.

En orden, siguiendo las fases:

- **Cuentas y cambio de divisa.** Selector de moneda en el portal, pantalla de compra y
  venta de dólares con la cotización en vivo, extracto paginado.
- **Tarjetas.** Listado, emisión, bloqueo y desbloqueo, resumen de crédito.
- **Préstamos y plazos fijos.** Simulador con la tabla de amortización, solicitud, pago
  de cuota. Es la pantalla más rica: la tabla del cronograma sale entera de
  `POST /api/prestamos/simulaciones`.

**Dos cosas a tener en cuenta al construir:**

- Los importes vienen como `number` ya convertido. Se formatean con `formatCurrency`,
  no se acumulan en el cliente.
- Los listados vienen paginados como `{ page, limit, count, data }`. Ojo que `count` es
  lo que hay **en esta página**, no el total del recurso.

### Cómo mantener la rama al día

Antes de arrancar cualquier tarea nueva:

```bash
git checkout gonza && git merge origin/main
```

Ese comando es todo lo que hace falta. La rama tiene hoy 41 commits de atraso en
el backend y por eso este merge tiene conflictos; corriéndolo seguido, no los
tiene nunca. **La señal de que se esperó demasiado es cuando aparecen conflictos
en archivos que uno no tocó.**

---

## Maxi

### 1. Fase 2, cimientos — ✅ **terminada y verificada** (8/9/2026)

Probada contra el ambiente `test` del Banco Central, no con mocks:

| Pieza | Dónde | Verificación |
|---|---|---|
| Migración multi-moneda | `migrations/20260908_cuentas_multimoneda.sql` | Aplicada. Toda persona con exactamente una cuenta principal |
| Seis rutas del Central | `central-bank-service.js` | Caja en USD creada, CBU `…001800` guardado |
| Adapter de mercado | `mercado-service.js` | Cotización 1480/1530; tasas 64,4 % y 20,12 % ya normalizadas |
| Chequeo crediticio | `riesgo-crediticio.js` | DNI en situación 4 → 403 |
| Apertura de cuenta | `cuentas-service.js` | Idempotente; el índice único rechaza la segunda cuenta USD |

**Dos hallazgos que simplificaron el trabajo:** la tabla ya soportaba N cuentas
por persona, así que la migración fue sólo agregar `moneda` y `principal`; y
`GET /accounts/{cbu}` del Central resuelve las dos monedas pese a que su
documentación diga lo contrario, así que no hizo falta el fallback planeado.

**Una decisión tomada sobre la marcha:** si DolarAPI está caída, la compra y
venta de dólares **se bloquea** con 503. Mostrar un precio viejo en pantalla es
aceptable; cobrarle al cliente a ese precio no. Por eso hay dos funciones,
`obtenerCotizacionDolar()` para mostrar y `obtenerCotizacionParaOperar()` para
operar.

**Definición de terminado:** se abre una caja en USD, se recupera su CBU repitiendo
`POST /accounts`, y un DNI en situación 4 rebota las dos operaciones.

### 2. Backend de las fases 3 a 5 — *en curso*

- **Validación de moneda en transferencias** — ✅ hecha, en `monedas.js`. Cubre los
  dos sentidos: al enviar tira 400 antes de tocar saldos; al recibir no acredita y
  deja constancia, porque el dinero ya salió del otro banco y no se puede rechazar.
- **Cuentas y cambio.** Faltan depósitos, extracciones, movimientos paginados y la
  compra/venta de dólares a la cotización `oficial`.
- **Tarjetas.** Emisión, autorización de consumos contra saldo o límite, bloqueo, resumen
  con CFT.
- **Préstamos y plazos fijos.** Sistema francés con `Dinero`, que ya está escrito y
  testeado. Interés simple base 365 para los plazos fijos. Y **informar la deuda al
  Central** al otorgar y al cambiar la situación.

Todo lo que mueve plata lleva `Idempotency-Key`: el middleware ya existe, sólo hay que
enchufarlo en cada ruta nueva.

### 3. Dos cosas que no son código

- **Llevar al grupo de bancos el tema de las monedas en `POST /transactions`.** El Central
  no valida moneda: acepta una transferencia de un CBU en pesos a uno en dólares y mueve
  el importe tal cual. Aunque nosotros validemos, cualquier otro banco puede mandarnos
  pesos a un CBU en dólares. **Es el riesgo más serio del sistema y no se arregla solo.**
- **Decidir cómo se actualiza la mora en el Central.** Es el único punto que quedó abierto
  de las once decisiones. Las tres opciones están en [PLAN.md](PLAN.md); la que parece más
  obvia, recalcular al pagar una cuota, es justamente la que no sirve, porque no detecta
  al que deja de pagar.

---

## Dónde se cruzan

| Momento | Qué pasa |
|---|---|
| Fin de la fase 2 | Maxi avisa que el backend de cuentas está arriba. Gonza cambia los mocks por llamadas reales |
| Cada PR | Revisión cruzada. Es la única forma de que ninguno sea el único que entiende su mitad |
| Si hay que cambiar el contrato | Se actualiza el YAML **primero**, se avisa, y recién después se toca el código |

## Cómo se trabaja de acá en adelante

Rama por feature desde `main`, PR con el CI en verde, merge a `main`. Nada de ramas
personales largas: es lo que hizo que la rama del backend de Gonza quedara 33 commits
atrás y haya que portar a mano en vez de mergear.
