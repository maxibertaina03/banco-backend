# Reparto de trabajo — Maxi y Gonza

Quién hace qué, en qué orden, y qué necesita cada cosa para poder arrancar.
Complementa [PLAN.md](PLAN.md), que tiene el porqué de cada fase.

**La regla que hace que esto funcione:** el contrato ya está escrito y aprobado
([openapi-banco-orbital.yaml](openapi-banco-orbital.yaml)), así que **el frontend no
espera al backend**. Gonza mockea las respuestas del YAML y construye; Maxi implementa
detrás. Se encuentran cuando los dos lados están listos.

---

## Gonza

### 1. Portar el chatbot del backend — *puede arrancar ya*

Es lo único suyo que quedó afuera de `main`. Paso a paso, verificado contra el
código real el 8/9/2026.

> **No borrar la rama `gonza` todavía.** Sus dos commits del chatbot existen
> **sólo ahí**: si se borra antes de mergear, el trabajo se pierde. Se borra al
> final, en el paso 9.

**1. Rama nueva desde `main`.** De feature, no personal: vive lo que dura el PR.
Una rama personal permanente es justamente lo que hizo que esto quedara 33
commits atrás.

```bash
git checkout main && git pull
git checkout -b feat/chatbot-backend
```

**2. Traer los tres archivos.**

```bash
git checkout origin/gonza -- src/modules/chatbot-router.js \
                             src/modules/chatbot-service.js \
                             tests/modules/chatbot-service.test.js
```

**No hace falta `npm install`**: `axios`, `express-rate-limit` y `zod` ya están
en `main`.

**3. Arreglar el import de `clerk-auth`** en `chatbot-router.js`. En `main` ese
módulo exporta un objeto, no un default:

```js
const { clerkAuth } = require('../middlewares/clerk-auth');
```

**4. Sacar `clerkAuth` de la lista de middlewares del router.** `app.js` ya lo
aplica sobre todo `/api`, y el chatbot se monta ahí adentro, así que dejarlo en
el router valida el token dos veces. Si se saca del todo, el paso 3 ya no hace
falta y se puede borrar el import.

**5. Cablear la ruta** en `src/routes/index.js`. `relationsRouter` va último
siempre, porque está montado en `/` y se queda con lo que no matcheó antes:

```js
const chatbotRouter = require('../modules/chatbot-router');
// ...
router.use('/chatbot', chatbotRouter);
router.use('/', relationsRouter);
```

**6. Variables de entorno** en `src/config/env.js`:

```js
geminiApiKey: process.env.GEMINI_API_KEY,
geminiModel: process.env.GEMINI_MODEL || 'gemini-3.6-flash',
```

La key va en el `.env` local. **Que no se commitee**: `.env` está en el
`.gitignore` y tiene que seguir así.

**7. Arreglar la consulta de saldos.** Es nuevo desde la migración multi-moneda
y es el punto que más importa. En `chatbot-service.js`:

```sql
-- antes
SELECT c.cbu, NULL::text AS alias, c.numero_cuenta, c.saldo, c.activa
-- después
SELECT c.cbu, c.alias, c.numero_cuenta, c.saldo, c.moneda, c.activa
```

Y agregar `currency: account.moneda` al objeto que arma abajo. Sin esto, a un
cliente con caja en pesos y en dólares el asistente le contesta "tenés 420.000 y
0" sin aclarar cuál es cuál; con saldos parecidos en las dos monedas la
respuesta es directamente engañosa. De paso, el `NULL::text AS alias` ya no
tiene sentido: la columna existe y cada cuenta tiene su alias.

**8. Verificar, en este orden.**

```bash
npm test                        # los 182 de main + los del chatbot
node -e "require('./src/app')"  # esto caza los imports rotos
npm run dev                     # y probar el endpoint a mano
```

El segundo es el que importa: **ni los tests ni el build detectan un import
roto**, sólo aparece al arrancar la app.

**9. PR y recién ahí borrar la rama vieja.**

```bash
git push -u origin feat/chatbot-backend
# PR contra main, CI en verde, merge, y DESPUÉS:
git push origin --delete gonza
```

**Algo a favor:** su test ya usa inyección de dependencias
(`createChatbotService({ pool, geminiApi, apiKey, model })`), que es el patrón
correcto del proyecto. Va a funcionar tal cual, sin toparse con el problema de
`spyOn` que sí frena a quien no lo use.

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

---

## Maxi

### 1. Fase 2, cimientos — *bloquea todo lo demás del backend*

Va primero y va solo. Cuatro cosas:

- **Migración de cuentas multi-moneda.** Una persona pasa a tener N cuentas, cada una con
  su CBU, su moneda y su alias. La cuenta en pesos actual se marca como principal.
  **Guardar siempre el CBU en USD localmente**: el Banco Central no lo puede listar, y si
  se pierde el único modo de recuperarlo es repetir `POST /accounts`.
- **Las seis rutas nuevas del Central** en `central-bank-client.js`, que ya trae el retry
  y el mapeo de errores. Resolver la moneda de un CBU con `GET /accounts/{cbu}`, que
  sirve para las dos monedas — verificado contra el ambiente `test`.
- **Adapter de mercado** en `src/modules/mercado/`: DolarAPI y ArgentinaDatos, con caché
  TTL, timeout y valor de respaldo. **Acá se normaliza la TNA** de fracción decimal a
  porcentaje: es el punto donde el sistema se rompe silenciosamente si se olvida.
- **Chequeo crediticio** contra `GET /central-deudores/{dni}`, usado en el alta de cuenta
  **y** al otorgar préstamos. Situación 3 o peor bloquea las dos cosas.

**Definición de terminado:** se abre una caja en USD, se recupera su CBU repitiendo
`POST /accounts`, y un DNI en situación 4 rebota las dos operaciones.

### 2. Backend de las fases 3 a 5 — *después de la fase 2*

- **Cuentas y cambio.** Depósitos, extracciones, movimientos y compra/venta de dólares a
  la cotización `oficial`. Más la **validación de moneda en toda transferencia**, de
  salida y de entrada, porque el Central no la hace.
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
