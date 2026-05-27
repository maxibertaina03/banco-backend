// Tests de auth-service usando dependency injection.
// La factory `createAuthService({ pool, clerkApi })` permite inyectar mocks
// sin tocar el sistema de mocks de módulos (mismo patrón que transacciones).

import { describe, it, expect, vi, beforeEach } from "vitest";

const { createAuthService } = await import("../../src/modules/auth-service.js");

// ── Fixtures + factory de mocks ─────────────────────────────────────────────

function buildMocks() {
  const mockClient = {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    release: vi.fn(),
  };
  const pool = {
    connect: vi.fn().mockResolvedValue(mockClient),
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  };
  const clerkApi = {
    get: vi.fn(),
  };
  return { pool, mockClient, clerkApi };
}

function buildService(deps) {
  return createAuthService(deps);
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── getOrCreateUser ─────────────────────────────────────────────────────────

describe("getOrCreateUser", () => {
  it("devuelve el user existente sin llamar a Clerk si ya está en BD", async () => {
    const mocks = buildMocks();
    const existingUser = {
      id: "u-1",
      persona_id: "p-1",
      clerk_id: "clerk_xyz",
      activo: true,
      nombre: "Juan",
      apellido: "Pérez",
      email: "juan@ex.com",
      perfil_completo: true,
    };
    mocks.pool.query.mockResolvedValueOnce({ rowCount: 1, rows: [existingUser] });
    const service = buildService(mocks);

    const result = await service.getOrCreateUser("clerk_xyz");

    expect(result).toEqual(existingUser);
    expect(mocks.clerkApi.get).not.toHaveBeenCalled();
    expect(mocks.pool.connect).not.toHaveBeenCalled();
  });

  it("filtra por activo=true: usuario inactivo no se devuelve directo", async () => {
    const mocks = buildMocks();
    // El SELECT no encuentra (rowCount=0) porque tiene `AND activo = true`.
    // Eso fuerza a provisionUserFromClerk que sí va a Clerk.
    mocks.pool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    // pool.connect() → mockClient.query es lo que usa provisionUserFromClerk;
    // las queries reales se mockean abajo para evitar llamar a Clerk.
    mocks.clerkApi.get.mockResolvedValueOnce({
      data: {
        id: "clerk_xyz",
        email_addresses: [],
        first_name: "Juan",
        last_name: "Pérez",
        phone_numbers: [],
      },
    });
    // En provisionUserFromClerk: BEGIN, SELECT existing by clerk_id, ...
    mocks.mockClient.query.mockImplementation((sql) => {
      if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return Promise.resolve({ rows: [] });
      // existingUserByClerk: no existe
      if (sql.includes("FROM usuarios u") && sql.includes("u.clerk_id = $1")) {
        return Promise.resolve({ rowCount: 0, rows: [] });
      }
      // existingPersona by email: no existe
      if (sql.includes("FROM personas WHERE email = $1")) {
        return Promise.resolve({ rowCount: 0, rows: [] });
      }
      // INSERT persona
      if (sql.startsWith("INSERT INTO personas")) {
        return Promise.resolve({ rowCount: 1, rows: [{ id: "p-new" }] });
      }
      // INSERT usuario
      if (sql.startsWith("INSERT INTO usuarios")) {
        return Promise.resolve({ rowCount: 1, rows: [{ id: "u-new" }] });
      }
      // Lookup role
      if (sql.includes("FROM roles WHERE nombre = $1")) {
        return Promise.resolve({ rowCount: 0, rows: [] });
      }
      // Full user re-fetch
      if (sql.includes("WHERE u.id = $1")) {
        return Promise.resolve({ rowCount: 1, rows: [{ id: "u-new", persona_id: "p-new" }] });
      }
      return Promise.resolve({ rowCount: 0, rows: [] });
    });
    const service = buildService(mocks);

    const result = await service.getOrCreateUser("clerk_xyz");

    expect(result).toMatchObject({ id: "u-new", persona_id: "p-new" });
    expect(mocks.clerkApi.get).toHaveBeenCalledOnce();
  });
});

// ── createUserWithClerk ─────────────────────────────────────────────────────

describe("createUserWithClerk", () => {
  it("404 si la persona no existe", async () => {
    const mocks = buildMocks();
    mocks.pool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const service = buildService(mocks);

    await expect(service.createUserWithClerk("p-ghost", "clerk_x")).rejects.toMatchObject({
      status: 404,
    });
  });

  it("400 si clerk_id ya está asociado a otra persona", async () => {
    const mocks = buildMocks();
    mocks.pool.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "p-1" }] })       // persona existe
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })                    // no hay user con esa persona_id
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ persona_id: "p-OTHER" }] }); // clerk_id en uso por OTRO
    const service = buildService(mocks);

    await expect(service.createUserWithClerk("p-1", "clerk_x")).rejects.toMatchObject({
      status: 400,
    });
  });

  it("reactiva si la persona ya tenía un usuario (re-asigna clerk_id)", async () => {
    const mocks = buildMocks();
    mocks.pool.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "p-1" }] })       // persona existe
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "u-existing", persona_id: "p-1" }] }) // user previo
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })                    // no hay otro user con ese clerk_id
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "u-existing", clerk_id: "clerk_x", activo: true }] }); // UPDATE
    const service = buildService(mocks);

    const result = await service.createUserWithClerk("p-1", "clerk_x");

    expect(result.clerk_id).toBe("clerk_x");
    expect(result.activo).toBe(true);
  });

  it("crea un nuevo user si la persona no tiene uno previo", async () => {
    const mocks = buildMocks();
    mocks.pool.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "p-1" }] }) // persona existe
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })              // sin user previo
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })              // clerk_id libre
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "u-new" }] }); // INSERT
    const service = buildService(mocks);

    const result = await service.createUserWithClerk("p-1", "clerk_x");

    expect(result.id).toBe("u-new");
  });
});

