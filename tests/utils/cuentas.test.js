const test = require('node:test');
const assert = require('node:assert/strict');

const { generarCbu, generarNumeroDeCuenta, normalizarMonedaDeCuenta } = require('../../src/utils/cuentas');

test('normalizarMonedaDeCuenta accepts supported currencies only', () => {
  assert.equal(normalizarMonedaDeCuenta('ars'), 'ARS');
  assert.equal(normalizarMonedaDeCuenta('USD'), 'USD');
  assert.throws(() => normalizarMonedaDeCuenta('EUR'), /Unsupported currency/i);
});

test('generarNumeroDeCuenta y generarCbu crean valores distintos por moneda', () => {
  const arsAccountNumber = generarNumeroDeCuenta('ARS');
  const usdAccountNumber = generarNumeroDeCuenta('USD');
  const arsCbu = generarCbu('ARS');
  const usdCbu = generarCbu('USD');

  assert.match(arsAccountNumber, /^\d{12}$/);
  assert.match(usdAccountNumber, /^\d{12}$/);
  assert.notEqual(arsAccountNumber, usdAccountNumber);
  assert.match(arsCbu, /^\d{22}$/);
  assert.match(usdCbu, /^\d{22}$/);
  assert.notEqual(arsCbu, usdCbu);
});
