// Tests del middleware de idempotencia.
// Estrategia: pool mockeado (objeto con connect/query). El middleware se
// importa como factory `createIdempotency(pool)`, así inyectamos el mock sin
// tocar el sistema de mocks de módulos.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import createIdempotency, { hashBody } from "../../src/middlewares/idempotency.js";

const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";
const ANOTHER_UUID = "11111111-2222-3333-4444-555555555555";

// ── Mocks: pool + req/res factories ────────────────────────────────────────

function buildPool({ insertResult, existingResult } = {}) {
  const client = {
    query: vi.fn(async (sql) => {
      if (sql.startsWith("INSERT INTO idempotency_keys")) {
        return insertResult ?? { rowCount: 1, rows: [{ id: "k-1" }] };
      }
      if (sql.includes("FROM idempotency_keys")) {
        return existingResult ?? { rows: [] };
      }
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  const pool = {
    connect: vi.fn(async () => client),
    query: vi.fn(async () => ({ rows: [] })),
    __client: client,
  };
  return pool;
}

function buildReq(headers = {}, body = {}, usuarioActual = { id: "u-1" }) {
  return {
    method: "POST",
    path: "/transacciones",
    baseUrl: "/api",
    headers,
    body,
    usuarioActual,
  };
}

function buildRes() {
  const res = new EventEmitter();
  res.statusCode = 200;
  res.headers = {};
  res.set = vi.fn((name, value) => {
    res.headers[name] = value;
    return res;
  });
  res.status = vi.fn((code) => {
    res.statusCode = code;
    return res;
  });
  res.json = vi.fn((body) => {
    res._sentBody = body;
    return res;
  });
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe("idempotency middleware", () => {
  it("no-op si el header Idempotency-Key no está presente", async () => {
    const pool = buildPool();
    const middleware = createIdempotency(pool, { log: () => {} });
    const req = buildReq({});
    const res = buildRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledWith();
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("rechaza con 400 si la key no es un UUID v4", async () => {
    const pool = buildPool();
    const middleware = createIdempotency(pool, { log: () => {} });
    const req = buildReq({ "idempotency-key": "not-a-uuid" });
    const res = buildRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ status: 400 })
    );
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("primer request: reserva la key como in_flight y deja pasar al handler", async () => {
    const pool = buildPool({ insertResult: { rowCount: 1, rows: [{ id: "k-1" }] } });
    const middleware = createIdempotency(pool, { log: () => {} });
    const req = buildReq({ "idempotency-key": VALID_UUID }, { monto: 100 });
    const res = buildRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(pool.__client.query).toHaveBeenCalledOnce();
    expect(pool.__client.query.mock.calls[0][0]).toContain("INSERT INTO idempotency_keys");
    expect(pool.__client.release).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledWith();
    // res.json fue wrappeado para capturar el body más tarde
    expect(typeof res.json).toBe("function");
  });

  it("replay: si la key ya está completed y el hash coincide, devuelve la respuesta cacheada con header Idempotent-Replay", async () => {
    const cachedBody = { id: "tx-1", estado: "completada" };
    const sameBody = { monto: 100 };
    // Calculamos el hash igual que el middleware para que matchee.
    const cachedHash = hashBody(sameBody);

    const pool = buildPool({
      insertResult: { rowCount: 0, rows: [] },
      existingResult: {
        rows: [
          {
            status: "completed",
            request_hash: cachedHash,
            response_status: 201,
            response_body: cachedBody,
          },
        ],
      },
    });
    const middleware = createIdempotency(pool, { log: () => {} });
    const req = buildReq({ "idempotency-key": VALID_UUID }, sameBody);
    const res = buildRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.set).toHaveBeenCalledWith("Idempotent-Replay", "true");
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(cachedBody);
  });

  it("key reutilizada con body distinto: 422", async () => {
    const pool = buildPool({
      insertResult: { rowCount: 0, rows: [] },
      existingResult: {
        rows: [
          {
            status: "completed",
            request_hash: "hash-de-otra-cosa",
            response_status: 201,
            response_body: {},
          },
        ],
      },
    });
    const middleware = createIdempotency(pool, { log: () => {} });
    const req = buildReq({ "idempotency-key": VALID_UUID }, { monto: 999 });
    const res = buildRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ status: 422 })
    );
  });

  it("key en in_flight: 409 conflict", async () => {
    const sameBody = { monto: 100 };
    const sameHash = hashBody(sameBody);

    const pool = buildPool({
      insertResult: { rowCount: 0, rows: [] },
      existingResult: {
        rows: [{ status: "in_flight", request_hash: sameHash }],
      },
    });
    const middleware = createIdempotency(pool, { log: () => {} });
    const req = buildReq({ "idempotency-key": VALID_UUID }, sameBody);
    const res = buildRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ status: 409 })
    );
  });

  it("si la BD falla al reservar, deja pasar al handler (fallthrough)", async () => {
    const pool = {
      connect: vi.fn(async () => {
        throw new Error("DB down");
      }),
      query: vi.fn(),
    };
    const middleware = createIdempotency(pool, { log: () => {} });
    const req = buildReq({ "idempotency-key": VALID_UUID });
    const res = buildRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledWith(); // fallthrough, sin error
  });

  it("hashBody es determinístico para el mismo objeto", () => {
    const a = hashBody({ monto: 100, cbu: "1".repeat(22) });
    const b = hashBody({ monto: 100, cbu: "1".repeat(22) });
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  it("hashBody distingue payloads diferentes", () => {
    const a = hashBody({ monto: 100 });
    const b = hashBody({ monto: 200 });
    expect(a).not.toBe(b);
  });

  it("distintas operaciones (UUIDs distintos) producen distintos paths", async () => {
    const pool = buildPool();
    const middleware = createIdempotency(pool, { log: () => {} });

    const req1 = buildReq({ "idempotency-key": VALID_UUID });
    const req2 = buildReq({ "idempotency-key": ANOTHER_UUID });
    const next = vi.fn();

    await middleware(req1, buildRes(), next);
    await middleware(req2, buildRes(), next);

    expect(pool.__client.query).toHaveBeenCalledTimes(2);
    const firstInsertParams = pool.__client.query.mock.calls[0][1];
    const secondInsertParams = pool.__client.query.mock.calls[1][1];
    expect(firstInsertParams[0]).toBe(VALID_UUID);
    expect(secondInsertParams[0]).toBe(ANOTHER_UUID);
  });
});
