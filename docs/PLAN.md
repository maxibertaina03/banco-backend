# Plan de trabajo — Banco Orbital

**Versión visual, más cómoda de leer:** https://claude.ai/code/artifact/1c210167-2d9a-49d3-8b04-f45804b6761b

Este archivo es la versión versionada y grepeable del mismo plan.
Última actualización: 18 de agosto de 2026, contra la spec en vivo del Banco Central.

---

## Estado al arrancar

| | |
|---|---|
| Tests backend | 139, en verde |
| Build frontend | verde |
| Runtime | arranca, BD conectada, rutas responden 401 |

---

## El Banco Central ya publicó los endpoints

Verificado contra `centralbank.brocoly.cc/openapi.json`: la spec creció de
15,5 KB a 22,8 KB y sumó seis rutas.

| Endpoint | Qué hace | ¿Estaba en el acuerdo? |
|---|---|---|
| `POST /accounts` | Abrir caja de ahorro ARS o USD (`dni`, `moneda`) | Sí |
| `GET /accounts/{cbu}` | Buscar cuenta por CBU | No, es nuevo |
| `PUT /accounts/{cbu}/alias` | Alias propio por cuenta | No, es nuevo |
| `GET /accounts/alias/{alias}` | Buscar cuenta por alias | No, es nuevo |
| `POST /central-deudores` | Informar o actualizar una deuda propia | **No, y agranda el alcance** |
| `GET /central-deudores/{dni}` | Situación crediticia consolidada | Sí, pero era por CUIT |

### Cinco diferencias contra el documento acordado

1. **`POST /central-deudores` es obligatorio y no estaba.** La consulta no sirve
   si nadie informa. Un informe activo por DNI: volver a llamar actualiza monto y
   situación en vez de duplicar. La `entidad` sale del banco autenticado.
2. **Es por DNI, no por CUIT.** Valida 7 u 8 dígitos.
3. **`GET /persons/{dni}/accounts` no existe.** No se pueden listar las cuentas de
   una persona: hay que guardar el CBU en USD localmente. Si se pierde, se recupera
   volviendo a llamar a `POST /accounts`, que devuelve `200` con los datos existentes.
4. ~~**ARS y USD no se resuelven igual.**~~ **Desmentido al probarlo** (ver abajo):
   `GET /accounts/{cbu}` funciona para las dos monedas y siempre devuelve `moneda`.
   Su propia documentación dice lo contrario. Es el endpoint a usar para resolver
   cualquier CBU. Sí se confirma que `POST /accounts` con `ARS` nunca crea: devuelve
   `200` con el CBU que ya nació en `POST /persons`.
5. **`POST /transactions` no tiene campo `moneda` ni valida monedas.** El Central
   acepta una transferencia de un CBU en pesos a uno en dólares y mueve el `importe`
   tal cual. **Riesgo crítico, hay que plantearlo en el grupo de bancos.**
   Defensa local: resolver la moneda de ambos CBU antes de transferir y rechazar.

---

## Fases

Están numeradas porque son una secuencia real: cada una desbloquea la siguiente.
Las fases 0 a 2 son de a uno; de la 3 en adelante se trabaja en paralelo.

### Fase 0 — Higiene *(hecha, salvo las ramas)*
- [x] Commitear `Dinero` y el renombre a español
- [x] Mover los documentos compartidos a `banco-backend/docs/`
- [x] Marcar `propuesta-banco-central/` como superada
- [ ] Sincronizar `main` desde `masita` en los dos repos
- [x] **Frontend de Gonza integrado** (8 sep): su rama ya salía de la `main` nueva,
      así que entró por fast-forward. El widget del chatbot está en `main`. Se
      eliminó un `ChatbotWidget.tsx` duplicado que había quedado sin usar
- [ ] **Falta el backend del chatbot.** Su rama `gonza` del backend sigue 33 commits
      atrás, con 2 commits propios. Se portan los 3 archivos a una rama nueva
