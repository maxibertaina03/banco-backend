# Propuesta v1.1 — Banco Central API

Documento para acordar entre bancos. Cubre tres bloques nuevos: **cajas de ahorro en USD**, **préstamos** e **inversiones**.

- Spec completa: [`openapi-banco-central-v1.1.yaml`](openapi-banco-central-v1.1.yaml) (mismo contenido en `.json`)
- Para verla renderizada: abrir <https://editor.swagger.io> → *File → Import file*
- Base: v1.0.0 vigente en <https://centralbank.brocoly.cc/openapi.json>

**Alcance:** 10 endpoints existentes + 20 nuevos = 30 operaciones. Ningún cambio rompe clientes actuales.

---

## 1. Principio de diseño

El Banco Central **sigue sin mover dinero ni guardar saldos**, exactamente como hoy en `POST /transactions`, donde `saldoOrigen` solo sirve para autorizar. Sobre esa base cumple tres funciones nuevas:

| Función | Endpoints | Por qué en el Central y no en cada banco |
|---|---|---|
| **Autoridad de tasas** | `GET /rates`, `GET /fx/usd` | Si cada banco inventa su tasa no hay estándar posible |
| **Calculadora oficial** | `POST /loans/simulate`, `POST /investments/simulate` | Evita que dos bancos muestren cuotas distintas para el mismo préstamo por diferencias de redondeo |
| **Registro consolidado** | `GET /persons/{cbu}/credit-report` | Un banco no puede ver la deuda que una persona tiene en otro banco; solo el Central puede |

Cada banco sigue debitando y acreditando en su propia base de datos. El Central registra y valida.

---

## 2. Cajas de ahorro en USD

### El problema

Hoy **CBU ≡ persona ≡ banco**: `POST /persons` genera un único CBU. No hay forma de tener dos monedas.

### La solución propuesta

Introducir **cuentas** como entidad: una persona tiene N cuentas en su banco, cada una con su propio CBU de 22 dígitos y su moneda.

```
Juan Pérez (DNI 30123456) en Banco 1
├── 0010001430123456000105  ARS  ← la creada por POST /persons (principal: true)
└── 0010001430123456000210  USD  ← nueva, vía POST /persons/{cbu}/accounts
```

**Compatibilidad hacia atrás:** `POST /persons` no cambia — sigue devolviendo un CBU, que ahora se define como la caja de ahorro en ARS. Un banco que no implemente USD no se entera de nada.

### Endpoints

| Método | Ruta | Para qué |
|---|---|---|
| `POST` | `/persons/{cbu}/accounts` | Abrir la caja de ahorro en USD. Devuelve CBU nuevo. Idempotente: `200` si ya existía, `201` si se creó — mismo criterio que `POST /persons` |
| `GET` | `/persons/{cbu}/accounts` | Listar las cuentas de una persona con su moneda y alias |
| `GET` | `/accounts/{cbu}` | Resolver un CBU → moneda, tipo, alias, banco y titular |

`GET /accounts/{cbu}` es el que hace falta **antes de transferir**: responde *qué cuenta es* (moneda), mientras que el existente `GET /persons/{cbu}` responde *quién es el titular*.

### Regla central: una transferencia nunca cruza monedas

`POST /transactions` con cuentas de distinta moneda devuelve `400` / `MONEDA_INCOMPATIBLE`. El motivo es simple: si se permitiera, habría que decidir quién elige el tipo de cambio y con qué cotización, y eso abre una discusión que no cierra.

Cambios sobre los endpoints existentes:

- `POST /transactions`: acepta `moneda` opcional (defensivo, se valida contra las cuentas) y la devuelve en la respuesta.
- `GET /transactions`: cada item incluye `moneda`.

### Cómo se compran dólares entonces

`POST /fx/exchanges` — la **única** operación del sistema que cruza monedas. Es intra-banco: mueve entre dos cuentas del mismo titular en el mismo banco.

```
compra:  cuenta ARS ──(paga a cotización venta)──► cuenta USD
venta:   cuenta USD ──(cobra a cotización compra)──► cuenta ARS
```

El Central publica la cotización oficial en `GET /fx/usd`. Cada banco puede aplicar su propio precio dentro de `spreadMaximoBancario` (±3% propuesto); si se pasa, la operación se rechaza con `400`. El Central devuelve el `importeDestino` calculado para que no haya discrepancias de redondeo.

`PUT /fx/usd` publica la cotización y queda reservado al docente (Bearer token, igual que `POST /banks`).

### Alias

