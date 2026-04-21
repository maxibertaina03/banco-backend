const { z } = require('zod');
const { uuidLike } = require('../utils/schemas');
const requireRoles = require('../middlewares/require-roles');
const {
  injectCurrentPersona,
  requireOwnershipByEntity,
  restrictQueryToCurrentPersona,
} = require('../middlewares/ownership');

const uuid = uuidLike;
const numericString = z.union([z.string(), z.number()]).transform((value) => String(value));
const optionalNullableString = z.string().trim().min(1).nullable().optional();
const internalOnly = [requireRoles(['admin', 'operador', 'auditor', 'tesoreria'])];

const entities = {
  personas: {
    table: 'personas',
    orderBy: 'created_at DESC',
    select: '*',
    allowedFilters: ['dni', 'email'],
    createSchema: z.object({
      nombre: z.string().trim().min(1),
      apellido: z.string().trim().min(1),
      dni: z.string().trim().min(1).nullable().optional(),
      email: z.email(),
      telefono: optionalNullableString,
      fecha_nacimiento: z.iso.date().nullable().optional(),
      perfil_completo: z.boolean().optional(),
    }),
    access: {
      list: internalOnly,
      get: internalOnly,
      create: internalOnly,
      update: internalOnly,
      delete: internalOnly,
    },
  },
  roles: {
    table: 'roles',
    orderBy: 'nombre ASC',
    select: '*',
    allowedFilters: ['nombre'],
    createSchema: z.object({
      nombre: z.string().trim().min(1),
      descripcion: optionalNullableString,
    }),
    access: {
      list: internalOnly,
      get: internalOnly,
      create: internalOnly,
      update: internalOnly,
      delete: internalOnly,
    },
  },
  personas_roles: {
    table: 'personas_roles',
    orderBy: 'asignado_at DESC',
    select: '*',
    allowedFilters: ['persona_id', 'rol_id'],
    createSchema: z.object({
      persona_id: uuid,
      rol_id: uuid,
    }),
    access: {
      list: internalOnly,
      get: internalOnly,
      create: internalOnly,
      update: internalOnly,
      delete: internalOnly,
    },
  },
  usuarios: {
    table: 'usuarios',
    orderBy: 'created_at DESC',
    select: '*',
    allowedFilters: ['persona_id', 'clerk_id', 'activo'],
    createSchema: z.object({
      persona_id: uuid,
      clerk_id: z.string().trim().min(1),
      activo: z.boolean().optional(),
    }),
    access: {
      list: internalOnly,
      get: internalOnly,
      create: internalOnly,
      update: internalOnly,
      delete: internalOnly,
    },
  },
  tipos_cuenta: {
    table: 'tipos_cuenta',
    orderBy: 'nombre ASC',
    select: '*',
    allowedFilters: ['nombre'],
    createSchema: z.object({
      nombre: z.string().trim().min(1),
      descripcion: optionalNullableString,
      limite_transferencia: numericString.nullable().optional(),
    }),
    access: {
      list: internalOnly,
      get: internalOnly,
      create: internalOnly,
      update: internalOnly,
      delete: internalOnly,
    },
  },
  cuentas: {
    table: 'cuentas',
    orderBy: 'created_at DESC',
    select: '*',
    allowedFilters: ['persona_id', 'tipo_cuenta_id', 'activa', 'numero_cuenta', 'cbu'],
    createSchema: z.object({
      persona_id: uuid,
      tipo_cuenta_id: uuid,
      numero_cuenta: z.string().trim().min(1),
      cbu: z.string().trim().min(1),
      saldo: numericString.optional(),
      activa: z.boolean().optional(),
    }),
    access: {
      list: internalOnly,
      get: internalOnly,
      create: internalOnly,
      update: internalOnly,
      delete: internalOnly,
    },
  },
  tipos_transaccion: {
    table: 'tipos_transaccion',
    orderBy: 'nombre ASC',
    select: '*',
    allowedFilters: ['nombre'],
    createSchema: z.object({
      nombre: z.string().trim().min(1),
      descripcion: optionalNullableString,
    }),
    access: {
      list: internalOnly,
      get: internalOnly,
      create: internalOnly,
      update: internalOnly,
      delete: internalOnly,
    },
  },
  destinatarios: {
    table: 'destinatarios',
    orderBy: 'created_at DESC',
    select: '*',
    allowedFilters: ['persona_id', 'alias', 'cbu_externo'],
    createSchema: z.object({
      persona_id: uuid,
      alias: optionalNullableString,
      cbu_externo: z.string().trim().min(1),
      banco_externo: optionalNullableString,
    }),
    access: {
      list: [restrictQueryToCurrentPersona()],
      get: [requireOwnershipByEntity('destinatarios')],
      create: [injectCurrentPersona()],
      update: [requireOwnershipByEntity('destinatarios')],
      delete: [requireOwnershipByEntity('destinatarios')],
    },
  },
  auditoria: {
    table: 'auditoria',
    orderBy: 'created_at DESC',
    select: '*',
    allowedFilters: ['usuario_id', 'accion', 'entidad', 'entidad_id'],
    createSchema: z.object({
      usuario_id: uuid,
      accion: z.string().trim().min(1),
      entidad: z.string().trim().min(1),
      entidad_id: uuid.nullable().optional(),
      payload_antes: z.record(z.string(), z.any()).nullable().optional(),
      payload_despues: z.record(z.string(), z.any()).nullable().optional(),
      ip_address: optionalNullableString,
    }),
    access: {
      list: internalOnly,
      get: internalOnly,
      create: internalOnly,
      update: internalOnly,
      delete: internalOnly,
    },
  },
};

entities.transacciones = {
  table: 'transacciones',
  orderBy: 'created_at DESC',
  select: '*',
  allowedFilters: ['tipo_transaccion_id', 'cuenta_origen_id', 'cuenta_destino_id', 'estado'],
  createSchema: z.object({
    tipo_transaccion_id: uuid,
    cuenta_origen_id: uuid,
    cuenta_destino_id: uuid.nullable().optional(),
    monto: numericString,
    descripcion: optionalNullableString,
    estado: z.enum(['pendiente', 'completada', 'rechazada']).optional(),
  }),
};

for (const entity of Object.values(entities)) {
  entity.updateSchema = entity.createSchema.partial().refine(
    (data) => Object.keys(data).length > 0,
    'Debes enviar al menos un campo para actualizar.'
  );
}

module.exports = entities;
