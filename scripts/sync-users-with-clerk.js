#!/usr/bin/env node

/**
 * Script para sincronizar usuarios de la BD con Clerk
 * Lee personas de PostgreSQL y las crea en Clerk
 * Luego actualiza la tabla usuarios con los Clerk IDs
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
 * Crea un usuario en Clerk
 */
async function createClerkUser(email, firstName, lastName, phoneNumber, dni) {
  try {
    // Generar username a partir del email o nombre
    const username = email.split('@')[0] || `${firstName}.${lastName}`.toLowerCase();
    
    // Generar password temporal segura
    const tempPassword = `Temp${Math.random().toString(36).substring(2, 8)}@2026`;
    
    // Formatear teléfono (asegurar que sea válido)
    const phone = phoneNumber || '+54 9 11 1234 5678';
    
    const userData = {
      email_address: [email],
      first_name: firstName,
      last_name: lastName,
      username: username,
      password: tempPassword,
      phone_number: phone,
    };
    
    console.log(`  📤 Enviando a Clerk: ${email}`);
    const response = await clerkApi.post('/users', userData);
    console.log(`  ✅ Creado en Clerk: ${response.data.id}`);
    return response.data.id;
  } catch (error) {
    // Mostrar detalles del error
    if (error.response?.data?.errors) {
      const errors = error.response.data.errors.map(e => `${e.code}: ${e.message}`).join(', ');
      console.log(`  ⚠️  Error de Clerk: ${errors}`);
      throw new Error(`Clerk error: ${errors}`);
    }
    throw error;
  }
}

/**
 * Registra un usuario en la BD local
 */
async function registerUserLocally(personaId, clerkId) {
  // Primero verificar si ya existe
  const checkQuery = 'SELECT * FROM usuarios WHERE persona_id = $1';
  const checkResult = await pool.query(checkQuery, [personaId]);

  if (checkResult.rowCount > 0) {
    // Usuario ya existe, actualizar clerk_id
    const updateQuery = 'UPDATE usuarios SET clerk_id = $1 WHERE persona_id = $2 RETURNING *';
    const result = await pool.query(updateQuery, [clerkId, personaId]);
    return { ...result.rows[0], isNew: false };
  }

  // Crear nuevo usuario
  const insertQuery = `
    INSERT INTO usuarios (persona_id, clerk_id, activo)
    VALUES ($1, $2, true)
    RETURNING *
  `;
  
  const result = await pool.query(insertQuery, [personaId, clerkId]);
  return { ...result.rows[0], isNew: true };
}

/**
 * Main: Sincronizar todos los usuarios
 */
async function syncUsers() {
  try {
    console.log('🔄 Iniciando sincronización de usuarios...\n');

    // 1. Obtener todas las personas
    const personasResult = await pool.query(`
      SELECT id, nombre, apellido, email, telefono, dni FROM personas
      ORDER BY created_at
    `);

    const personas = personasResult.rows;
    console.log(`📋 Se encontraron ${personas.length} personas en la BD\n`);

    if (personas.length === 0) {
      console.log('✅ No hay personas para sincronizar');
      await pool.end();
      process.exit(0);
    }

    let created = 0;
    let updated = 0;
    let failed = 0;

    // 2. Para cada persona, crear en Clerk y registrar en BD
    for (const persona of personas) {
      const { id: personaId, nombre, apellido, email, telefono, dni } = persona;

      console.log(`[${created + updated + failed + 1}/${personas.length}] ${email}`);

      try {
        // Crear en Clerk
        const clerkId = await createClerkUser(email, nombre, apellido, telefono, dni);

        if (!clerkId) {
          console.log(`  ❌ No se pudo crear/obtener usuario en Clerk\n`);
          failed++;
          continue;
        }

        // Registrar en BD local
        const registerResult = await registerUserLocally(personaId, clerkId);
        if (registerResult.isNew) {
          console.log(`  ✅ Creado: ${clerkId}\n`);
          created++;
        } else {
          console.log(`  ✅ Actualizado: ${clerkId}\n`);
          updated++;
        }
      } catch (error) {
        console.error(`  ❌ Error: ${error.message}\n`);
        failed++;
      }
    }

    // 3. Resumen
    console.log('═══════════════════════════════════');
    console.log('📊 RESUMEN');
    console.log('═══════════════════════════════════');
    console.log(`✅ Usuarios creados: ${created}`);
    console.log(`⚠️  Usuarios existentes: ${updated}`);
    console.log(`❌ Usuarios con error: ${failed}`);
    console.log('═══════════════════════════════════\n');

    if (failed === 0) {
      console.log('🎉 ¡Sincronización completada exitosamente!');
    } else {
      console.log('⚠️  Sincronización completada con algunos errores');
    }

    await pool.end();
    process.exit(0);
  } catch (error) {
    console.error('❌ Error fatal:', error.message);
    await pool.end();
    process.exit(1);
  }
}

// Ejecutar
syncUsers();
