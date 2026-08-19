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
4. **ARS y USD no se resuelven igual.** `GET /accounts/{cbu}` sólo encuentra cuentas
   que no son ARS; la caja en pesos se busca con `GET /persons/{cbu}`. Y
   `POST /accounts` con `moneda: "ARS"` nunca crea, siempre devuelve `200`.
5. **`POST /transactions` no tiene campo `moneda` ni valida monedas.** El Central
   acepta una transferencia de un CBU en pesos a uno en dólares y mueve el `importe`
   tal cual. **Riesgo crítico, hay que plantearlo en el grupo de bancos.**
   Defensa local: resolver la moneda de ambos CBU antes de transferir y rechazar.

---

## Fases

Están numeradas porque son una secuencia real: cada una desbloquea la siguiente.
Las fases 0 a 2 son de a uno; de la 3 en adelante se trabaja en paralelo.

### Fase 0 — Higiene *(en curso)*
- [x] Commitear `Dinero` y el renombre a español
- [x] Mover los documentos compartidos a `banco-backend/docs/`
- [x] Marcar `propuesta-banco-central/` como superada
- [ ] Sincronizar `main` desde `masita` en los dos repos
- [ ] Recrear `gonza` y `develop` desde la `main` nueva
- [ ] Limpiar branches `backup/*` y podar el worktree fantasma
- [ ] Acordar el flujo: rama por feature desde `main`, PR con CI en verde

### Fase 1 — El contrato primero *(Maxi + Gonza, juntos)*
Escribir el OpenAPI de nuestro banco **antes** de implementar. Es lo único que
permite avanzar en paralelo sin bloquearse.
- `docs/openapi-banco-orbital.yaml` con los endpoints del estándar interno
- Nombres según el glosario; `monto` interno vs `importe` hacia el Central
- Importes como `number`, consistente con los DTOs y con el Central
- **Probar las seis rutas nuevas con `curl`** contra `x-environment: test`
- **Probar las cuatro APIs públicas externas** (DolarAPI, ArgentinaDatos, BCRA, data912)
- Llevar al grupo el tema de las monedas en `POST /transactions`
- **Decidir el recorte de servicios propios** (ver "Pendiente de definición")

### Fase 2 — Cimientos *(Maxi, backend)*
Bloquea todo lo demás.
- Cuentas multi-moneda: N cuentas por persona, cada una con CBU, moneda y alias.
  **Guardar siempre el CBU en USD localmente**, porque el Central no lo lista.
- Extender `central-bank-client.js` con las seis rutas nuevas
- Helper que resuelva la moneda de un CBU probando `/accounts/{cbu}` y cayendo a
  `/persons/{cbu}`, para tapar la asimetría en un solo lugar
- Adapter de APIs externas en `src/modules/mercado/` con caché TTL y timeout
- Consultar `GET /central-deudores/{dni}` en el alta y bloquear de situación 3 en adelante

### Fase 3 — Cuentas y cambio de divisa
Depósitos, extracciones, movimientos, compra/venta de dólares a cotización de
DolarAPI, y **validación de moneda en toda transferencia** ya que el Central no la hace.

### Fase 4 — Tarjetas
Emisión débito/crédito, autorización de consumos, bloqueo, resumen mensual con CFT.

### Fase 5 — Préstamos e inversiones
Sistema francés con `Dinero`, plazos fijos base 365, CEDEARs.
**Informar la deuda al Central** con `POST /central-deudores` al otorgar y al
cambiar la situación: es lo que hace que la consulta de la fase 2 sirva para todos.

### Fase 6 — Dominios simples
Servicios, recargas, seguros, reservas.

### Fase 7 — Reportes y asistente con IA
Va último: el asistente sólo sirve si ya existen las acciones que puede ejecutar.

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

## Pendiente de definición

**Servicios propios separados.** Maxi planteó que recargas, servicios, préstamos y
compañía vayan como **APIs aparte** que el banco consume, en vez de vivir dentro del
backend. Falta cerrar el alcance antes de escribir el contrato de la fase 1:
si son mocks de terceros (telco, empresas de servicios) o si es partir nuestro
propio banco en servicios por dominio. Cambia bastante el trabajo, así que se
decide antes de la fase 1.

---

## Riesgos

| Riesgo | Nota |
|---|---|
| Transferencias sin moneda | El más serio, y no lo arreglamos solos. Al grupo en la fase 1 |
| data912 y BCRA sin confirmar | Probar con `curl` en la fase 1, no en la 5 |
| Alcance grande para dos personas | Si hay que cortar, se corta por el final |
| `Dinero` redondea a 2 decimales | Revisar para UVA y ratios de CEDEARs antes de la fase 5 |
| Node 18 | Limita versiones de dependencias nuevas |
| API key del asistente | Definir secreto y costo antes de la fase 7 |

## Dos lecciones ya aprendidas

1. **Los tests y el build no detectan todo.** Un renombre corrompió un path de
   `require` y sólo apareció al arrancar la app. El CI del backend ya corre
   `require('./src/app')`; falta el equivalente en el frontend.
2. **La spec publicada no coincidió con el acuerdo** en cinco puntos. Releer
   `openapi.json` del Central antes de cada fase que lo toque.