- [x] `main` y `develop` sincronizadas con el último estado en los dos repos
- [ ] Limpiar branches `backup/*` y podar el worktree fantasma
- [ ] Acordar el flujo: rama por feature desde `main`, PR con CI en verde

### Fase 1 — El contrato primero *(Maxi + Gonza, juntos)*
Escribir el OpenAPI de nuestro banco **antes** de implementar. Es lo único que
permite avanzar en paralelo sin bloquearse.
- [x] `docs/openapi-banco-orbital.yaml` — 24 paths, 26 operaciones, 14 schemas.
      Cuentas, transacciones, tarjetas, préstamos, plazos fijos y catálogos
- [x] `docs/openapi-banco-proveedores.yaml` — 5 paths. Servicios y recargas
- [x] Auth con Clerk, errores `{ error }`, paginación `page`/`limit`,
      `Idempotency-Key` en todo endpoint que mueve plata
- [x] Los dos validan como OpenAPI 3.0.3 con `openapi-spec-validator`
- [x] **Gonza los revisó y aprobó** (8 sep 2026)
- [ ] Llevar al grupo el tema de las monedas en `POST /transactions`
- Nombres según el glosario; `monto` interno vs `importe` hacia el Central
- Importes como `number`, consistente con los DTOs y con el Central
- [x] **APIs públicas externas probadas** — ver resultados abajo
- [x] **Seis rutas del Central probadas** contra `x-environment: test` — ver abajo
- [ ] Llevar al grupo el tema de las monedas en `POST /transactions`

#### Resultado de probar el Banco Central (ambiente `test`)

Somos **bankCode 6, "Banco Orbital"**. Se creó una persona de prueba (DNI 48123456)
con su caja en pesos y otra en dólares.

| Llamada | Resultado |
|---|---|
| `POST /persons` | `201` → CBU pesos `0060001948123456001608` |
| `POST /accounts` USD | `201` → CBU `0060001948123456001707` |
| `POST /accounts` USD otra vez | `200` idempotente, como documenta |
| `POST /accounts` ARS | `200` "la cuenta en ARS ya existe — se creó junto con la persona" |
| `GET /accounts/{cbu}` **ARS** | **`200`** — la doc decía que no encontraba ARS |
| `GET /accounts/{cbu}` USD | `200` con `moneda` y `saldo` |
| `GET /persons/{cbu}` ARS | `200` pero **sin** campo `moneda` |
| `PUT /accounts/{cbu}/alias` | `200` |
| `GET /accounts/alias/{alias}` | `200` |
| `POST /central-deudores` | `201` la primera vez, `200` "Deuda actualizada" al repetir |
| `GET /central-deudores/{dni}` | `200`, `situacion` = la peor de las informadas |
| `GET /central-deudores/{dni}` sin deudas | **`200` con `deudas: []`**, no el `404` que documenta |
| `GET /central-deudores/123` | `400` "Se esperan 7 u 8 dígitos" |

**Tres correcciones al plan:**

1. **No hay asimetría ARS/USD.** `GET /accounts/{cbu}` resuelve las dos monedas y
   siempre trae `moneda`. **Es el único endpoint que hace falta** para resolver un CBU:
   el helper con fallback a `/persons/{cbu}` que estaba en la fase 2 ya no va.
2. **`/central-deudores/{dni}` nunca devuelve 404.** Para un DNI sin deudas contesta
   `200` con `situacion: 1` y `deudas: []`. No se puede distinguir "no existe" de "sin
   deudas", pero da igual: la decisión se toma sobre `situacion`.
3. **El CBU embebe el DNI.** `006` (nuestro bankCode) + `0019` + los 8 dígitos del DNI
   + un sufijo por cuenta. Sirve para depurar, pero **no confiar en ese formato** para
   CBUs de otros bancos.

#### Resultado de probar las APIs externas (18 ago 2026)

