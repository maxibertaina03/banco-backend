// Registro de movimientos en el extracto.
//
// Por qué existe: préstamos, plazos fijos y consumos de tarjeta movían el saldo
// con un UPDATE directo y no dejaban rastro. El cliente veía su saldo saltar un
// millón al sacar un préstamo y en el extracto no había nada que lo explicara.
//
// Toda operación que toque un saldo tiene que pasar por acá. La regla es simple:
// **si el saldo cambia, hay un movimiento**. Sin excepciones, porque la
// excepción es justamente lo que produce un extracto que no cuadra.

const HttpError = require('../utils/http-error');

/** Id de un tipo de transacción por nombre, cacheado por transacción de BD. */
async function idDeTipo(client, nombre) {
  const r = await client.query('SELECT id FROM tipos_transaccion WHERE nombre = $1 LIMIT 1', [nombre]);
  if (r.rowCount === 0) {
    throw new HttpError(500, `No se encontró el tipo de transacción "${nombre}".`);
  }
  return r.rows[0].id;
}

/**
 * Registra un movimiento y devuelve la fila creada.
 *
 * La convención de dirección es la misma que en el resto del sistema:
 *   - entra plata → `cuenta_destino_id` con la cuenta, origen en NULL
 *   - sale plata  → `cuenta_origen_id` con la cuenta, destino en NULL
 *
 * El extracto usa LEFT JOIN en las dos puntas justamente para que ninguno de
 * los dos casos se pierda.
 */
async function registrar(client, { cuentaId, cbu, monto, tipo, canal, descripcion, entra }) {
  const tipoId = await idDeTipo(client, tipo);

  const r = await client.query(
    `INSERT INTO transacciones (
       tipo_transaccion_id, cuenta_origen_id, cuenta_destino_id,
       monto, descripcion, estado, canal, cbu_origen, cbu_destino
     ) VALUES ($1, $2, $3, $4, $5, 'completada', $6, $7, $8)
     RETURNING *`,
    [
      tipoId,
      entra ? null : cuentaId,
      entra ? cuentaId : null,
      monto,
      descripcion,
      canal,
      entra ? null : cbu,
      entra ? cbu : null,
    ]
  );
  return r.rows[0];
}

/** Acredita en la cuenta y registra el movimiento, en una sola llamada. */
async function acreditar(client, { cuentaId, cbu, monto, tipo, canal, descripcion }) {
  await client.query('UPDATE cuentas SET saldo = saldo + $1 WHERE id = $2', [monto, cuentaId]);
  return registrar(client, { cuentaId, cbu, monto, tipo, canal, descripcion, entra: true });
}

/** Debita de la cuenta y registra el movimiento. */
async function debitar(client, { cuentaId, cbu, monto, tipo, canal, descripcion }) {
  await client.query('UPDATE cuentas SET saldo = saldo - $1 WHERE id = $2', [monto, cuentaId]);
  return registrar(client, { cuentaId, cbu, monto, tipo, canal, descripcion, entra: false });
}

module.exports = { registrar, acreditar, debitar, idDeTipo };
