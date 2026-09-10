// Consultas SQL del módulo de Banco Central.
//
// Cada función recibe un `executor` (el `pool` para queries sueltas o el
// `client` de una transacción). El control transaccional, las llamadas HTTP
// al Banco Central y la orquestación quedan en central-bank-service.js; acá
// solo vive el SQL. El texto se mantiene verbatim respecto del original.

const ACCOUNT_SYNC_COLUMNS = `
       c.id,
       c.persona_id,
       c.tipo_cuenta_id,
       c.numero_cuenta,
       c.cbu,
       c.alias,
       c.saldo,
       c.activa,
       c.banco_central_registrada,
       c.created_at,
       p.nombre,
       p.apellido,
       p.dni,
       p.email,
       tc.nombre AS tipo_cuenta_nombre`;

/** Cuenta + persona + tipo (vista de sincronización) por id de cuenta. */
function seleccionarCuentaASincronizarPorId(executor, idCuenta) {
  return executor.query(
    `SELECT${ACCOUNT_SYNC_COLUMNS}
     FROM cuentas c
     JOIN personas p ON p.id = c.persona_id
     JOIN tipos_cuenta tc ON tc.id = c.tipo_cuenta_id
     WHERE c.id = $1
     LIMIT 1`,
    [idCuenta]
  );
}

/** Listado de cuentas para sincronizar (más recientes primero). */
function seleccionarCuentasASincronizar(executor, safeLimit) {
  return executor.query(
    `SELECT${ACCOUNT_SYNC_COLUMNS}
     FROM cuentas c
     JOIN personas p ON p.id = c.persona_id
     JOIN tipos_cuenta tc ON tc.id = c.tipo_cuenta_id
     ORDER BY c.created_at DESC
     LIMIT $1`,
    [safeLimit]
  );
}

/** Renombra el registro local del banco para un entorno. */
function updateBankRegistryName(executor, name, environment) {
  return executor.query(
    `UPDATE banco_central_registro
     SET nombre = $1
     WHERE environment = $2
     RETURNING *`,
    [name, environment]
  );
}