| API | Estado | Hallazgo |
|---|---|---|
| DolarAPI `/v1/dolares` | ✅ 200, 0,47 s | 7 cotizaciones (oficial, blue, bolsa, ccl, mayorista, cripto, tarjeta). Campos `compra`/`venta`/`fechaActualizacion` |
| ArgentinaDatos plazo fijo | ✅ 200 | 32 bancos, con `tasas[]` por plazo en días |
| ArgentinaDatos préstamos | ✅ 200 | 25 entidades, con `tna`, `tea`, `cftTea` y `tasasPorPlazo` |
| ArgentinaDatos UVA | ✅ 200 | 3.794 valores diarios, último 2082,26 |
| data912 CEDEARs | ✅ 200 | El path del documento **es correcto**: 952 items |
| BCRA Transparencia | ❌ 404 | **Descartada**, ver abajo |

**Tres cosas que cambian el trabajo:**

1. **La TNA viene como fracción decimal, no como porcentaje.** ArgentinaDatos
   devuelve `tna: 0.19` para una tasa del 19 %. Nuestro `Dinero` y la fórmula
   acordada trabajan en porcentaje. El adapter tiene que normalizar en un solo
   lugar, o vamos a calcular cuotas 100 veces más chicas.
2. **BCRA queda descartada.** El path del documento acordado
   (`/estadisticas/v1.0/Transparencia`) devuelve 404, y los endpoints de
   estadísticas dan `410 Gone`. Sólo responde `estadisticascambiarias`. No hace
   falta: ArgentinaDatos ya cubre plazo fijo y préstamos personales, que era
   para lo que íbamos a usar BCRA.
3. **data912 no tiene los campos que esperaba el documento.** No devuelve
   `ratio` ni `precioARS`, sino datos de mercado crudos: `symbol`, `px_bid`,
   `px_ask`, `c` (último), `pct_change`. El precio hay que tomarlo de `c` o
   `px_ask`, y el ratio del CEDEAR hay que conseguirlo aparte o fijarlo a mano
   para los pocos tickers que usemos.

**Un riesgo que se cierra:** la UVA viene con 2 decimales (2082,26), así que la
escala de `Dinero` alcanza. Queda por revisar sólo el ratio de CEDEARs, que no
es un importe monetario.

### Fase 2 — Cimientos *(Maxi, backend)* — casi terminada
Bloquea todo lo demás.
- [x] Migración `20260908_cuentas_multimoneda.sql` — **falta correrla en Supabase**
- [x] Seis rutas del Central en `central-bank-service`
- [x] Adapter de mercado en `src/modules/mercado/` + `mercado-service.js`
- [x] Chequeo crediticio en `riesgo-crediticio.js`
- [x] `POST /api/personas/:id/cuentas/apertura` con `cuentas-service.js`
- [ ] Probar de punta a punta contra el ambiente `test`, después de la migración

**Decidido:** si DolarAPI está caída, la compra y venta de dólares **se bloquea**
con 503. Mostrar un precio viejo en pantalla es aceptable; cobrarle al cliente a
ese precio no, porque le venderíamos a un valor que ya no existe.
`obtenerCotizacionDolar()` sirve para mostrar, `obtenerCotizacionParaOperar()`
para operar.
- Extender `central-bank-client.js` con las seis rutas nuevas
- Resolver la moneda de un CBU con `GET /accounts/{cbu}`, que sirve para las dos
  monedas (verificado). No hace falta el fallback que estaba planeado
- Adapter de APIs externas en `src/modules/mercado/` con caché TTL y timeout
- Una función de chequeo crediticio contra `GET /central-deudores/{dni}`, usada **en el alta y al otorgar préstamos**: situación 3 o peor bloquea las dos cosas

### Fase 3 — Cuentas y cambio de divisa
Depósitos, extracciones, movimientos y compra/venta de dólares a la cotización
**`oficial` de DolarAPI**, más **validación de moneda en toda transferencia** ya que
el Central no la hace. Todo con `Idempotency-Key`.

### Fase 4 — Tarjetas
Emisión débito/crédito, autorización de consumos, bloqueo, resumen mensual con CFT.

