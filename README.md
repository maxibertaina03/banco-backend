# banco-backend

API REST para el sistema bancario, separada del frontend para publicarse como repositorio independiente.

## Stack

- Node.js
- Express
- PostgreSQL
- Zod

## Estructura

- `src/`: servidor, rutas, middlewares y módulos de negocio
- `schema.sql`: esquema de base de datos
- `seed.sql`: datos iniciales
- `postman/`: colección y environment para pruebas

## Variables de entorno

Copiar `.env.example` a `.env` y completar:

```bash
cp .env.example .env
```

Variables:

- `PORT`: puerto del backend
- `DATABASE_URL`: conexión a PostgreSQL o Supabase
- `CLERK_SECRET_KEY`: clave secreta de Clerk

## Base de datos

Antes de iniciar la API, la base debe tener el esquema cargado.

Opcion recomendada con scripts Node:

```bash
npm run db:setup
```

Esto ejecuta:

- `schema.sql`
- `seed.sql`

Tambien podés correrlos por separado:

```bash
npm run db:schema
npm run db:seed
```

Si preferís hacerlo manual con `psql`:

```bash
psql "$DATABASE_URL" -f schema.sql
psql "$DATABASE_URL" -f seed.sql
```

`seed.sql` carga datos ficticios consistentes para Orbital: roles, tipos de cuenta, tipos de transaccion, personas, usuarios, cuentas, destinatarios, transacciones y auditoria.

### Configuración del Banco Central

La conexión con el Banco Central se guarda en la tabla `banco_central_configuracion`, no en `.env`.

Ejemplo mínimo:

```sql
INSERT INTO banco_central_configuracion (
  environment,
  api_url,
  register_token,
  api_key,
  bank_name
) VALUES (
  'test',
  'https://centralbank.brocoly.cc/api',
  'TOKEN_DE_REGISTRO',
  'API_KEY_DEL_BANCO',
  'Banco Orbital'
)
ON CONFLICT (environment)
DO UPDATE SET
  api_url = EXCLUDED.api_url,
  register_token = EXCLUDED.register_token,
  api_key = EXCLUDED.api_key,
  bank_name = EXCLUDED.bank_name,
  activo = TRUE,
  updated_at = NOW();
```

También se puede administrar desde la API con rol `admin`:

- `GET /api/central-bank/config?environment=test`
- `PUT /api/central-bank/config`

El `GET` devuelve `registerToken` y `apiKey` enmascarados.

## Scripts

```bash
npm install
npm run dev
```

Para ejecutar sin watch:

```bash
npm start
```

## Endpoints

La API queda expuesta bajo:

```text
http://localhost:3001/api
```

`GET /api/health` queda público.

El resto de `/api` requiere:

- token `Bearer` válido de Clerk
- usuario enlazado en la tabla `usuarios`
- usuario marcado como `activo = true`

Política actual de acceso:

- `roles`, `personas_roles`, `usuarios`, `tipos_cuenta`, `cuentas`, `tipos_transaccion`, `auditoria` y `personas` quedaron restringidos a roles internos
- `destinatarios` puede ser gestionado por clientes, pero solo sobre sus propios registros
- `transacciones` y endpoints de relaciones aplican controles de propiedad y rol

Incluye CRUD para las entidades principales, endpoints de relaciones y operaciones transaccionales bancarias.
