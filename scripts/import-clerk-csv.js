#!/usr/bin/env node

/**
 * Importa usuarios desde `usuarios-para-clerk.csv` hacia Clerk usando la Backend API.
 *
 * Clerk recomienda migraciones programáticas para importaciones masivas.
 * Referencias oficiales:
 * - https://clerk.com/docs/main-concepts/import-users
 * - https://clerk.com/docs/reference/backend/user/create-user
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const clerkSecretKey = process.env.CLERK_SECRET_KEY;
const csvPath =
  process.env.CLERK_IMPORT_CSV_PATH ||
  path.join(__dirname, '..', 'usuarios-para-clerk.csv');

if (!clerkSecretKey) {
  console.error('❌ Error: Falta CLERK_SECRET_KEY en .env');
  process.exit(1);
}

if (!fs.existsSync(csvPath)) {
  console.error(`❌ Error: No existe el archivo CSV en ${csvPath}`);
  process.exit(1);
}

const clerkApi = axios.create({
  baseURL: 'https://api.clerk.com/v1',
  headers: {
    Authorization: `Bearer ${clerkSecretKey}`,
    'Content-Type': 'application/json',
  },
});

function parseCsvLine(line) {
  const values = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === ',' && !inQuotes) {
      values.push(current);
      current = '';
      continue;
    }

    current += char;
  }

  values.push(current);
  return values.map((value) => value.trim());
}

function parseCsv(content) {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length < 2) return [];

  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    return headers.reduce((acc, header, index) => {
      acc[header] = values[index] || '';
      return acc;
    }, {});
  });
}

function buildTempPassword(email) {
  const local = (email.split('@')[0] || 'usuario').replace(/[^a-zA-Z0-9]/g, '');
  return `${local}Temp#2026!`;
}

function normalizeUsername(username, email) {
  const fallback = email.split('@')[0] || 'usuario';
  const source = (username || fallback)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  const cleaned = source
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');

  return cleaned || `user_${Date.now()}`;
}

async function createUserInClerk(row) {
  const email = row.email_address;
  const payload = {
    email_address: [email],
    first_name: row.first_name || undefined,
    last_name: row.last_name || undefined,
    password: buildTempPassword(email),
    skip_password_checks: true,
    username: normalizeUsername(row.username, email),
  };

  const response = await clerkApi.post('/users', payload);
  return response.data;
}

async function importCsv() {
  const csvContent = fs.readFileSync(csvPath, 'utf-8');
  const rows = parseCsv(csvContent);

  if (rows.length === 0) {
    console.error('❌ Error: El CSV no tiene filas de usuarios');
    process.exit(1);
  }

  console.log(`\n📥 Importando ${rows.length} usuarios desde ${path.basename(csvPath)}...\n`);

  let created = 0;
  let existing = 0;
  let failed = 0;

  for (const [index, row] of rows.entries()) {
    const email = row.email_address;
    console.log(`[${index + 1}/${rows.length}] ${email}`);

    try {
      const user = await createUserInClerk(row);
      console.log(`  ✅ Creado en Clerk: ${user.id}\n`);
      created += 1;
    } catch (error) {
      const errors = error.response?.data?.errors || [];
      const message = errors.map((item) => `${item.code}: ${item.message}`).join(', ') || error.message;

      if (message.toLowerCase().includes('already exists')) {
        console.log(`  ↺ Ya existía en Clerk\n`);
        existing += 1;
      } else {
        console.log(`  ❌ Error: ${message}\n`);
        failed += 1;
      }
    }
  }

  console.log('═══════════════════════════════════');
  console.log('📊 RESUMEN');
  console.log('═══════════════════════════════════');
  console.log(`✅ Creados: ${created}`);
  console.log(`↺ Ya existentes: ${existing}`);
  console.log(`❌ Fallidos: ${failed}`);
  console.log('═══════════════════════════════════\n');

  if (created > 0 || existing > 0) {
    console.log('Siguiente paso recomendado: npm run clerk:reconcile');
  }
}

importCsv().catch((error) => {
  console.error(`❌ Error fatal: ${error.message}`);
  process.exit(1);
});