### Fase 5 — Préstamos e inversiones
Sistema francés con `Dinero`, plazos fijos base 365, CEDEARs.
**Informar la deuda al Central** con `POST /central-deudores` al otorgar y al
cambiar la situación: es lo que hace que la consulta de la fase 2 sirva para todos.

### Fase 6 — Proveedores y dominios simples
Repo `banco-proveedores` con los mocks de terceros (recargas, empresas de
servicios), más seguros y reservas dentro del banco.

### Fase 7 — Reportes y asistente con IA
**El asistente ya existe.** Gonza lo construyó y lo pusheó el 31 de agosto en la
rama `gonza` del backend: `chatbot-router.js` + `chatbot-service.js` + tests,
usando **Gemini** (no Claude, como decía el plan viejo). Incluye guardarrailes
contra prompt injection, rate limit propio de 30 req/15 min y una lista de
patrones sensibles que filtra pedidos y respuestas.

Lo que falta no es construirlo, es **portarlo**: su rama sale de un backend de
abril y está 27 commits atrás, así que se copian los 3 archivos sobre una rama
nueva desde `main` y se re-cablean. Detalle que rompe si se pasa por alto:
`chatbot-router.js` hace `require('../middlewares/clerk-auth')` como default,
pero en `main` ese módulo exporta un objeto — va con destructuring.

**El asistente es de solo lectura.** Responde sobre el saldo, los movimientos, si el
cliente califica para un préstamo y sus propios datos. **No ejecuta ninguna acción**,
ni siquiera bloquear una tarjeta: todo lo que sea operar se deriva a los canales del
banco. Eso saca de la mesa el riesgo más grande de un asistente con IA y hace que la
fase sea bastante más corta.

Queda pendiente de la fase:
- Portar y renombrar según el glosario
- Darle acceso de lectura a saldo, movimientos y elegibilidad crediticia, siempre
  **acotado al cliente autenticado**. Es la regla que hay que testear explícitamente:
  que no pueda contestar sobre otra persona aunque se lo pidan
- Reportes: resumen de gastos por categoría y exportación de movimientos

---

## Reparto

| Área | Dueño |
|---|---|
| Contrato OpenAPI | Los dos |
| Cimientos, Central, APIs externas | Maxi |
| Cálculo financiero y central de deudores | Maxi |
| Portal, secciones, formularios | Gonza |
| Dominios simples, punta a punta | Gonza |
| Revisión cruzada de PRs | Los dos |

Sale del historial real: backend 21 commits de Codex y 3 de Máximo; frontend 20 de `goncast12`.

---

## Decisión: los proveedores van aparte

Recargas, servicios y demás **no se implementan dentro del backend**: van como
**mocks de terceros** en un repo nuevo y compartido, `banco-proveedores`, que el
banco consume por HTTP como si fueran externos de verdad.

- **Qué mockea:** operadoras de celular (recargas), empresas de servicios
  (catálogo, deuda, pagos) y lo que haga falta simular de un proveedor externo.
- **Qué NO va ahí:** préstamos, plazos fijos y tarjetas son negocio del banco,
  no de un tercero. Se quedan en `banco-backend`. Las **tasas** tampoco: salen de
  ArgentinaDatos, que es una API real.
- **Por qué así:** el banco termina hablando con proveedores por HTTP igual que
  en la vida real, y el mock se puede tirar abajo para probar timeouts y caídas
  sin tocar el banco.
- **Dueño:** Gonza puede tomar el repo entero, junto con las secciones del portal
  que lo consumen.

El adapter de `src/modules/mercado/` termina siendo la única puerta de entrada a
datos de afuera, sean APIs reales (DolarAPI, ArgentinaDatos) o nuestros mocks.

---

## Decisiones tomadas (Maxi + Gonza)

Cerradas en conjunto. Si alguna cambia, se actualiza acá primero y después el código.

