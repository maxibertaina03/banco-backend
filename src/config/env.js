const dotenv = require('dotenv');

dotenv.config();

const env = {
  port: Number(process.env.PORT || 3000),
  databaseUrl: process.env.DATABASE_URL,
};

if (!env.databaseUrl) {
  throw new Error('Falta la variable de entorno DATABASE_URL.');
}

module.exports = env;
