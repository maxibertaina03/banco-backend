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

## Base de datos

Antes de iniciar la API, la base debe tener el esquema cargado.

Ejemplo con `psql`:

```bash
psql "$DATABASE_URL" -f schema.sql
psql "$DATABASE_URL" -f seed.sql
```

`seed.sql` es opcional y sirve para cargar datos de prueba.

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
