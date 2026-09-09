# Reparto de trabajo — Maxi y Gonza

Quién hace qué, en qué orden, y qué necesita cada cosa para poder arrancar.
Complementa [PLAN.md](PLAN.md), que tiene el porqué de cada fase.

**La regla que hace que esto funcione:** el contrato ya está escrito y aprobado
([openapi-banco-orbital.yaml](openapi-banco-orbital.yaml)), así que **el frontend no
espera al backend**. Gonza mockea las respuestas del YAML y construye; Maxi implementa
detrás. Se encuentran cuando los dos lados están listos.

---

## Gonza

### 1. Traer el chatbot del backend a `main` — *puede arrancar ya*

Es lo único suyo que quedó afuera. **Se hace con un merge, no portando archivos
a mano.** Se midió: da 9 archivos en conflicto con 1 o 2 bloques cada uno, más
`package-lock.json`, que no se resuelve sino que se regenera. Es media hora.

**La rama `gonza` no se borra.** Sigue siendo su rama de trabajo; lo que cambia
es que se sincroniza seguido.

**1. El merge.**

```bash
cd banco-backend
git checkout gonza && git pull
rm package-lock.json          # se regenera, no vale la pena resolverlo
git merge origin/main
```

**2. Resolver los conflictos.** Son todos "agregar/agregar": archivos que
existen en las dos ramas por caminos distintos.

| Archivo | Qué hacer |
|---|---|
| `src/utils/logger.js` | Quedarse con la de `main` |
| `src/middlewares/clerk-auth.js` | Quedarse con la de `main` |
| `src/modules/auth-router.js` | Quedarse con la de `main` |
| `docs/GUIA_RAPIDA.md` | Quedarse con la de `main` |
| `package.json` | Quedarse con la de `main`: ya trae `axios`, `express-rate-limit` y `pino` |
| `src/app.js` | Quedarse con la de `main`: lo que agregaba la rama vieja ya está |
| `src/routes/index.js` | La de `main` **más** `router.use('/chatbot', chatbotRouter)`. **`relationsRouter` va último**, porque está montado en `/` |
| `src/config/env.js` | La de `main` **más** `geminiApiKey` y `geminiModel` |
| `.env.example` | La de `main` **más** `GEMINI_API_KEY` |

Después, `npm install` para regenerar el lock.

**3. Cuatro arreglos que van sí o sí**, porque `main` cambió debajo:

- **El import de `clerk-auth`**, que ahora exporta un objeto:
  `const { clerkAuth } = require('../middlewares/clerk-auth');`
- **Sacar `clerkAuth` de los middlewares del router.** `app.js` ya lo aplica
  sobre todo `/api` y el chatbot cuelga de ahí, así que dejarlo valida el token
  dos veces. Si se saca del todo, el punto anterior ni hace falta.
- **La consulta de saldos no trae la moneda.** Es el más importante: desde la
  migración multi-moneda una persona puede tener caja en pesos **y** en dólares.
  En `chatbot-service.js`, cambiar
  `SELECT c.cbu, NULL::text AS alias, c.numero_cuenta, c.saldo, c.activa`
  por `SELECT c.cbu, c.alias, c.numero_cuenta, c.saldo, c.moneda, c.activa`,
  y agregar `currency: account.moneda` al objeto de abajo. Sin esto el asistente
  contesta "tenés 420.000 y 100" sin aclarar que lo segundo son dólares.
- **Leer [GLOSARIO.md](GLOSARIO.md)** antes de escribir código nuevo: todo el
  dominio pasó a español.

**4. Verificar, en este orden.**

```bash
npm test                        # los de main más los del chatbot
node -e "require('./src/app')"  # ESTE es el que importa
npm run dev
```

El segundo no se saltea: **ni los tests ni el build detectan un import roto**,
sólo aparece al arrancar la app.

**5. PR `gonza` → `main`**, CI en verde, merge. Y después del merge,
`git merge origin/main` para quedar al día.

### 2. El asistente, de solo lectura — *después del punto 1*

Responde sobre saldo, movimientos, elegibilidad para un préstamo y datos del cliente
autenticado. **No ejecuta ninguna acción**, ni siquiera bloquear una tarjeta: todo lo
que sea operar se deriva a la app o a un humano.

Los guardarrailes que ya tiene cubren buena parte. Lo que falta es darle acceso de
lectura a los datos y, sobre todo, **el test que hay que escribir sí o sí**: que no
pueda contestar sobre *otro* cliente, aunque se lo pidan de formas rebuscadas. Ese es
el criterio de cierre de la fase.

### 3. `banco-proveedores` — *puede arrancar ya, en paralelo*

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
