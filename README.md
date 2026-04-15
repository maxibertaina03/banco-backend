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
http://localhost:3000/api
```

Incluye CRUD para las entidades principales, endpoints de relaciones y operaciones transaccionales bancarias.
