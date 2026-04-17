async function writeAuditLog(client, entry) {
  const {
    usuarioId,
    accion,
    entidad,
    entidadId = null,
    payloadAntes = null,
    payloadDespues = null,
    ipAddress = null,
  } = entry;

  if (!usuarioId || !accion || !entidad || entidad === 'auditoria') {
    return;
  }

  await client.query(
    `INSERT INTO auditoria (
      usuario_id,
      accion,
      entidad,
      entidad_id,
      payload_antes,
      payload_despues,
      ip_address
    ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [usuarioId, accion, entidad, entidadId, payloadAntes, payloadDespues, ipAddress]
  );
}

function buildAuditContext(req) {
  return {
    usuarioId: req.currentUser?.id || null,
    ipAddress: req.ip || null,
  };
}

module.exports = {
  buildAuditContext,
  writeAuditLog,
};