`PUT /persons/{cbu}/alias` **no cambia su contrato**, pero como ya está indexado por CBU, ahora el alias queda asociado a esa cuenta. Cada moneda puede tener su alias (`juan.perez` y `juan.perez.usd`). Cero trabajo de migración.

---

## 3. Préstamos

### Fórmula acordada — sistema francés (cuota fija)

Este es el punto que **hay que cerrar sí o sí entre todos**, porque si cada banco redondea distinto los números no coinciden:

```
tem   = tna / 12 / 100
cuota = capital × tem / (1 − (1 + tem)^−cuotas)
```

Reglas de cálculo:

1. Redondeo a **2 decimales, half-up** (`ROUND_HALF_UP`, no el redondeo bancario de IEEE).
2. El interés de cada cuota se calcula sobre el **saldo remanente**.
3. La **última cuota absorbe el residuo** para que el saldo cierre exacto en 0.
4. `cft` = TEA = `((1 + tem)^12 − 1) × 100`. Sin cargos adicionales, CFT y TEA coinciden.

Ejemplo verificado (está en la spec como `example`): capital 1.000.000, 12 cuotas, TNA 72% → tem 6% → **cuota 119.277,03**, total 1.431.324,36, intereses 431.324,36, CFT 101,22%.

### Tasas

`GET /rates` devuelve, por moneda:

```yaml
prestamos:
  tnaReferencia: 72        # la tasa base del Banco Central
  spreadMaximo: 15         # cuánto puede sumar cada banco
  tnaMaxima: 87            # tnaReferencia + spreadMaximo — techo duro
  plazosPermitidos: [3, 6, 12, 18, 24, 36]
  punitoriosMultiplicadorMaximo: 1.5
```

Registrar un préstamo con `tna > tnaMaxima` devuelve `400` / `TNA_FUERA_DE_RANGO`. Si el banco no informa `tna`, se usa `tnaReferencia`.

**Un préstamo queda congelado con la tasa vigente al otorgarse.** Publicar tasas nuevas con `PUT /rates` no recalcula nada de lo ya registrado. `GET /rates/history` permite auditar con qué tasa se constituyó una operación vieja.

### Endpoints

| Método | Ruta | Para qué |
|---|---|---|
| `POST` | `/loans/simulate` | Cuota + cronograma completo, sin registrar nada. Para la pantalla de simulación |
| `POST` | `/loans` | Registrar el préstamo otorgado. El banco acredita el capital localmente |
| `GET` | `/loans` | Listar los préstamos de tu banco (filtros: `estado`, `cbu`) |
| `GET` | `/loans/{loanId}` | Detalle con cronograma y estado de cada cuota |
| `POST` | `/loans/{loanId}/payments` | Informar el pago de una cuota |
| `GET` | `/persons/{cbu}/credit-report` | Central de deudores consolidada |

Reglas de pago propuestas: **sin pagos parciales** (el `importe` debe cubrir la cuota), cuotas **en orden** (no se paga la 5 con la 4 pendiente), **mora a los 31 días corridos** del vencimiento, y **cancelación automática** del préstamo al pagar la última cuota.

### Central de deudores

Es la razón de fondo para registrar préstamos en el Central. Antes de prestar, tu banco consulta `GET /persons/{cbu}/credit-report` y ve la deuda de la persona **en todo el sistema**, con la clasificación estándar por mayor atraso:

| Situación | Descripción | Atraso |
|---|---|---|
| 1 | Normal | hasta 31 días |
| 2 | Riesgo bajo | 32 a 90 días |
| 3 | Riesgo medio | 91 a 180 días |
| 4 | Riesgo alto | 181 a 365 días |
| 5 | Irrecuperable | más de 365 días |

**Privacidad:** se informa *cuántos* bancos son acreedores (`bancosAcreedores: 2`), nunca *cuáles*.

`POST /loans` incluye un array `advertencias` cuando el titular tiene situación 3 o peor en otro banco. **No bloquea el otorgamiento** — la decisión crediticia es de cada banco, el Central solo informa.

---

## 4. Inversiones (plazo fijo)

### Fórmula acordada — interés simple, base 365

```
interes = capital × (tna / 100) × (dias / 365)
total   = capital + interes
tea     = ((1 + (tna/100) × (dias/365))^(365/dias) − 1) × 100
```

Mismo redondeo que préstamos: 2 decimales half-up. Base **365 días** (no 360).

Ejemplo verificado: capital 500.000, 30 días, TNA 58% → interés **23.835,62**, total 523.835,62, TEA 76,23%.

### Tasas