| # | Decisión | Qué implica |
|---|---|---|
| 1 | **v1 = cuentas, tarjetas, préstamos y plazos fijos.** Seguros, CEDEARs y reservas van a v2 | El OpenAPI de la fase 1 sólo cubre la v1 |
| 2 | **Clerk sigue siendo la autenticación** | `securityScheme: http bearer` con el JWT de Clerk. Sin cambios en el backend |
| 3 | **Formato de error igual al del Central**: `{ error }` | **No requiere trabajo**: el Central usa `{ error }` en errores y `message` sólo en confirmaciones de éxito, y nuestro `error-handler` ya hace lo mismo. Queda descartado el campo `codigo` que se había propuesto |
| 4 | **Idempotencia en todo lo que mueve plata** | El middleware ya existe. Se suma `Idempotency-Key` a pagos de cuota, compra/venta de dólares, autorizaciones de tarjeta, depósitos y extracciones |
| 5 | **Paginación `page`/`limit`** con `{page, limit, count, data}` | Se mantiene lo que ya hay. Sin cursores |
| 6 | **`banco-proveedores` con API key fija** | Key en `.env`, consumible en cualquier momento. No simula caídas por ahora |
| 7 | **Situación 3 o peor bloquea todo**: alta de cuenta y otorgamiento de préstamos | Una sola función de chequeo, usada en los dos lugares |
| 8 | **Cotización: DolarAPI, casa `oficial`** | Es una constante del adapter. Cambiarla a `blue` o `mayorista` es una línea |
| 9 | **Gemini con la cuenta gratuita del equipo** | `GEMINI_API_KEY` en `.env`, nunca commiteada. El plan gratuito tiene límite de pedidos: el rate limit de 30 cada 15 minutos que ya trae el chatbot ayuda a no agotarlo |
| 10 | **El asistente es de SOLO LECTURA** | Responde sobre saldo, movimientos, si califica para un préstamo y datos del cliente autenticado. **No ejecuta ninguna acción**, ni siquiera bloquear una tarjeta. Todo lo que sea operar se deriva a los canales del banco |

### Lo único que queda abierto

**Cada cuánto se actualiza la situación de un deudor.** Informar al otorgar el préstamo
está claro; lo que falta es qué dispara la actualización cuando el cliente entra en mora.
Sin algo periódico, la mora nunca llega al Central. Tres opciones, para decidir antes de
la fase 5:

- Al registrar cada pago de cuota, recalcular y reinformar. Simple, sin infraestructura,
  pero no detecta al que **deja** de pagar, que es justamente el caso que importa.
- Un endpoint interno que recorra los préstamos vencidos, disparado a mano o por cron
  externo. Es lo que ya se hace con la limpieza de `idempotency_keys`.
- Un job en el arranque del server con `setInterval`. El más fácil y el más frágil.

---

## Riesgos

| Riesgo | Nota |
|---|---|
| Transferencias sin moneda | El más serio, y no lo arreglamos solos. Al grupo en la fase 1 |
| ~~data912 y BCRA sin confirmar~~ | **Resuelto:** data912 anda, BCRA descartada. Ver fase 1 |
| Alcance grande para dos personas | Si hay que cortar, se corta por el final |
| `Dinero` redondea a 2 decimales | UVA verificada, entra en 2 decimales. Queda el ratio de CEDEARs, que no es dinero |
| Node 18 | Limita versiones de dependencias nuevas |
| **`GEMINI_API_KEY` es un secreto ya, no en la fase 7** | El chatbot de Gonza la necesita para funcionar. Definir dónde vive y quién paga antes de portarlo |

## Dos lecciones ya aprendidas

1. **Los tests y el build no detectan todo.** Un renombre corrompió un path de
   `require` y sólo apareció al arrancar la app. El CI del backend ya corre
   `require('./src/app')`; falta el equivalente en el frontend.
2. **La spec publicada no coincidió con el acuerdo** en cinco puntos. Releer
   `openapi.json` del Central antes de cada fase que lo toque.
