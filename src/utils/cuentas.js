function normalizarMonedaDeCuenta(currency) {
  const normalized = String(currency ?? '').trim().toUpperCase();

  if (normalized === 'ARS' || normalized === 'USD') {
    return normalized;
  }

  throw new Error(`Unsupported currency: ${currency}`);
}

function generarNumeroDeCuenta(currency) {
  const normalized = normalizarMonedaDeCuenta(currency);
  const randomPart = Math.floor(Math.random() * 90_000_000_000 + 10_000_000_000)
    .toString()
    .padStart(12, '0');

  return normalized === 'USD' ? `90${randomPart.slice(2)}` : `11${randomPart.slice(2)}`;
}

function generarCbu(currency) {
  const normalized = normalizarMonedaDeCuenta(currency);
  const base = normalized === 'USD' ? '001' : '011';
  const randomDigits = Array.from({ length: 17 }, () => Math.floor(Math.random() * 10)).join('');
  return `${base}${randomDigits}`.slice(0, 22).padEnd(22, '0');
}

module.exports = {
  generarCbu,
  generarNumeroDeCuenta,
  normalizarMonedaDeCuenta,
};
