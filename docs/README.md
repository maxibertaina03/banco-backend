# Documentación de Banco Orbital

Estos documentos aplican a los **dos** repos (`banco-backend` y `banco-frontend`).
Viven acá porque el backend es donde está el contrato de la API; el README del
frontend apunta a esta carpeta.

| Documento | Qué es |
|---|---|
| [GLOSARIO.md](GLOSARIO.md) | **Leer antes de escribir código.** Un nombre por concepto: es el contrato de nomenclatura del sistema |
| [PLAN.md](PLAN.md) | Plan de trabajo por fases y decisiones tomadas. **Texto canónico** |
| [REPARTO.md](REPARTO.md) | **Quién hace qué**, en qué orden, y qué necesita cada cosa para arrancar |
| [openapi-banco-orbital.yaml](openapi-banco-orbital.yaml) | **Contrato de nuestra API.** Lo que implementa el backend y consume el frontend |
| [openapi-banco-proveedores.yaml](openapi-banco-proveedores.yaml) | Contrato de los mocks de terceros, que viven en un repo aparte |
| [plan.html](plan.html) | Fuente de la versión visual del plan, la que se comparte como página |
| [CHANGELOG.md](CHANGELOG.md) | Historial de cambios del proyecto |
| [entregas.md](entregas.md) | Seguimiento de entregas de la cursada |
| [GUIA_RAPIDA.md](GUIA_RAPIDA.md) | Cómo levantar el proyecto |
| [propuesta-banco-central/](propuesta-banco-central/) | **Superada.** Ver el aviso dentro de la carpeta |
| `api_banco_central_documentacion.pdf` | Documentación original del Banco Central (histórica) |

## La fuente de verdad del Banco Central

No es ninguno de estos archivos, es la spec en vivo:

```
https://centralbank.brocoly.cc/openapi.json
```

Conviene volver a bajarla antes de cada fase que la toque. Ya pasó una vez que
lo publicado no coincidía con lo acordado en cinco puntos.