/** Registro local más reciente del banco para un entorno. */
function selectLatestRegistration(executor, environment) {
  return executor.query(
    `SELECT *
     FROM banco_central_registro
     WHERE environment = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [environment]
  );
}

/** Persona por DNI. */
function selectPersonaByDni(executor, dni) {
  return executor.query(
    `SELECT *
       FROM personas
       WHERE dni = $1
       LIMIT 1`,
    [dni]
  );
}

/** Actualiza identidad de una persona (preserva email/teléfono si faltan). */
function updatePersonaIdentity(executor, { nombre, apellido, email, telefono, id }) {
  return executor.query(
    `UPDATE personas
           SET nombre = $1,
               apellido = $2,
               email = COALESCE($3, email),
               telefono = COALESCE($4, telefono)
           WHERE id = $5
           RETURNING *`,
    [nombre, apellido, email, telefono, id]
  );
}

/** Crea una persona incompleta a partir de datos del Banco Central. */
function insertPersonaFromCentral(executor, { nombre, apellido, dni, email, telefono }) {
  return executor.query(
    `INSERT INTO personas (
             nombre,
             apellido,
             dni,
             email,
             telefono,
             perfil_completo
           ) VALUES ($1, $2, $3, $4, $5, false)
           RETURNING *`,
    [nombre, apellido, dni, email, telefono]
  );
}

/** id del rol "cliente". */
function selectClienteRoleId(executor) {
  return executor.query(
    `SELECT id
       FROM roles
       WHERE LOWER(nombre) = 'cliente'
       LIMIT 1`
  );
}

/** Asigna un rol a una persona (idempotente). */
function insertarRolDePersona(executor, personaId, rolId) {
  return executor.query(
    `INSERT INTO personas_roles (persona_id, rol_id)
         VALUES ($1, $2)
         ON CONFLICT (persona_id, rol_id) DO NOTHING`,
    [personaId, rolId]
  );
}

/** id del tipo de cuenta por nombre (el más antiguo si hay varios). */
function seleccionarTipoDeCuentaPorNombre(executor, nombre) {
  return executor.query(
    `SELECT id
       FROM tipos_cuenta
       WHERE nombre = $1
       ORDER BY id ASC
       LIMIT 1`,
    [nombre]
  );
}

/** Dueño (id, persona_id) de la cuenta con cierto CBU. */
function seleccionarTitularDeCuentaPorCbu(executor, cbu) {
  return executor.query(
    `SELECT id, persona_id
       FROM cuentas
       WHERE cbu = $1
       LIMIT 1`,
    [cbu]
  );
}

/** Cuenta completa por id. */
function seleccionarCuentaPorId(executor, id) {
  return executor.query(
    `SELECT *
         FROM cuentas
         WHERE id = $1
         LIMIT 1`,
    [id]
  );
}

/** Primera cuenta (más antigua) de una persona. */
function seleccionarPrimeraCuentaDePersona(executor, personaId) {
  return executor.query(
    `SELECT *
         FROM cuentas
         WHERE persona_id = $1
         ORDER BY created_at ASC
         LIMIT 1`,
    [personaId]
  );
}

/** Vincula una cuenta existente al Banco Central (CBU + alias). */
function vincularCuentaConCentral(executor, { cbu, alias, id }) {
  return executor.query(
    `UPDATE cuentas
           SET cbu = $1,
               alias = COALESCE($2, alias),
               activa = TRUE,
               banco_central_registrada = TRUE
           WHERE id = $3
           RETURNING *`,
    [cbu, alias, id]
  );
}

/** Crea una cuenta local ya sincronizada con el Banco Central. */
function insertarCuentaDesdeCentral(executor, { personaId, tipoCuentaId, numeroCuenta, cbu, alias }) {
  return executor.query(
    `INSERT INTO cuentas (
                 persona_id,
                 tipo_cuenta_id,
                 numero_cuenta,
                 cbu,
                 alias,
                 saldo,
                 activa,
                 banco_central_registrada
               ) VALUES ($1, $2, $3, $4, $5, 0, TRUE, TRUE)
               RETURNING *`,
    [personaId, tipoCuentaId, numeroCuenta, cbu, alias]
  );
}

/** Actualiza el alias local de una cuenta por CBU. */
function actualizarAliasDeCuenta(executor, alias, cbu) {
  return executor.query('UPDATE cuentas SET alias = $1 WHERE cbu = $2', [alias, cbu]);
}

/** Persiste el resultado de sincronizar una cuenta (CBU + alias asignado). */
function resultadoSincronizacionCuenta(executor, { cbu, alias, idCuenta }) {
  return executor.query(
    `UPDATE cuentas
     SET cbu = $1,
         alias = COALESCE($2, alias),
         banco_central_registrada = TRUE
     WHERE id = $3
     RETURNING *`,
    [cbu, alias, idCuenta]
  );
}

/** Cuentas activas que matcheen alguno de los CBUs dados. */
function seleccionarCuentasActivasPorCbus(executor, cbus) {
  return executor.query(
    'SELECT id, cbu FROM cuentas WHERE cbu = ANY($1::text[]) AND activa = TRUE',
    [cbus]
  );
}

/** Todas las cuentas activas con CBU. */
function seleccionarCuentasActivasConCbu(executor) {
  return executor.query('SELECT id, cbu FROM cuentas WHERE cbu IS NOT NULL AND activa = TRUE');
}

/** IDs de transacciones entrantes ya registradas (para deduplicar). */
function selectExistingIncomingTxIds(executor, candidateIds) {
  return executor.query(
    'SELECT central_transaction_id FROM transacciones WHERE central_transaction_id = ANY($1) AND canal = $2',
    [candidateIds, 'interbancaria_entrante']
  );
}

/** id del tipo "transferencia". */
function seleccionarIdTipoTransferencia(executor) {
  return executor.query(
    "SELECT id FROM tipos_transaccion WHERE LOWER(nombre) = 'transferencia' LIMIT 1"
  );
}

/** Acredita `amount` al saldo de una cuenta. */
function acreditarEnCuenta(executor, amount, idCuenta) {
  return executor.query('UPDATE cuentas SET saldo = saldo + $1 WHERE id = $2', [amount, idCuenta]);
}

/** Registra una transferencia entrante interbancaria acreditada. */
function insertarTransaccionEntrante(executor, { typeId, idCuentaDestino, importe, txId, cbuOrigen, cbuDestino, senderName }) {
  return executor.query(
    `INSERT INTO transacciones (
           tipo_transaccion_id,
           cuenta_destino_id,
           monto,
           estado,
           central_transaction_id,
           canal,
           cbu_origen,
           cbu_destino,
           descripcion
         ) VALUES ($1, $2, $3, 'completada', $4, 'interbancaria_entrante', $5, $6, $7)`,
    [typeId, idCuentaDestino, importe, txId, cbuOrigen, cbuDestino, senderName]
  );
}

/** Upsert del registro local del banco (por bank_id + environment). */
function upsertBankRegistration(executor, { bankId, bankCode, name, environment }) {
  return executor.query(
    `INSERT INTO banco_central_registro (bank_id, bank_code, nombre, environment)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (bank_id, environment)
     DO UPDATE SET
       bank_code = EXCLUDED.bank_code,
       nombre = EXCLUDED.nombre
     RETURNING *`,
    [bankId, bankCode, name, environment]
  );
}

module.exports = {
  seleccionarCuentaASincronizarPorId,
  seleccionarCuentasASincronizar,
  updateBankRegistryName,
  selectLatestRegistration,
  selectPersonaByDni,
  updatePersonaIdentity,
  insertPersonaFromCentral,
  selectClienteRoleId,
  insertarRolDePersona,
  seleccionarTipoDeCuentaPorNombre,
  seleccionarTitularDeCuentaPorCbu,
  seleccionarCuentaPorId,
  seleccionarPrimeraCuentaDePersona,
  vincularCuentaConCentral,
  insertarCuentaDesdeCentral,
  actualizarAliasDeCuenta,
  resultadoSincronizacionCuenta,
  seleccionarCuentasActivasPorCbus,
  seleccionarCuentasActivasConCbu,
  selectExistingIncomingTxIds,
  seleccionarIdTipoTransferencia,
  acreditarEnCuenta,
  insertarTransaccionEntrante,
  upsertBankRegistration,
};
