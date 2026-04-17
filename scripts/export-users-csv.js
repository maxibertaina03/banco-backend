#!/usr/bin/env node

/**
 * Exporta usuarios de BD a CSV compatible con Clerk import
 */

require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error('❌ Error: Falta DATABASE_URL en .env');
  process.exit(1);
}

const pool = new Pool({ connectionString: databaseUrl });

async function exportUsers() {
  try {
    console.log('\n📤 Exportando usuarios para Clerk...\n');

    const result = await pool.query(`
      SELECT 
        email,
        SPLIT_PART(nombre, ' ', 1) as first_name,
        apellido as last_name,
        LOWER(CONCAT(nombre, '.', apellido)) as username,
        telefono
      FROM personas
      ORDER BY created_at
    `);

    if (result.rows.length === 0) {
      console.log('❌ No hay usuarios para exportar');
      await pool.end();
      process.exit(1);
    }

    // Crear CSV
    const csvContent = [
      // Header
      'email_address,first_name,last_name,username,phone_number',
      // Filas
      ...result.rows.map(row => 
        `"${row.email}","${row.first_name}","${row.last_name}","${row.username}","${row.telefono || ''}"`
      )
    ].join('\n');

    // Guardar archivo
    const filePath = path.join(__dirname, '..', 'usuarios-para-clerk.csv');
    fs.writeFileSync(filePath, csvContent, 'utf-8');

    console.log(`✅ Archivo creado: usuarios-para-clerk.csv`);
    console.log(`📊 Total de usuarios: ${result.rows.length}\n`);
    console.log('Preview (primeros 3):');
    console.log(csvContent.split('\n').slice(0, 4).join('\n'));
    console.log('\n📋 Pasos siguientes:');
    console.log('1. Ve a tu Clerk Dashboard → Users');
    console.log('2. Haz clic en botón "Migrate existing users" o "Import users"');
    console.log('3. Sube el archivo: usuarios-para-clerk.csv');
    console.log('4. ¡Listo! Todos tus usuarios estarán en Clerk\n');

    await pool.end();
  } catch (error) {
    console.error('❌ Error:', error.message);
    await pool.end();
    process.exit(1);
  }
}

exportUsers();
