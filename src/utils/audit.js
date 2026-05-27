async function writeAuditLog(client, entry) {
  const {
    usuarioId = null,
    accion,
    entidad,
    entidadId = null,
    payloadAntes = null,
    payloadDespues = null,
    ipAddress = null,
    fuente = 'usuario',
  } = entry;

  // Solo omitir si faltan campos obligatorios estructurales
  if (!accion || !entidad || entidad === 'auditoria') return;

  await client.query(
    `INSERT INTO auditoria (
      usuario_id,
      accion,
      entidad,
      entidad_id,
      payload_antes,
      payload_despues,
      ip_address,
      fuente
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [usuarioId, accion, entidad, entidadId, payloadAntes, payloadDespues, ipAddress, fuente]
  );
}

function buildAuditContext(req) {
  return {
    usuarioId: req.currentUser?.id || null,
    ipAddress: req.ip || null,
    fuente: 'usuario',
  };
}

function buildSystemAuditContext(ipAddress = null) {
  return {
    usuarioId: null,
    ipAddress,
    fuente: 'sistema',
  };
}

function buildWebhookAuditContext(ipAddress = null) {
  return {
    usuarioId: null,
    ipAddress,
    fuente: 'webhook',
  };
}

module.exports = {
  buildAuditContext,
  buildSystemAuditContext,
  buildWebhookAuditContext,
  writeAuditLog,
};
