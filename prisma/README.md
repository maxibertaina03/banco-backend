# Prisma — schema y migraciones

Prisma es la **fuente de verdad del schema** de Banco Orbital. Los _services_
siguen usando SQL crudo (con `pg`) por decisión deliberada (ver más abajo),
pero la **estructura de la base** y las **migraciones** se gestionan con Prisma.

## Archivos

- `schema.prisma` — el modelo de datos (12 tablas). Editás esto para cambiar el schema.
- `migrations/0_init/` — baseline: todas las tablas, FKs, índices y uniques que Prisma maneja.
- `migrations/1_security_hardening/` — capa que **Prisma no sabe modelar**: RLS, políticas,
  CHECK constraints e índices parciales. Derivada de las migraciones legacy ya testeadas en prod.
- `migration_lock.toml` — fija el provider (postgresql).

## Por qué los services siguen en SQL crudo

La app entera consume **filas planas en snake_case** que vienen de `JOIN`s
(`user.persona_id`, `user.perfil_completo`, etc.). El cliente tipado de Prisma
devuelve objetos **anidados en camelCase** (`user.persona.perfilCompleto`), lo que
rompería routers, DTOs y el contrato con el frontend. Además `transacciones-service`
usa `SELECT ... FOR UPDATE` (locks de fila para la integridad del saldo), que Prisma
no expresa sin `$queryRaw`. Por eso Prisma se usa para **schema/migraciones y código
nuevo**, no para reescribir los services que ya andan y están testeados.

El cliente está disponible en `src/lib/prisma.js` para features nuevas que no
dependan del contrato plano.

## Workflow

### 1. Base existente (Supabase de prod) → baseline una sola vez

La base ya tiene todo aplicado (vía las migraciones legacy en `/migrations`). Para
que Prisma la reconozca sin re-ejecutar nada:

```bash
# Con DATABASE_URL apuntando a la base existente:
npm run prisma:baseline      # marca 0_init y 1_security_hardening como YA aplicadas
```

### 2. Base nueva (dev/CI desde cero)

```bash
npm run prisma:migrate       # prisma migrate deploy → aplica 0_init + 1_security_hardening
npm run db:seed              # carga datos de prueba (seed.sql)
```

> ⚠️ `1_security_hardening` se derivó de SQL ya testeado en prod pero **no se validó
> contra una base fresca desde acá**. Conviene revisar el primer `migrate deploy` en
> una base nueva.

### 3. Cambiar el schema (a futuro)

```bash
# 1. Editá schema.prisma
# 2. Generá la migración + aplicala en tu base de dev:
npm run prisma:migrate:dev -- --name descripcion_del_cambio
# 3. Revisá el SQL generado en migrations/<timestamp>_descripcion/
# 4. Si el cambio toca RLS/CHECK/índices parciales, agregá ese SQL a mano
#    en la migración generada (Prisma no los infiere).
# 5. Commiteás schema.prisma + la nueva carpeta de migración.
```

### 4. Regenerar el cliente tipado

```bash
npm run prisma:generate      # tras cambiar schema.prisma o instalar deps
```

## Relación con `/migrations` y `db-setup.js` (legacy)

La carpeta `/migrations` (en la raíz) y `scripts/db-setup.js` son el **registro
histórico** de lo aplicado a la base actual. Se conservan como referencia. De acá en
más, los cambios de schema van por Prisma (`prisma/migrations`).

## Limitaciones conocidas

- Prisma (v5) no modela **RLS, políticas, CHECK constraints ni índices parciales** →
  viven en `1_security_hardening` como SQL custom.
- `npm audit` marca un critical en **vitest** (devDependency); su fix requiere vitest 4,
  que necesita Node 20. Pendiente hasta subir Node.
