require('dotenv').config();

const env = {
  port: Number(process.env.PORT || 3001),
  nodeEnv: process.env.NODE_ENV || 'development',
  logLevel: process.env.LOG_LEVEL,
  databaseUrl: process.env.DATABASE_URL,
  clerkPublishableKey: process.env.CLERK_PUBLISHABLE_KEY,
  clerkSecretKey: process.env.CLERK_SECRET_KEY,
  clerkWebhookSigningSecret: process.env.CLERK_WEBHOOK_SIGNING_SECRET,
  geminiApiKey: process.env.GEMINI_API_KEY,
  geminiModel: process.env.GEMINI_MODEL || 'gemini-3.6-flash',
  proveedoresUrl: process.env.PROVEEDORES_URL || 'http://localhost:4000',
  proveedoresApiKey: process.env.PROVEEDORES_API_KEY,
  // Sin CORS_ORIGINS, el valor por defecto depende de dónde corra: en el
  // servidor sólo el dominio del portal, y en una máquina de desarrollo
  // también Vite. Antes el default era el dominio de producción a secas, y
  // entonces levantar el backend local sin CORS_ORIGINS en el .env dejaba el
  // portal de localhost:5173 bloqueado por CORS sin que nada lo dijera.
  corsOrigins: process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',').map((o) => o.trim())
    : process.env.NODE_ENV === 'production'
      ? ['https://app.orbital.net.ar']
      : ['https://app.orbital.net.ar', 'http://localhost:5173', 'http://127.0.0.1:5173'],
};

if (!env.databaseUrl) {
  throw new Error('Falta la variable de entorno DATABASE_URL.');
}

if (!env.clerkSecretKey) {
  throw new Error('Falta la variable de entorno CLERK_SECRET_KEY.');
}

module.exports = env;