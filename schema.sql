-- ============================================================
--  SCHEMA COMPLETO - Sistema Bancario
--  Compatible con Supabase / PostgreSQL
-- ============================================================

-- Habilitar extensión para UUIDs
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ------------------------------------------------------------
-- ROLES
-- ------------------------------------------------------------
CREATE TABLE roles (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    nombre      TEXT        NOT NULL,
    descripcion TEXT
);

-- ------------------------------------------------------------
-- TIPOS DE CUENTA
-- ------------------------------------------------------------
CREATE TABLE tipos_cuenta (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    nombre              TEXT        NOT NULL,
    descripcion         TEXT,
    limite_transferencia NUMERIC(18,2)
);

-- ------------------------------------------------------------
-- TIPOS DE TRANSACCIÓN
-- ------------------------------------------------------------
CREATE TABLE tipos_transaccion (
    id          UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
    nombre      TEXT    NOT NULL,
    descripcion TEXT
);

-- ------------------------------------------------------------
-- PERSONAS
-- ------------------------------------------------------------
CREATE TABLE personas (
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    nombre           TEXT,
    apellido         TEXT,
    dni              TEXT        UNIQUE,
    email            TEXT        UNIQUE,
    telefono         TEXT,
    fecha_nacimiento DATE,
    perfil_completo  BOOLEAN     DEFAULT FALSE,
    created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ------------------------------------------------------------
-- USUARIOS
-- ------------------------------------------------------------
CREATE TABLE usuarios (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    persona_id  UUID        NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
    clerk_id    TEXT        UNIQUE NOT NULL,
    activo      BOOLEAN     DEFAULT TRUE,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ------------------------------------------------------------
-- PERSONAS_ROLES  (tabla intermedia persona ↔ rol)
-- ------------------------------------------------------------
CREATE TABLE personas_roles (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    persona_id   UUID        NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
    rol_id       UUID        NOT NULL REFERENCES roles(id)    ON DELETE CASCADE,
    asignado_at  TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (persona_id, rol_id)
);

-- ------------------------------------------------------------
-- CUENTAS
-- ------------------------------------------------------------
CREATE TABLE cuentas (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    persona_id      UUID        NOT NULL REFERENCES personas(id)      ON DELETE CASCADE,
    tipo_cuenta_id  UUID        NOT NULL REFERENCES tipos_cuenta(id),
    numero_cuenta   TEXT        UNIQUE NOT NULL,
    cbu             TEXT        UNIQUE NOT NULL,
    saldo           NUMERIC(18,2) NOT NULL DEFAULT 0.00,
    activa          BOOLEAN     DEFAULT TRUE,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ------------------------------------------------------------
-- DESTINATARIOS
-- ------------------------------------------------------------
CREATE TABLE destinatarios (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    persona_id    UUID        NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
    alias         TEXT,
    cbu_externo   TEXT        NOT NULL,
    banco_externo TEXT,
    created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ------------------------------------------------------------
-- TRANSACCIONES
-- ------------------------------------------------------------
CREATE TABLE transacciones (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tipo_transaccion_id UUID        NOT NULL REFERENCES tipos_transaccion(id),
    cuenta_origen_id    UUID        NOT NULL REFERENCES cuentas(id),
    cuenta_destino_id   UUID                 REFERENCES cuentas(id),
    monto               NUMERIC(18,2) NOT NULL,
    descripcion         TEXT,
    estado              TEXT        NOT NULL DEFAULT 'pendiente',
    created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ------------------------------------------------------------
-- AUDITORÍA
-- ------------------------------------------------------------
CREATE TABLE auditoria (
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    usuario_id       UUID        NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    accion           TEXT        NOT NULL,
    entidad          TEXT        NOT NULL,
    entidad_id       UUID,
    payload_antes    JSONB,
    payload_despues  JSONB,
    ip_address       TEXT,
    created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
--  ÍNDICES RECOMENDADOS
-- ============================================================
CREATE INDEX idx_usuarios_persona_id         ON usuarios(persona_id);
CREATE INDEX idx_personas_roles_persona_id   ON personas_roles(persona_id);
CREATE INDEX idx_personas_roles_rol_id       ON personas_roles(rol_id);
CREATE INDEX idx_cuentas_persona_id          ON cuentas(persona_id);
CREATE INDEX idx_cuentas_tipo_cuenta_id      ON cuentas(tipo_cuenta_id);
CREATE INDEX idx_destinatarios_persona_id    ON destinatarios(persona_id);
CREATE INDEX idx_transacciones_origen        ON transacciones(cuenta_origen_id);
CREATE INDEX idx_transacciones_destino       ON transacciones(cuenta_destino_id);
CREATE INDEX idx_transacciones_tipo          ON transacciones(tipo_transaccion_id);
CREATE INDEX idx_auditoria_usuario_id        ON auditoria(usuario_id);
CREATE INDEX idx_auditoria_entidad           ON auditoria(entidad, entidad_id);

-- ============================================================
--  ROW LEVEL SECURITY (RLS) - Supabase
--  Descomentar y adaptar según tus políticas de acceso
-- ============================================================
-- ALTER TABLE personas      ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE usuarios      ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE cuentas       ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE transacciones ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE destinatarios ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE auditoria     ENABLE ROW LEVEL SECURITY;
