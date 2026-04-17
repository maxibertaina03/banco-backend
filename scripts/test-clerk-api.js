#!/usr/bin/env node

/**
 * Script de prueba para verificar conectividad con Clerk API
 */

require('dotenv').config();
const axios = require('axios');

const clerkSecretKey = process.env.CLERK_SECRET_KEY;

if (!clerkSecretKey) {
  console.error('❌ Error: Falta CLERK_SECRET_KEY en .env');
  process.exit(1);
}

console.log('🧪 Probando Clerk API...\n');
console.log(`📝 Secret Key: ${clerkSecretKey.substring(0, 20)}...`);
console.log('---\n');

/**
 * Test 1: Listar usuarios
 */
async function testListUsers() {
  try {
    console.log('📋 Test 1: Listar usuarios');
    const response = await axios.get('https://api.clerk.com/v1/users', {
      headers: {
        'Authorization': `Bearer ${clerkSecretKey}`,
      },
    });
    console.log(`✅ Success: ${response.data.length} usuarios encontrados\n`);
  } catch (error) {
    console.error(`❌ Error: ${error.response?.status} - ${error.message}\n`);
  }
}

/**
 * Test 2: Crear usuario (minimalista)
 */
async function testCreateUserMinimal() {
  try {
    console.log('👤 Test 2: Crear usuario (formato minimal)');
    const data = {
      email_address: 'testminimal@orbitalbank.test',
      username: 'testminimal',
      password: 'TestPass2026ABC',
    };
    
    console.log('   Payload:', JSON.stringify(data, null, 2));
    
    const response = await axios.post('https://api.clerk.com/v1/users', data, {
      headers: {
        'Authorization': `Bearer ${clerkSecretKey}`,
        'Content-Type': 'application/json',
      },
    });
    
    console.log(`✅ Success: Usuario creado - ${response.data.id}\n`);
    return response.data.id;
  } catch (error) {
    console.error(`❌ Error: ${error.response?.status}`);
    console.error('   Response:', JSON.stringify(error.response?.data, null, 2));
    console.error('');
  }
}

/**
 * Test 3: Crear usuario (con todos los campos)
 */
async function testCreateUserFull() {
  try {
    console.log('👤 Test 3: Crear usuario (con todos los campos)');
    const data = {
      email_address: 'testfull@orbitalbank.test',
      first_name: 'Test',
      last_name: 'Full',
      username: 'testfull',
      password: 'TestPass2026DEF',
      phone_number: '+549112345678',
    };
    
    console.log('   Payload:', JSON.stringify(data, null, 2));
    
    const response = await axios.post('https://api.clerk.com/v1/users', data, {
      headers: {
        'Authorization': `Bearer ${clerkSecretKey}`,
        'Content-Type': 'application/json',
      },
    });
    
    console.log(`✅ Success: Usuario creado - ${response.data.id}\n`);
    return response.data.id;
  } catch (error) {
    console.error(`❌ Error: ${error.response?.status}`);
    console.error('   Response:', JSON.stringify(error.response?.data, null, 2));
    console.error('');
  }
}

/**
 * Main
 */
async function main() {
  await testListUsers();
  await testCreateUserMinimal();
  await testCreateUserFull();
}

main();