// ── getUserProfile ──────────────────────────────────────────────────────────

describe("getUserProfile", () => {
  it("devuelve el perfil con roles si el usuario existe", async () => {
    const mocks = buildMocks();
    mocks.pool.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "u-1", persona_id: "p-1", nombre: "Juan" }] })
      .mockResolvedValueOnce({ rowCount: 2, rows: [{ id: "r-1", nombre: "cliente" }, { id: "r-2", nombre: "admin" }] });
    const service = buildService(mocks);

    const result = await service.getUserProfile("clerk_x");

    expect(result).toMatchObject({ id: "u-1", persona_id: "p-1", nombre: "Juan" });
    expect(result.roles).toHaveLength(2);
    expect(result.roles[0].nombre).toBe("cliente");
  });

  it("usuario sin roles: roles=[] pero no rompe", async () => {
    const mocks = buildMocks();
    mocks.pool.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "u-1", persona_id: "p-1" }] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const service = buildService(mocks);

    const result = await service.getUserProfile("clerk_x");

    expect(result.roles).toEqual([]);
  });
});

// ── deactivateUser ──────────────────────────────────────────────────────────

describe("deactivateUser", () => {
  it("marca activo=false y devuelve el usuario actualizado", async () => {
    const mocks = buildMocks();
    mocks.pool.query.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ id: "u-1", activo: false }],
    });
    const service = buildService(mocks);

    const result = await service.deactivateUser("clerk_x");

    expect(result.activo).toBe(false);
    const [sql, params] = mocks.pool.query.mock.calls[0];
    expect(sql).toContain("UPDATE usuarios SET activo = false");
    expect(params).toEqual(["clerk_x"]);
  });

  it("404 si el clerk_id no corresponde a ningún usuario", async () => {
    const mocks = buildMocks();
    mocks.pool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const service = buildService(mocks);

    await expect(service.deactivateUser("clerk_ghost")).rejects.toMatchObject({ status: 404 });
  });
});

// ── completeUserProfile ─────────────────────────────────────────────────────

describe("completeUserProfile", () => {
  const payload = {
    nombre: "Juan",
    apellido: "Pérez",
    dni: "12345678",
    email: "juan@ex.com",
    telefono: "+5491112345",
    fecha_nacimiento: "1990-01-01",
  };

  it("devuelve el perfil con perfil_completo=true", async () => {
    const mocks = buildMocks();
    mocks.pool.query.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ id: "u-1", persona_id: "p-1", ...payload, perfil_completo: true }],
    });
    const service = buildService(mocks);

    const result = await service.completeUserProfile("clerk_x", payload);

    expect(result.perfil_completo).toBe(true);
    expect(result.dni).toBe("12345678");
  });

  it("404 si el usuario está inactivo o no existe", async () => {
    const mocks = buildMocks();
    mocks.pool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const service = buildService(mocks);

    await expect(service.completeUserProfile("clerk_x", payload)).rejects.toMatchObject({
      status: 404,
    });
  });
});

// ── syncClerkUserFromWebhook ────────────────────────────────────────────────

