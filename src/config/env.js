const dotenv = require('dotenv');

dotenv.config();

const env = {
  port: Number(process.env.PORT || 3000),
  databaseUrl: process.env.DATABASE_URL,
  clerkSecretKey: process.env.CLERK_SECRET_KEY,
};

if (!env.databaseUrl) {
  throw new Error('Falta la variable de entorno DATABASE_URL.');
}

if (!env.clerkSecretKey) {
  throw new Error('Falta la variable de entorno CLERK_SECRET_KEY.');
}

module.exports = env;
