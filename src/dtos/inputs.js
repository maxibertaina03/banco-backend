// Input DTOs: normalizan el payload validado por Zod antes de tocar la BD.
// Devuelven solo claves presentes en el input (no introducen undefined),
// para que `buildInsertQuery` / `buildUpdateQuery` sigan funcionando sobre
// el set parcial enviado por el cliente.

function pick(source, keys) {
  const result = {};
  for (const key of keys) {
    if (source[key] !== undefined) {
      result[key] = source[key];
    }
  }
  return result;
}

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : value;
}

function normalizeAlias(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// ── Personas ─────────────────────────────────────────────────────────────────
const personaFields = [
  'nombre',
  'apellido',
  'dni',
  'email',
  'telefono',
  'fecha_nacimiento',
  'perfil_completo',
];

function normalizePersonaInput(body) {
  const picked = pick(body, personaFields);
  if (picked.email !== undefined) picked.email = normalizeEmail(picked.email);
  return picked;
}

// ── Cuentas ──────────────────────────────────────────────────────────────────
const cuentaFields = [
  'persona_id',
  'tipo_cuenta_id',
  'numero_cuenta',
  'cbu',
  'alias',
  'saldo',
  'activa',
  'banco_central_registrada',
];

function normalizeCuentaInput(body) {
  const picked = pick(body, cuentaFields);
  if (picked.alias !== undefined) picked.alias = normalizeAlias(picked.alias);
  return picked;
}

// ── Destinatarios ────────────────────────────────────────────────────────────
const destinatarioFields = ['persona_id', 'alias', 'cbu_externo', 'banco_externo'];

function normalizeDestinatarioInput(body) {
  const picked = pick(body, destinatarioFields);
  if (picked.alias !== undefined) picked.alias = normalizeAlias(picked.alias);
  return picked;
}

// ── Usuarios ─────────────────────────────────────────────────────────────────
const usuarioFields = ['persona_id', 'clerk_id', 'activo'];
function normalizeUsuarioInput(body) {
  return pick(body, usuarioFields);
}

// ── Roles / tipos ────────────────────────────────────────────────────────────
const rolFields = ['nombre', 'descripcion'];
function normalizeRolInput(body) {
  return pick(body, rolFields);
}

const tipoCuentaFields = ['nombre', 'descripcion', 'limite_transferencia'];
function normalizeTipoCuentaInput(body) {
  return pick(body, tipoCuentaFields);
}

const tipoTransaccionFields = ['nombre', 'descripcion'];
function normalizeTipoTransaccionInput(body) {
  return pick(body, tipoTransaccionFields);
}

const personaRolFields = ['persona_id', 'rol_id'];
function normalizePersonaRolInput(body) {
  return pick(body, personaRolFields);
}

module.exports = {
  normalizePersonaInput,
  normalizeCuentaInput,
  normalizeDestinatarioInput,
  normalizeUsuarioInput,
  normalizeRolInput,
  normalizeTipoCuentaInput,
  normalizeTipoTransaccionInput,
  normalizePersonaRolInput,
};