describe("syncClerkUserFromWebhook", () => {
  it("400 si el evento no tiene user id", async () => {
    const mocks = buildMocks();
    const service = buildService(mocks);

    await expect(service.syncClerkUserFromWebhook({})).rejects.toMatchObject({ status: 400 });
    expect(mocks.pool.connect).not.toHaveBeenCalled();
  });

  it("actualiza usuario existente: reactiva y mergea campos faltantes", async () => {
    const mocks = buildMocks();
    mocks.mockClient.query.mockImplementation((sql) => {
      if (/^(BEGIN|COMMIT)/.test(sql)) return Promise.resolve({ rows: [] });
      if (sql.includes("SELECT u.id, u.persona_id")) {
        return Promise.resolve({ rowCount: 1, rows: [{ id: "u-1", persona_id: "p-1" }] });
      }
      // UPDATE usuarios + UPDATE personas
      return Promise.resolve({ rows: [] });
    });
    const service = buildService(mocks);

    await service.syncClerkUserFromWebhook({
      id: "clerk_x",
      email_addresses: [{ id: "e-1", email_address: "juan@ex.com" }],
      primary_email_address_id: "e-1",
      first_name: "Juan",
      last_name: "Pérez",
      phone_numbers: [],
    });

    const queries = mocks.mockClient.query.mock.calls.map((c) =>
      typeof c[0] === "string" ? c[0].slice(0, 30) : ""
    );
    expect(queries).toContain("BEGIN");
    expect(queries).toContain("COMMIT");
    expect(mocks.mockClient.release).toHaveBeenCalledOnce();
  });

  it("rollback si una query falla durante el sync", async () => {
    const mocks = buildMocks();
    mocks.mockClient.query.mockImplementation((sql) => {
      if (/^(BEGIN|ROLLBACK)/.test(sql)) return Promise.resolve({ rows: [] });
      if (sql.includes("SELECT u.id, u.persona_id")) {
        return Promise.reject(new Error("DB error simulado"));
      }
      return Promise.resolve({ rows: [] });
    });
    const service = buildService(mocks);

    await expect(
      service.syncClerkUserFromWebhook({
        id: "clerk_x",
        email_addresses: [],
        phone_numbers: [],
      })
    ).rejects.toThrow("DB error simulado");

    const queries = mocks.mockClient.query.mock.calls.map((c) =>
      typeof c[0] === "string" ? c[0].slice(0, 10) : ""
    );
    expect(queries).toContain("BEGIN");
    expect(queries).toContain("ROLLBACK");
    expect(queries).not.toContain("COMMIT");
    expect(mocks.mockClient.release).toHaveBeenCalledOnce();
  });

  it("normaliza email a lowercase + trim", async () => {
    const mocks = buildMocks();
    let capturedEmail = null;
    mocks.mockClient.query.mockImplementation((sql, params) => {
      if (/^(BEGIN|COMMIT)/.test(sql)) return Promise.resolve({ rows: [] });
      if (sql.includes("SELECT u.id, u.persona_id")) {
        return Promise.resolve({ rowCount: 0, rows: [] }); // no existe
      }
      if (sql.includes("FROM personas WHERE email = $1")) {
        capturedEmail = params[0];
        return Promise.resolve({ rowCount: 0, rows: [] });
      }
      if (sql.startsWith("INSERT INTO personas")) {
        return Promise.resolve({ rowCount: 1, rows: [{ id: "p-new" }] });
      }
      if (sql.includes("FROM roles")) return Promise.resolve({ rowCount: 0, rows: [] });
      return Promise.resolve({ rows: [] });
    });
    const service = buildService(mocks);

    await service.syncClerkUserFromWebhook({
      id: "clerk_x",
      email_addresses: [{ id: "e-1", email_address: "  JUAN@Example.COM  " }],
      primary_email_address_id: "e-1",
      first_name: "Juan",
      last_name: "P",
      phone_numbers: [],
    });

    expect(capturedEmail).toBe("juan@example.com");
  });
});

// ── deactivateClerkUserFromWebhook ──────────────────────────────────────────

describe("deactivateClerkUserFromWebhook", () => {
  it("no-op si clerk_id es null/undefined", async () => {
    const mocks = buildMocks();
    const service = buildService(mocks);

    await service.deactivateClerkUserFromWebhook(null);
    await service.deactivateClerkUserFromWebhook(undefined);

    expect(mocks.pool.query).not.toHaveBeenCalled();
  });

  it("marca activo=false (no falla si no encuentra)", async () => {
    const mocks = buildMocks();
    mocks.pool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const service = buildService(mocks);

    await service.deactivateClerkUserFromWebhook("clerk_x");

    expect(mocks.pool.query).toHaveBeenCalledOnce();
    const [sql] = mocks.pool.query.mock.calls[0];
    expect(sql).toContain("SET activo = false");
  });
});
