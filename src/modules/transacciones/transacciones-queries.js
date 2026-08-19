// Consultas SQL de transacciones.
//
// Cada función recibe un `executor` (el `pool` o el `client` de una
// transacción). El SQL se mantiene verbatim respecto del original para no
// romper los tests que asertan sobre el texto de las queries. El control
// transaccional (BEGIN/COMMIT/ROLLBACK) y las validaciones viven en el service.

/** id del tipo "transferencia". */
function seleccionarIdTipoTransferencia(executor) {
  return executor.query(
    "SELECT id FROM tipos_transaccion WHERE lower(nombre) = 'transferencia' LIMIT 1"
  );
}

/** id del tipo "deposito". */
function seleccionarIdTipoDeposito(executor) {
  return executor.query(
    "SELECT id FROM tipos_transaccion WHERE lower(nombre) = 'deposito' LIMIT 1"
  );
}

/** Cuenta local + titular por id, con FOR UPDATE (bloquea la fila). */
function seleccionarCuentaPorIdParaActualizar(executor, idCuenta) {
  return executor.query(
    `SELECT c.*, p.nombre, p.apellido
       FROM cuentas c
       JOIN personas p ON p.id = c.persona_id
       WHERE c.id = $1
       FOR UPDATE`,
    [idCuenta]
  );
}

/** Cuenta local + titular por CBU, con FOR UPDATE (bloquea la fila). */
function seleccionarCuentaPorCbuParaActualizar(executor, cbu) {
  return executor.query(
    `SELECT c.*, p.nombre, p.apellido
       FROM cuentas c
       JOIN personas p ON p.id = c.persona_id
       WHERE c.cbu = $1
       FOR UPDATE`,
    [cbu]
  );
}

/** Límite de transferencia del tipo de cuenta. */
function seleccionarLimiteDeTransferencia(executor, tipoCuentaId) {
  return executor.query(
    'SELECT limite_transferencia FROM tipos_cuenta WHERE id = $1',
    [tipoCuentaId]
  );
}

/** Resta `amount` al saldo de la cuenta `idCuenta`. */
function debitarDeCuenta(executor, amount, idCuenta) {
  return executor.query('UPDATE cuentas SET saldo = saldo - $1 WHERE id = $2', [amount, idCuenta]);
}

/** Suma `amount` al saldo de la cuenta `idCuenta`. */
function acreditarEnCuenta(executor, amount, idCuenta) {
  return executor.query('UPDATE cuentas SET saldo = saldo + $1 WHERE id = $2', [amount, idCuenta]);
}

/** Inserta una transacción de transferencia (local o interbancaria). */
function insertarTransaccionDeTransferencia(executor, values) {
  return executor.query(
    `INSERT INTO transacciones (
        tipo_transaccion_id,
        cuenta_origen_id,
        cuenta_destino_id,
        monto,
        descripcion,
        estado,
        central_transaction_id,
        canal,
        cbu_origen,
        cbu_destino
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *`,
    values
  );
}

/** Inserta una transacción de depósito en efectivo (sin origen). */
function insertarTransaccionDeDeposito(executor, { idTipoDeposito, destinationId, amount, descripcion, destinationCbu }) {
  return executor.query(
    `INSERT INTO transacciones (
          tipo_transaccion_id,
          cuenta_origen_id,
          cuenta_destino_id,
          monto,
          descripcion,
          estado,
          canal,
          cbu_origen,
          cbu_destino
        ) VALUES ($1, NULL, $2, $3, $4, 'completada', 'deposito_efectivo', NULL, $5)
        RETURNING *`,
    [idTipoDeposito, destinationId, amount, descripcion, destinationCbu]
  );
}

/** Todas las transacciones (vista interna admin/operador). */
function selectAllTransactions(executor) {
  return executor.query('SELECT * FROM transacciones ORDER BY created_at DESC LIMIT 100');
}

/** Transacciones donde la persona participa como origen o destino. */
function seleccionarTransaccionesDePersona(executor, personaId) {
  return executor.query(
    `SELECT t.*
       FROM transacciones t
       JOIN cuentas origen ON origen.id = t.cuenta_origen_id
       LEFT JOIN cuentas destino ON destino.id = t.cuenta_destino_id
       WHERE origen.persona_id = $1 OR destino.persona_id = $1
       ORDER BY t.created_at DESC
       LIMIT 100`,
    [personaId]
  );
}

/** Una transacción por id (vista interna). */
function selectTransactionById(executor, id) {
  return executor.query('SELECT * FROM transacciones WHERE id = $1', [id]);
}

/** Una transacción por id, solo si la persona participa. */
function seleccionarTransaccionDePersonaPorId(executor, id, personaId) {
  return executor.query(
    `SELECT t.*
           FROM transacciones t
           JOIN cuentas origen ON origen.id = t.cuenta_origen_id
           LEFT JOIN cuentas destino ON destino.id = t.cuenta_destino_id
           WHERE t.id = $1 AND (origen.persona_id = $2 OR destino.persona_id = $2)`,
    [id, personaId]
  );
}

/** Destinatario por id, restringido a la persona salvo usuario interno. */
function selectDestinatario(executor, destinatarioId, isInternal, personaId) {
  return executor.query(
    `SELECT *
             FROM destinatarios
             WHERE id = $1
               AND ($2::boolean = TRUE OR persona_id = $3)
             LIMIT 1`,
    [destinatarioId, isInternal, personaId]
  );
}

/** CBUs activos de una persona (para sincronizar entrantes). */
function selectActiveCbusForPersona(executor, personaId) {
  return executor.query(
    'SELECT cbu FROM cuentas WHERE persona_id = $1 AND cbu IS NOT NULL AND activa = TRUE',
    [personaId]
  );
}

module.exports = {
  seleccionarIdTipoTransferencia,
  seleccionarIdTipoDeposito,
  seleccionarCuentaPorIdParaActualizar,
  seleccionarCuentaPorCbuParaActualizar,
  seleccionarLimiteDeTransferencia,
  debitarDeCuenta,
  acreditarEnCuenta,
  insertarTransaccionDeTransferencia,
  insertarTransaccionDeDeposito,
  selectAllTransactions,
  seleccionarTransaccionesDePersona,
  selectTransactionById,
  seleccionarTransaccionDePersonaPorId,
  selectDestinatario,
  selectActiveCbusForPersona,
};
