const dotenv = require('dotenv');

dotenv.config();

const env = {
  port: Number(process.env.PORT || 3001),
  nodeEnv: process.env.NODE_ENV || 'development',
  logLevel: process.env.LOG_LEVEL,
  databaseUrl: process.env.DATABASE_URL,
  clerkSecretKey: process.env.CLERK_SECRET_KEY,
  clerkWebhookSigningSecret: process.env.CLERK_WEBHOOK_SIGNING_SECRET,
  corsOrigins: process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',').map((o) => o.trim()) : '*',
};

if (!env.databaseUrl) {
  throw new Error('Falta la variable de entorno DATABASE_URL.');
}

if (!env.clerkSecretKey) {
  throw new Error('Falta la variable de entorno CLERK_SECRET_KEY.');
}

module.exports = env;
