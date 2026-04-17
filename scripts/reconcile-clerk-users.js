#!/usr/bin/env node

/**
 * Vincula usuarios ya existentes en Clerk con la tabla local `usuarios`
 * usando el email como clave de reconciliación.
 */

require('dotenv').config();
const { Pool } = require('pg');
const axios = require('axios');

const clerkSecretKey = process.env.CLERK_SECRET_KEY;
const databaseUrl = process.env.DATABASE_URL;

if (!clerkSecretKey || !databaseUrl) {
  console.error('❌ Error: Falta CLERK_SECRET_KEY o DATABASE_URL en .env');
  process.exit(1);
}

const pool = new Pool({ connectionString: databaseUrl });
const clerkApi = axios.create({
  baseURL: 'https://api.clerk.com/v1',
  headers: {
    Authorization: `Bearer ${clerkSecretKey}`,
    'Content-Type': 'application/json',
  },
});

async function fetchAllClerkUsers() {
  const users = [];
  const limit = 100;
  let offset = 0;

  while (true) {
    const response = await clerkApi.get('/users', {
      params: { limit, offset },
    });

    const batch = Array.isArray(response.data) ? response.data : [];
    users.push(...batch);

    if (batch.length < limit) break;
    offset += limit;
  }

  return users;
}

function getPrimaryEmail(user) {
  if (!Array.isArray(user.email_addresses)) return null;

  const primary =
    user.email_addresses.find((email) => email.id === user.primary_email_address_id) ||
    user.email_addresses[0];

  return primary?.email_address?.trim().toLowerCase() || null;
}

async function upsertLocalUser(personaId, clerkId) {
  const existing = await pool.query('SELECT * FROM usuarios WHERE persona_id = $1', [personaId]);

  if (existing.rowCount > 0) {
    const result = await pool.query(
      `UPDATE usuarios
       SET clerk_id = $1,
           activo = true
       WHERE persona_id = $2
       RETURNING *`,
      [clerkId, personaId]
    );

    return { action: 'updated', row: result.rows[0] };
  }

  const result = await pool.query(
    `INSERT INTO usuarios (persona_id, clerk_id, activo)
     VALUES ($1, $2, true)
     RETURNING *`,
    [personaId, clerkId]
  );

  return { action: 'created', row: result.rows[0] };
}

async function reconcileUsers() {
  try {
    console.log('\n🔄 Reconciliando usuarios de Clerk con PostgreSQL...\n');

    const [personasResult, clerkUsers] = await Promise.all([
      pool.query('SELECT id, email FROM personas ORDER BY created_at'),
      fetchAllClerkUsers(),
    ]);

    const personasByEmail = new Map(
      personasResult.rows.map((persona) => [persona.email.trim().toLowerCase(), persona])
    );

    console.log(`📋 Personas en BD: ${personasResult.rowCount}`);
    console.log(`👤 Usuarios en Clerk: ${clerkUsers.length}\n`);

    let created = 0;
    let updated = 0;
    let skipped = 0;
    let unmatched = 0;

    for (const clerkUser of clerkUsers) {
      const email = getPrimaryEmail(clerkUser);

      if (!email) {
        console.log(`⚠️  Usuario ${clerkUser.id} sin email principal, se omite`);
        skipped++;
        continue;
      }

      const persona = personasByEmail.get(email);
      if (!persona) {
        console.log(`⚠️  Sin coincidencia local para ${email}`);
        unmatched++;
        continue;
      }

      const result = await upsertLocalUser(persona.id, clerkUser.id);
      console.log(`✅ ${email} -> ${clerkUser.id} (${result.action})`);

      if (result.action === 'created') {
        created++;
      } else {
        updated++;
      }
    }

    console.log('\n═══════════════════════════════════');
    console.log('📊 RESUMEN');
    console.log('═══════════════════════════════════');
    console.log(`✅ Usuarios creados localmente: ${created}`);
    console.log(`♻️  Usuarios actualizados localmente: ${updated}`);
    console.log(`⏭️  Usuarios omitidos: ${skipped}`);
    console.log(`❓ Usuarios sin match por email: ${unmatched}`);
    console.log('═══════════════════════════════════\n');
  } catch (error) {
    const details = error.response?.data?.errors
      ? JSON.stringify(error.response.data.errors)
      : error.message;
    console.error(`❌ Error: ${details}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

reconcileUsers();
