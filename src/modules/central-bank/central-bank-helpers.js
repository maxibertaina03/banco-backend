// Helpers puros del módulo de Banco Central.
//
// Nada acá toca la BD ni la red: son funciones de normalización de texto,
// generación de alias/números de cuenta y extracción de campos desde los
// payloads (anidados e inconsistentes) que devuelve el Banco Central. Al estar
// aisladas son fáciles de testear y se reutilizan desde el service.

const MIN_ALIAS_LENGTH = 6;
const MAX_ALIAS_LENGTH = 20;

/** Número de cuenta local de 12 dígitos derivado de persona + timestamp. */
function generateLocalAccountNumber(personaId) {
  const personaDigits = String(personaId || '').replace(/\D+/g, '').slice(-6).padStart(6, '0');
  const timestampDigits = Date.now().toString().slice(-6);
  return `${personaDigits}${timestampDigits}`.slice(0, 12);
}

/** Normaliza texto para el Banco Central (sin acentos ni símbolos raros). */
function sanitizeCentralText(value) {
  if (!value) {
    return null;
  }

  const normalized = String(value)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9\s'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return normalized || null;
}

/** Deja solo los dígitos de un DNI. */
function sanitizeDni(value) {
  if (!value) {
    return null;
  }

  const digits = String(value).replace(/\D+/g, '');
  return digits || null;
}

/** Limpia un alias a formato `a.b-c` (minúsculas, sin acentos). */
function cleanAliasText(value) {
  if (!value) {
    return null;
  }

  const normalized = value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '.')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.-]+|[.-]+$/g, '');

  return normalized || null;
}

/** Recorta un alias al largo máximo y lo descarta si queda muy corto. */
function normalizeAliasValue(value) {
  const normalized = cleanAliasText(value)?.slice(0, MAX_ALIAS_LENGTH) || null;

  if (!normalized || normalized.length < MIN_ALIAS_LENGTH) {
    return null;
  }

  return normalized;
}

/** Construye un alias candidato uniendo partes con puntos. */
function createAliasVariant(parts) {
  const normalizedParts = parts
    .map((part) => cleanAliasText(String(part || '').replace(/\./g, '')))
    .filter(Boolean);

  if (normalizedParts.length === 0) {
    return null;
  }

  return normalizeAliasValue(normalizedParts.join('.'));
}

/** Lista ordenada y sin repetidos de alias candidatos para una cuenta. */
function buildAliasCandidates(account, bankName) {
  const suffix = account.numero_cuenta?.slice(-4) || account.cbu?.slice(-4) || '0001';
  const bankSlug = normalizeAliasValue(bankName || 'orbital') || 'orbital';

  const candidates = [
    normalizeAliasValue(account.alias),
    createAliasVariant([account.nombre, account.apellido]),
    createAliasVariant([account.nombre, suffix]),
    createAliasVariant([account.nombre, account.apellido, suffix]),
    createAliasVariant([account.nombre, bankSlug]),
    createAliasVariant([account.nombre, suffix, bankSlug]),
  ].filter(Boolean);

  return Array.from(new Set(candidates));
}

/** Primer `cbu` string encontrado recorriendo el payload anidado. */
function extractCentralCbu(payload) {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const queue = [payload];

  while (queue.length > 0) {
    const current = queue.shift();

    if (!current || typeof current !== 'object') {
      continue;
    }

    if (typeof current.cbu === 'string' && current.cbu.trim()) {
      return current.cbu.trim();
    }

    for (const value of Object.values(current)) {
      if (value && typeof value === 'object') {
        queue.push(value);
      }
    }
  }

  return null;
}

/** Primer id de transacción encontrado (varias convenciones de nombre). */
function extractCentralTransactionId(payload) {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const queue = [payload];

  while (queue.length > 0) {
    const current = queue.shift();

    if (!current || typeof current !== 'object') {
      continue;
    }

    // API docs: POST /transactions returns "transaccionId" (Spanish spelling)
    // GET /transactions returns "_id"
    const candidates = [
      current.transaccionId,
      current.transactionId,
      current.transaction_id,
      current._id,
      current.transferId,
      current.transfer_id,
      current.id,
    ];

    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim()) {
        return candidate.trim();
      }
    }

    for (const value of Object.values(current)) {
      if (value && typeof value === 'object') {
        queue.push(value);
      }
    }
  }

  return null;
}

/** Primer `alias` string encontrado recorriendo el payload anidado. */
function extractCentralAlias(payload) {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const queue = [payload];

  while (queue.length > 0) {
    const current = queue.shift();

    if (!current || typeof current !== 'object') {
      continue;
    }

    if (typeof current.alias === 'string' && current.alias.trim()) {
      return current.alias.trim();
    }

    for (const value of Object.values(current)) {
      if (value && typeof value === 'object') {
        queue.push(value);
      }
    }
  }

  return null;
}

/** Razones por las que una cuenta NO está lista para sincronizar con Brocoly. */
function toSyncIssues(account) {
  const issues = [];
  const sanitizedNombre = sanitizeCentralText(account.nombre);
  const sanitizedApellido = sanitizeCentralText(account.apellido);
  const sanitizedDni = sanitizeDni(account.dni);

  if (!account.activa) {
    issues.push('La cuenta está inactiva.');
  }

  if (!sanitizedNombre || !sanitizedApellido) {
    issues.push('La persona asociada no tiene nombre y apellido completos.');
  }

  if (!sanitizedDni) {
    issues.push('La persona asociada no tiene DNI.');
  } else if (sanitizedDni.length < 7 || sanitizedDni.length > 8) {
    issues.push('El DNI debe tener 7 u 8 dígitos para sincronizar con Brocoly.');
  }

  return issues;
}

module.exports = {
  MIN_ALIAS_LENGTH,
  MAX_ALIAS_LENGTH,
  generateLocalAccountNumber,
  sanitizeCentralText,
  sanitizeDni,
  cleanAliasText,
  normalizeAliasValue,
  createAliasVariant,
  buildAliasCandidates,
  extractCentralCbu,
  extractCentralTransactionId,
  extractCentralAlias,
  toSyncIssues,
};
