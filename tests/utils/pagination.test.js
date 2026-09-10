import { describe, it, expect } from "vitest";
import { paginationSchema } from "../../src/utils/pagination.js";

describe("paginationSchema", () => {
  it("aplica defaults cuando no se envía nada", () => {
    const result = paginationSchema.safeParse({});
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ page: 1, limit: 20 });
  });

  it("coerce strings a number (query strings siempre son string)", () => {
    const result = paginationSchema.safeParse({ page: "3", limit: "50" });
    expect(result.success).toBe(true);
    expect(result.data.page).toBe(3);
    expect(result.data.limit).toBe(50);
  });

  it('rechaza "?page=abc" (NaN)', () => {
    const result = paginationSchema.safeParse({ page: "abc" });
    expect(result.success).toBe(false);
  });

  it("rechaza page=0 (debe ser positivo)", () => {
    const result = paginationSchema.safeParse({ page: 0 });
    expect(result.success).toBe(false);
  });

  it("rechaza page negativo", () => {
    const result = paginationSchema.safeParse({ page: -5 });
    expect(result.success).toBe(false);
  });

  it("rechaza limit > 100 (cap defensivo)", () => {
    const result = paginationSchema.safeParse({ limit: 9999 });
    expect(result.success).toBe(false);
  });

  it("rechaza limit fraccional", () => {
    const result = paginationSchema.safeParse({ limit: 10.5 });
    expect(result.success).toBe(false);
  });

  it("permite filtros adicionales mediante passthrough", () => {
    // El CRUD genérico declara filtros en `entityConfig.allowedFilters`. El
    // schema NO debe descartarlos: deja pasar las claves extras para que
    // `buildFilters` las consuma luego.
    const result = paginationSchema.safeParse({
      page: "2",
      limit: "30",
      dni: "12345678",
      email: "x@y.com",
    });
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      page: 2,
      limit: 30,
      dni: "12345678",
      email: "x@y.com",
    });
  });

  it("limit en el borde superior (=100) pasa", () => {
    const result = paginationSchema.safeParse({ limit: 100 });
    expect(result.success).toBe(true);
    expect(result.data.limit).toBe(100);
  });

  it("limit=1 (mínimo) pasa", () => {
    const result = paginationSchema.safeParse({ limit: 1 });
    expect(result.success).toBe(true);
  });
});
