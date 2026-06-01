-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "nombre" TEXT NOT NULL,
    "descripcion" TEXT,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tipos_cuenta" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "nombre" TEXT NOT NULL,
    "descripcion" TEXT,
    "limite_transferencia" DECIMAL(18,2),

    CONSTRAINT "tipos_cuenta_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tipos_transaccion" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "nombre" TEXT NOT NULL,
    "descripcion" TEXT,

    CONSTRAINT "tipos_transaccion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "personas" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "nombre" TEXT,
    "apellido" TEXT,
    "dni" TEXT,
    "email" TEXT,
    "telefono" TEXT,
    "fecha_nacimiento" DATE,
    "perfil_completo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "personas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usuarios" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "persona_id" UUID NOT NULL,
    "clerk_id" TEXT NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usuarios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "personas_roles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "persona_id" UUID NOT NULL,
    "rol_id" UUID NOT NULL,
    "asignado_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "personas_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cuentas" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "persona_id" UUID NOT NULL,
    "tipo_cuenta_id" UUID NOT NULL,
    "numero_cuenta" TEXT NOT NULL,
    "cbu" TEXT NOT NULL,
    "alias" TEXT,
    "saldo" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "activa" BOOLEAN NOT NULL DEFAULT true,
    "banco_central_registrada" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cuentas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "banco_central_configuracion" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "environment" TEXT NOT NULL DEFAULT 'test',
    "api_url" TEXT NOT NULL DEFAULT 'https://centralbank.brocoly.cc/api',
    "register_token" TEXT,
    "api_key" TEXT,
    "bank_name" TEXT,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "banco_central_configuracion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "banco_central_registro" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "bank_id" TEXT NOT NULL,
    "bank_code" INTEGER NOT NULL,
    "nombre" TEXT NOT NULL,
    "environment" TEXT NOT NULL DEFAULT 'test',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "banco_central_registro_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "destinatarios" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "persona_id" UUID NOT NULL,
    "alias" TEXT,
    "cbu_externo" TEXT NOT NULL,
    "banco_externo" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "destinatarios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transacciones" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tipo_transaccion_id" UUID NOT NULL,
    "cuenta_origen_id" UUID,
    "cuenta_destino_id" UUID,
    "monto" DECIMAL(18,2) NOT NULL,
    "descripcion" TEXT,
    "estado" TEXT NOT NULL DEFAULT 'pendiente',
    "central_transaction_id" TEXT,
    "canal" TEXT NOT NULL DEFAULT 'local',
    "cbu_origen" TEXT,
    "cbu_destino" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transacciones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auditoria" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "usuario_id" UUID,
    "accion" TEXT NOT NULL,
    "entidad" TEXT NOT NULL,
    "entidad_id" UUID,
    "payload_antes" JSONB,
    "payload_despues" JSONB,
    "ip_address" TEXT,
    "fuente" TEXT NOT NULL DEFAULT 'usuario',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auditoria_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "key" TEXT NOT NULL,
    "user_id" UUID,
    "endpoint" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'in_flight',
    "response_status" INTEGER,
    "response_body" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6) NOT NULL DEFAULT (now() + '24 hours'::interval),

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "personas_dni_key" ON "personas"("dni");

-- CreateIndex
CREATE UNIQUE INDEX "personas_email_key" ON "personas"("email");

-- CreateIndex
CREATE UNIQUE INDEX "usuarios_clerk_id_key" ON "usuarios"("clerk_id");

-- CreateIndex
CREATE INDEX "usuarios_persona_id_idx" ON "usuarios"("persona_id");

-- CreateIndex
CREATE INDEX "usuarios_clerk_id_idx" ON "usuarios"("clerk_id");

-- CreateIndex
CREATE INDEX "personas_roles_persona_id_idx" ON "personas_roles"("persona_id");

-- CreateIndex
CREATE INDEX "personas_roles_rol_id_idx" ON "personas_roles"("rol_id");

-- CreateIndex
CREATE UNIQUE INDEX "personas_roles_persona_id_rol_id_key" ON "personas_roles"("persona_id", "rol_id");

-- CreateIndex
CREATE UNIQUE INDEX "cuentas_numero_cuenta_key" ON "cuentas"("numero_cuenta");

-- CreateIndex
CREATE UNIQUE INDEX "cuentas_cbu_key" ON "cuentas"("cbu");

