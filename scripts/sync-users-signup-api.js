#!/usr/bin/env node

/**
 * Script para sincronizar usuarios usando SignUp API en lugar de Users API
 * SignUp API es más flexible para crear usuarios
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
    'Authorization': `Bearer ${clerkSecretKey}`,
    'Content-Type': 'application/json',
  },
});

/**
 * Crea SignUp (alternativa a Users API)
 */
async function createSignUp(email, firstName, lastName, phoneNumber) {
  try {
    // SignUp API es para crear nuevas señalas de registro, no usuarios directos
    // Pero podemos usar el endpoint de /sign_ups para iniciar un proceso
    const data = {
      email_address: email,
      first_name: firstName,
      last_name: lastName,
    };
    
    const response = await clerkApi.post('/sign_ups', data);
    console.log(`  ✅ SignUp creado: ${response.data.id}`);
    return response.data;
  } catch (error) {
    if (error.response?.data?.errors) {
      const err = error.response.data.errors[0];
      console.log(`  ⚠️  Error SignUp: ${err.code} - ${err.message}`);
    }
    throw error;
  }
}

/**
 * Registra usuario en BD local
 */
async function registerUserLocally(personaId, clerkId) {
  try {
    const checkQuery = 'SELECT * FROM usuarios WHERE persona_id = $1';
    const checkResult = await pool.query(checkQuery, [personaId]);

    if (checkResult.rowCount > 0) {
      const updateQuery = 'UPDATE usuarios SET clerk_id = $1, activo = true WHERE persona_id = $2 RETURNING *';
      const result = await pool.query(updateQuery, [clerkId, personaId]);
      return { ...result.rows[0], isNew: false };
    }

    const insertQuery = `
      INSERT INTO usuarios (persona_id, clerk_id, activo)
      VALUES ($1, $2, true)
      RETURNING *
    `;
    
    const result = await pool.query(insertQuery, [personaId, clerkId]);
    return { ...result.rows[0], isNew: true };
  } catch (error) {
    console.error(`    DB Error: ${error.message}`);
    throw error;
  }
}

/**
 * Main
 */
async function syncUsers() {
  try {
    console.log('\n🔄 Iniciando sincronización usando SignUp API...\n');

    // Obtener personas
    const personasResult = await pool.query(`
      SELECT id, nombre, apellido, email, telefono FROM personas
      ORDER BY created_at
      LIMIT 5
    `);

    const personas = personasResult.rows;
    console.log(`📋 Probando con ${personas.length} personas\n`);

    let created = 0;
    let failed = 0;

    for (const { id, nombre, apellido, email, telefono } of personas) {
      console.log(`[${created + failed + 1}/${personas.length}] ${email}`);
      
      try {
        const signUp = await createSignUp(email, nombre, apellido, telefono);
        
        // Registrar en BD con el SignUp ID
        const result = await registerUserLocally(id, signUp.id);
        created++;
        console.log(`  ✅ Registrado en BD\n`);
      } catch (error) {
        console.log(`  ❌ ${error.message}\n`);
        failed++;
      }
    }

    console.log('═══════════════════════════════════');
    console.log('📊 RESUMEN');
    console.log(`✅ Creados: ${created}`);
    console.log(`❌ Errores: ${failed}`);
    console.log('═══════════════════════════════════\n');

    await pool.end();
  } catch (error) {
    console.error('❌ Error fatal:', error.message);
    await pool.end();
    process.exit(1);
  }
}

syncUsers();
