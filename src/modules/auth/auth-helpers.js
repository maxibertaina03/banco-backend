// Helpers puros de autenticación: normalización de datos que llegan desde
// Clerk y mapeo de errores. No tocan la BD ni la red, así que son triviales
// de testear y reutilizar.

const HttpError = require('../../utils/http-error');

/** Devuelve el email primario (o el primero disponible) en lowercase+trim. */
function getPrimaryEmail(clerkUser) {
  const addresses = clerkUser.email_addresses || [];
  const primaryId = clerkUser.primary_email_address_id;
  const primary =
    addresses.find((address) => address.id === primaryId) ||
    addresses.find((address) => address.email_address);
  return primary?.email_address?.trim().toLowerCase() || null;
}

/** Trim de un texto opcional; cadena vacía → null. */
function normalizeOptionalText(value) {
  const trimmed = value?.trim();
  return trimmed || null;
}

/** Primer teléfono disponible de la lista de Clerk, o null. */
function normalizePhone(phoneNumbers = []) {
  const phone = phoneNumbers.find((item) => item.phone_number)?.phone_number || null;
  return phone;
}

/**
 * Traduce errores de aprovisionamiento a HttpError. Un 23505 (unique
 * violation) se mapea a 409; el resto se propaga tal cual.
 */
function mapProvisionError(error) {
  if (error instanceof HttpError) return error;
  if (error.code === '23505') {
    return new HttpError(409, 'No se pudo aprovisionar automáticamente el usuario por un conflicto de datos.');
  }
  return error;
}

module.exports = {
  getPrimaryEmail,
  normalizeOptionalText,
  normalizePhone,
  mapProvisionError,
};
