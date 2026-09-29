# syntax=docker/dockerfile:1

# ── Dependencias ──────────────────────────────────────────────────────────────
# Se instalan en una etapa aparte para que Docker reutilice la capa mientras el
# package-lock no cambie: recompilar después de tocar código no vuelve a bajar
# nada de npm. En un droplet de 512 MB eso es la diferencia entre un deploy de
# dos minutos y uno de diez.
FROM node:22-slim AS deps

WORKDIR /app
COPY package.json package-lock.json ./

# --omit=dev deja afuera vitest y Prisma. Prisma sólo genera migraciones, que se
# aplican a mano contra Supabase: el contenedor nunca toca el esquema.
RUN npm ci --omit=dev && npm cache clean --force


# ── Runtime ───────────────────────────────────────────────────────────────────
# `slim` (Debian) y no `alpine` a propósito: los montos y las fechas se arman
# con Intl en locale es-AR ("$ 1.500.000", "28 sep 2026"), y una imagen con ICU
# recortado los devuelve mal sin avisar.
FROM node:22-slim AS runtime

ENV NODE_ENV=production
ENV PORT=3001
# Las fechas de negocio (utils/fechas.js) se calculan en hora local a propósito:
# un préstamo se otorga "el 8 de septiembre", no "el 9 a las 00:14 UTC". El
# servidor corre en UTC, así que hay que decirle dónde está parado el banco.
ENV TZ=America/Argentina/Buenos_Aires

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

# El usuario `node` ya viene en la imagen. Nada de root: si alguien logra
# ejecutar algo adentro del contenedor, que no sea con todos los permisos.
USER node

EXPOSE 3001

# Usa el endpoint que ya existe (app.js), que además verifica la conexión a la
# base: si Supabase se cae, el contenedor se marca unhealthy en vez de seguir
# contestando 500. Con el fetch de Node no hace falta instalar curl.
HEALTHCHECK --interval=60s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3001/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

# Forma exec: node queda como PID 1 y recibe el SIGTERM de Docker, que es lo que
# dispara el apagado ordenado de server.js.
CMD ["node", "src/server.js"]