-- CreateIndex
CREATE UNIQUE INDEX "cuentas_alias_key" ON "cuentas"("alias");

-- CreateIndex
CREATE INDEX "cuentas_persona_id_idx" ON "cuentas"("persona_id");

-- CreateIndex
CREATE INDEX "cuentas_tipo_cuenta_id_idx" ON "cuentas"("tipo_cuenta_id");

-- CreateIndex
CREATE INDEX "cuentas_alias_idx" ON "cuentas"("alias");

-- CreateIndex
CREATE INDEX "cuentas_cbu_idx" ON "cuentas"("cbu");

-- CreateIndex
CREATE UNIQUE INDEX "banco_central_configuracion_environment_key" ON "banco_central_configuracion"("environment");

-- CreateIndex
CREATE UNIQUE INDEX "banco_central_registro_bank_id_environment_key" ON "banco_central_registro"("bank_id", "environment");

-- CreateIndex
CREATE UNIQUE INDEX "banco_central_registro_bank_code_environment_key" ON "banco_central_registro"("bank_code", "environment");

-- CreateIndex
CREATE INDEX "destinatarios_persona_id_idx" ON "destinatarios"("persona_id");

-- CreateIndex
CREATE INDEX "transacciones_tipo_transaccion_id_idx" ON "transacciones"("tipo_transaccion_id");

-- CreateIndex
CREATE INDEX "transacciones_cuenta_origen_id_idx" ON "transacciones"("cuenta_origen_id");

-- CreateIndex
CREATE INDEX "transacciones_cuenta_destino_id_idx" ON "transacciones"("cuenta_destino_id");

-- CreateIndex
CREATE INDEX "transacciones_central_transaction_id_idx" ON "transacciones"("central_transaction_id");

-- CreateIndex
CREATE INDEX "transacciones_canal_idx" ON "transacciones"("canal");

-- CreateIndex
CREATE INDEX "transacciones_cbu_origen_idx" ON "transacciones"("cbu_origen");

-- CreateIndex
CREATE INDEX "transacciones_cbu_destino_idx" ON "transacciones"("cbu_destino");

-- CreateIndex
CREATE INDEX "transacciones_created_at_idx" ON "transacciones"("created_at");

-- CreateIndex
CREATE INDEX "auditoria_usuario_id_idx" ON "auditoria"("usuario_id");

-- CreateIndex
CREATE INDEX "auditoria_entidad_entidad_id_idx" ON "auditoria"("entidad", "entidad_id");

-- CreateIndex
CREATE INDEX "idempotency_keys_expires_at_idx" ON "idempotency_keys"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_keys_user_id_endpoint_key_key" ON "idempotency_keys"("user_id", "endpoint", "key");

-- AddForeignKey
ALTER TABLE "usuarios" ADD CONSTRAINT "usuarios_persona_id_fkey" FOREIGN KEY ("persona_id") REFERENCES "personas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "personas_roles" ADD CONSTRAINT "personas_roles_persona_id_fkey" FOREIGN KEY ("persona_id") REFERENCES "personas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "personas_roles" ADD CONSTRAINT "personas_roles_rol_id_fkey" FOREIGN KEY ("rol_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cuentas" ADD CONSTRAINT "cuentas_persona_id_fkey" FOREIGN KEY ("persona_id") REFERENCES "personas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cuentas" ADD CONSTRAINT "cuentas_tipo_cuenta_id_fkey" FOREIGN KEY ("tipo_cuenta_id") REFERENCES "tipos_cuenta"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "destinatarios" ADD CONSTRAINT "destinatarios_persona_id_fkey" FOREIGN KEY ("persona_id") REFERENCES "personas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transacciones" ADD CONSTRAINT "transacciones_tipo_transaccion_id_fkey" FOREIGN KEY ("tipo_transaccion_id") REFERENCES "tipos_transaccion"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "transacciones" ADD CONSTRAINT "transacciones_cuenta_origen_id_fkey" FOREIGN KEY ("cuenta_origen_id") REFERENCES "cuentas"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "transacciones" ADD CONSTRAINT "transacciones_cuenta_destino_id_fkey" FOREIGN KEY ("cuenta_destino_id") REFERENCES "cuentas"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "auditoria" ADD CONSTRAINT "auditoria_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

