import { describe, expect, it } from 'vitest';

const { MOCK_CREDIT_PROFILES } = await import('../../src/modules/credit-profile-service.js');
const { createCreditCardEligibilityService } = await import('../../src/modules/credit-card-eligibility-service.js');

const service = createCreditCardEligibilityService({ now: () => new Date('2026-10-02T12:00:00.000Z') });

describe('credit-card-eligibility-service', () => {
  it('aprueba el perfil apto', () => {
    const result = service.evaluar(MOCK_CREDIT_PROFILES.apto);
    expect(result.apto).toBe(true);
    expect(result.criterios.every((criterio) => criterio.cumple)).toBe(true);
  });

  it('informa los faltantes del perfil cercano y estima solo el criterio temporal', () => {
    const result = service.evaluar(MOCK_CREDIT_PROFILES.cerca);
    expect(result.apto).toBe(false);
    expect(result.criterios.filter((criterio) => !criterio.cumple).map((criterio) => criterio.nombre))
      .toEqual(['Antiguedad como cliente']);
    expect(result.criterios.find((criterio) => !criterio.cumple).diferencia).toContain('falta 1 mes');
    expect(result.proximaFechaEstimada).toBe('2026-11-02');
  });

  it('no estima fechas para el perfil claramente no apto', () => {
    const result = service.evaluar(MOCK_CREDIT_PROFILES.noApto);
    expect(result.apto).toBe(false);
    expect(result.criterios.filter((criterio) => !criterio.cumple).length).toBeGreaterThan(1);
    expect(result.proximaFechaEstimada).toBeNull();
    expect(result.recomendaciones.length).toBeGreaterThan(1);
  });

  it('considera aptos los valores exactamente en los minimos', () => {
    const result = service.evaluar({
      ...MOCK_CREDIT_PROFILES.apto,
      edad: 18,
      situacionBcra: 1,
      scoreCrediticio: 600,
      ingresoMensualNeto: 400000,
      antiguedadComoClienteMeses: 3,
      antiguedadLaboralMeses: 6,
      deudaMensualTotal: 140000,
    });
    expect(result.apto).toBe(true);
  });

  it('identifica un solo criterio faltante con su diferencia exacta', () => {
    const result = service.evaluar({ ...MOCK_CREDIT_PROFILES.apto, scoreCrediticio: 599 });
    const pending = result.criterios.filter((criterio) => !criterio.cumple);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      nombre: 'Score crediticio minimo',
      valorActual: 599,
      valorRequerido: 600,
      diferencia: 'falta 1 punto de score',
    });
    expect(result.proximaFechaEstimada).toBeNull();
  });

  it('describe todos los criterios faltantes sin estimar una fecha', () => {
    const result = service.evaluar({
      edad: 16,
      situacionBcra: 5,
      scoreCrediticio: 0,
      ingresoMensualNeto: 0,
      antiguedadComoClienteMeses: 0,
      antiguedadLaboralMeses: 0,
      deudaMensualTotal: 500000,
      diasMoraMaxima12Meses: 90,
      cantidadChequesRechazados12Meses: 4,
    });
    expect(result.criterios.every((criterio) => !criterio.cumple)).toBe(true);
    expect(result.recomendaciones).toHaveLength(result.criterios.length);
    expect(result.proximaFechaEstimada).toBeNull();
  });

  it('permite evaluar tipos agregados solo en la configuracion', () => {
    const configuredService = createCreditCardEligibilityService({
      rulesConfig: {
        ...require('../../src/config/credit-card-rules.json'),
        tarjetaGold: { ...require('../../src/config/credit-card-rules.json').tarjetaClasica, scoreMinimo: 700 },
      },
    });
    expect(configuredService.evaluar(MOCK_CREDIT_PROFILES.apto, 'tarjetaGold').apto).toBe(true);
  });
});