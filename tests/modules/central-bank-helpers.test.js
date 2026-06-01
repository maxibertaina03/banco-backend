// Tests de las funciones puras extraídas de central-bank-service.
// Estas funciones no tocan BD ni red, así que se testean directo sin mocks.
// Sirven de red de seguridad para el refactor de modularización (jun 2026).

import { describe, it, expect } from "vitest";

const {
  generateLocalAccountNumber,
  sanitizeCentralText,
  sanitizeDni,
  cleanAliasText,
  normalizeAliasValue,
  createAliasVariant,
  buildAliasCandidates,
  extractCentralCbu,
  extractCentralTransactionId,
  extractCentralAlias,
  toSyncIssues,
} = await import("../../src/modules/central-bank/central-bank-helpers.js");

// ── generateLocalAccountNumber ────────────────────────────────────────────────

describe("generateLocalAccountNumber", () => {
  it("devuelve siempre 12 dígitos", () => {
    const num = generateLocalAccountNumber("11111111-2222-3333-4444-555555555555");
    expect(num).toMatch(/^\d{12}$/);
  });

  it("usa los últimos 6 dígitos de la persona como prefijo", () => {
    const num = generateLocalAccountNumber("abc123456");
    expect(num.slice(0, 6)).toBe("123456");
  });

  it("rellena con ceros si la persona tiene pocos dígitos", () => {
    const num = generateLocalAccountNumber("ab12");
    expect(num.slice(0, 6)).toBe("000012");
  });

  it("no rompe con personaId vacío o null", () => {
    expect(generateLocalAccountNumber(null)).toMatch(/^\d{12}$/);
    expect(generateLocalAccountNumber("")).toMatch(/^\d{12}$/);
  });
});

// ── sanitizeCentralText ───────────────────────────────────────────────────────

describe("sanitizeCentralText", () => {
  it("quita acentos y la ñ", () => {
    expect(sanitizeCentralText("José Ñandú")).toBe("Jose Nandu");
  });

  it("elimina símbolos raros y colapsa espacios", () => {
    expect(sanitizeCentralText("Juan!!!   Pérez$$")).toBe("Juan Perez");
  });

  it("conserva apóstrofes y guiones", () => {
    expect(sanitizeCentralText("O'Brien-García")).toBe("O'Brien-Garcia");
  });

  it("devuelve null para valores vacíos", () => {
    expect(sanitizeCentralText("")).toBeNull();
    expect(sanitizeCentralText(null)).toBeNull();
    expect(sanitizeCentralText("   ")).toBeNull();
  });
});

// ── sanitizeDni ───────────────────────────────────────────────────────────────

describe("sanitizeDni", () => {
  it("deja solo dígitos", () => {
    expect(sanitizeDni("12.345.678")).toBe("12345678");
    expect(sanitizeDni("DNI 30111222")).toBe("30111222");
  });

  it("devuelve null si no hay dígitos", () => {
    expect(sanitizeDni("abc")).toBeNull();
    expect(sanitizeDni(null)).toBeNull();
    expect(sanitizeDni("")).toBeNull();
  });
});

// ── cleanAliasText / normalizeAliasValue ──────────────────────────────────────

describe("cleanAliasText", () => {
  it("pasa a minúsculas, sin acentos, separando con puntos", () => {
    expect(cleanAliasText("José Pérez")).toBe("jose.perez");
  });

  it("colapsa puntos múltiples y recorta bordes", () => {
    expect(cleanAliasText("..hola..mundo..")).toBe("hola.mundo");
  });

  it("devuelve null si queda vacío", () => {
    expect(cleanAliasText("...")).toBeNull();
    expect(cleanAliasText(null)).toBeNull();
  });
});

describe("normalizeAliasValue", () => {
  it("descarta alias más cortos que el mínimo (6)", () => {
    expect(normalizeAliasValue("ab")).toBeNull();
    expect(normalizeAliasValue("juan")).toBeNull();
  });

  it("acepta alias válidos", () => {
    expect(normalizeAliasValue("juan.perez")).toBe("juan.perez");
  });

  it("recorta al máximo de 20 caracteres", () => {
    const result = normalizeAliasValue("a".repeat(40));
    expect(result.length).toBe(20);
  });
});

// ── createAliasVariant ────────────────────────────────────────────────────────

describe("createAliasVariant", () => {
  it("une partes con puntos y normaliza", () => {
    expect(createAliasVariant(["Juan", "Pérez"])).toBe("juan.perez");
  });

  it("ignora partes vacías", () => {
    expect(createAliasVariant(["Juan", "", null, "Perez"])).toBe("juan.perez");
  });

  it("devuelve null si todas las partes son vacías", () => {
    expect(createAliasVariant(["", null, undefined])).toBeNull();
  });
});