Acá el spread funciona al revés que en préstamos: el Central fija un **piso**, no un techo. Un banco no puede ofrecer menos de `tnaMinima`.

```yaml
plazoFijo:
  tnaReferencia: 58
  spreadMaximo: 5
  tnaMinima: 53              # tnaReferencia − spreadMaximo — piso duro
  plazoMinimoDias: 30
  plazoMaximoDias: 365
  tnaCancelacionAnticipada: 12
```

### Endpoints

| Método | Ruta | Para qué |
|---|---|---|
| `POST` | `/investments/simulate` | Interés y total, sin registrar |
| `POST` | `/investments` | Registrar el plazo fijo constituido |
| `GET` | `/investments` | Listar los de tu banco. `?estado=vencido` = los que hay que acreditar hoy |
| `GET` | `/investments/{investmentId}` | Detalle |
| `POST` | `/investments/{investmentId}/settle` | Informar acreditación o rescate anticipado |

Estados: `vigente` → `vencido` (pasó la fecha y el banco todavía no acreditó) → `acreditado`. La rama alternativa es `cancelado_anticipado`.

**Rescate anticipado:** el interés se recalcula con `tnaCancelacionAnticipada` sobre los días efectivamente transcurridos. `settle` devuelve `totalAcreditado` con el importe exacto a pagar.

Un plazo fijo en dólares se constituye sobre la caja de ahorro en USD: la moneda se deriva del CBU, no se envía.

---

## 5. Puntos a votar

Lo que sigue son decisiones donde elegí una opción, pero cualquiera es defendible. Son las que conviene cerrar en la reunión:

| # | Decisión | Lo que propongo | Alternativa |
|---|---|---|---|
| 1 | Formato del CBU de la cuenta USD | Opaco: lo genera el Central, solo se garantiza que sea único y de 22 dígitos. Se resuelve con `GET /accounts/{cbu}` | Codificar la moneda en un dígito fijo del CBU, para saber la moneda sin llamar al Central |
| 2 | Transferencias entre monedas distintas | Prohibidas (`400`). El cambio va aparte, por `POST /fx/exchanges` | Permitirlas y que el Central convierta a cotización oficial |
| 3 | ¿`POST /fx/exchanges` es obligatorio? | Sí, para que el Central valide el spread y todos los bancos apliquen precios comparables | Que cada banco maneje el cambio local y el Central solo publique la cotización |
| 4 | Base de días para plazo fijo | 365 | 360 (base comercial) |
| 5 | Pagos parciales de cuotas | No se aceptan | Aceptarlos y acumular hasta cubrir la cuota |
| 6 | Días para declarar mora | 31 corridos desde el vencimiento | 10, o el día siguiente |
| 7 | ¿Bloquear préstamos a deudores en situación 4-5? | No. El Central avisa con `advertencias`, decide el banco | Rechazar con `409` |
| 8 | Cantidad de monedas | Solo ARS y USD | Dejar el enum `Moneda` abierto para sumar EUR después |
| 9 | Quién publica tasas y cotización | El docente, con el Bearer token de registro | Un banco designado como autoridad monetaria |
| 10 | Campo `codigo` en los errores | Agregarlo, opcional, sin romper nada | Dejar `Error` como está, solo con `error` |

---

## 6. Corrección menor a la spec vigente

La v1.0.0 usa `exclusiveMinimum: 0` en `importe` de `POST /transactions`. Esa es la sintaxis de JSON Schema 2020-12; en **OpenAPI 3.0.3 el campo es booleano** y va acompañado de `minimum`. Los validadores estrictos rechazan el documento actual.

```yaml
# antes (no valida en 3.0.3)
importe: { type: number, exclusiveMinimum: 0 }

# después
importe: { type: number, minimum: 0, exclusiveMinimum: true }
```

Ya está corregido en toda la propuesta. Verificado con `openapi-spec-validator`: el documento pasa como OpenAPI 3.0.3 válido y los 10 `$ref` resuelven.

---

## 7. Orden de implementación sugerido

Los tres bloques son independientes; se pueden repartir entre equipos. La única dependencia real es que **inversiones y préstamos en USD necesitan que las cuentas USD existan primero**.

1. **Cuentas + `moneda` en transacciones** — es la base y toca el endpoint más usado
2. **`GET /rates` + `GET /fx/usd`** — endpoints de solo lectura, se pueden mockear con valores fijos el primer día y ya desbloquean a todos
3. **Préstamos** — el bloque más grande
4. **Inversiones** — el más chico, reutiliza el patrón de préstamos
5. **`credit-report`** — al final, porque necesita datos de préstamos cargados para ser útil
