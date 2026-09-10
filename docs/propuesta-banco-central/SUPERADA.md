# ⚠️ Esta propuesta quedó superada — no implementar

Esta carpeta contiene la propuesta que **nosotros** llevamos a la reunión de
bancos en agosto de 2026: 20 endpoints nuevos para el Banco Central, con tasas
y cotización publicadas por él.

**No se aprobó tal cual.** Lo que se acordó, y lo que el Banco Central terminó
publicando, es bastante distinto:

| Punto | Esta propuesta | Lo que quedó |
|---|---|---|
| Endpoints nuevos al Central | 20 | 6 |
| Clave de la persona | CBU | DNI |
| Central de deudores | Por CBU, sin nombrar bancos | Por DNI, con nombre de cada entidad, y **cada banco informa** sus deudas |
| Tasas y cotización | `GET /rates` y `GET /fx/usd` del Central | APIs públicas reales: DolarAPI, ArgentinaDatos, BCRA, data912 |

## Qué sí sobrevivió

El método de cálculo. La fórmula del sistema francés que se acordó,
`C = M × [i×(1+i)ⁿ] / [(1+i)ⁿ−1]`, es algebraicamente idéntica a la de esta
propuesta, y el redondeo a 2 decimales ROUND_HALF_UP quedó como convención.
Está implementado y testeado en `src/utils/dinero.js`.

## Dónde mirar en su lugar

- La spec en vivo: <https://centralbank.brocoly.cc/openapi.json>
- El plan de trabajo: [../PLAN.md](../PLAN.md)

Se conserva como registro de la discusión, no como especificación.