// ── buildAliasCandidates ──────────────────────────────────────────────────────

describe("buildAliasCandidates", () => {
  const account = {
    nombre: "Juan",
    apellido: "Pérez",
    numero_cuenta: "001234567890",
    cbu: "1".repeat(22),
    alias: null,
  };

  it("genera candidatos sin duplicados", () => {
    const candidates = buildAliasCandidates(account, "Orbital");
    expect(candidates.length).toBe(new Set(candidates).size);
    expect(candidates).toContain("juan.perez");
  });

  it("usa los últimos 4 del número de cuenta como sufijo", () => {
    const candidates = buildAliasCandidates(account, "Orbital");
    expect(candidates).toContain("juan.7890");
  });

  it("cae a 'orbital' como banco por defecto si no hay nombre", () => {
    const candidates = buildAliasCandidates(account, null);
    expect(candidates.some((c) => c.includes("orbital"))).toBe(true);
  });
});

// ── extractCentralCbu ─────────────────────────────────────────────────────────

describe("extractCentralCbu", () => {
  it("encuentra el cbu en el nivel superior", () => {
    expect(extractCentralCbu({ cbu: "123" })).toBe("123");
  });

  it("encuentra el cbu anidado y lo trimea", () => {
    expect(extractCentralCbu({ data: { persona: { cbu: "  999  " } } })).toBe("999");
  });

  it("devuelve null si no hay cbu o el payload no es objeto", () => {
    expect(extractCentralCbu({ foo: "bar" })).toBeNull();
    expect(extractCentralCbu(null)).toBeNull();
    expect(extractCentralCbu("texto")).toBeNull();
  });
});

// ── extractCentralTransactionId ───────────────────────────────────────────────

describe("extractCentralTransactionId", () => {
  it("reconoce transaccionId (POST /transactions)", () => {
    expect(extractCentralTransactionId({ transaccionId: "tx-1" })).toBe("tx-1");
  });

  it("reconoce _id (GET /transactions)", () => {
    expect(extractCentralTransactionId({ _id: "tx-2" })).toBe("tx-2");
  });

  it("busca en estructuras anidadas", () => {
    expect(extractCentralTransactionId({ data: { transferId: "tx-3" } })).toBe("tx-3");
  });

  it("devuelve null si no hay ningún id reconocible", () => {
    expect(extractCentralTransactionId({ foo: 1 })).toBeNull();
    expect(extractCentralTransactionId(null)).toBeNull();
  });
});

// ── extractCentralAlias ───────────────────────────────────────────────────────

describe("extractCentralAlias", () => {
  it("encuentra y trimea el alias anidado", () => {
    expect(extractCentralAlias({ data: { alias: "  juan.perez  " } })).toBe("juan.perez");
  });

  it("devuelve null si no hay alias", () => {
    expect(extractCentralAlias({ foo: "bar" })).toBeNull();
    expect(extractCentralAlias(null)).toBeNull();
  });
});

// ── toSyncIssues ──────────────────────────────────────────────────────────────

describe("toSyncIssues", () => {
  it("cuenta lista: sin issues", () => {
    const issues = toSyncIssues({
      activa: true,
      nombre: "Juan",
      apellido: "Pérez",
      dni: "12345678",
    });
    expect(issues).toEqual([]);
  });

  it("marca cuenta inactiva", () => {
    const issues = toSyncIssues({ activa: false, nombre: "Juan", apellido: "Pérez", dni: "12345678" });
    expect(issues).toContain("La cuenta está inactiva.");
  });

  it("marca falta de nombre/apellido", () => {
    const issues = toSyncIssues({ activa: true, nombre: "", apellido: "", dni: "12345678" });
    expect(issues).toContain("La persona asociada no tiene nombre y apellido completos.");
  });

  it("marca DNI ausente", () => {
    const issues = toSyncIssues({ activa: true, nombre: "Juan", apellido: "Pérez", dni: null });
    expect(issues).toContain("La persona asociada no tiene DNI.");
  });

  it("marca DNI con largo inválido (< 7 o > 8)", () => {
    const corto = toSyncIssues({ activa: true, nombre: "Juan", apellido: "Pérez", dni: "123" });
    expect(corto).toContain("El DNI debe tener 7 u 8 dígitos para sincronizar con Brocoly.");

    const largo = toSyncIssues({ activa: true, nombre: "Juan", apellido: "Pérez", dni: "123456789" });
    expect(largo).toContain("El DNI debe tener 7 u 8 dígitos para sincronizar con Brocoly.");
  });

  it("acumula múltiples issues a la vez", () => {
    const issues = toSyncIssues({ activa: false, nombre: "", apellido: "", dni: "123" });
    expect(issues.length).toBe(3);
  });
});
