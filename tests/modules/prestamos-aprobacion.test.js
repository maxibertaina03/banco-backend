// El circuito de aprobación de préstamos.
//
// Antes, quien tenía mala situación en la Central de Deudores recibía un 403 y
// ahí terminaba: nadie del banco podía mirar el caso. Ahora esa solicitud queda
// esperando a un gerente, que decide y deja escrito por qué.
//
// Lo que estos tests cuidan: que la plata NO se mueva mientras el préstamo
// espera, que se mueva exactamente una vez al aprobarlo, y que una decisión no
// pueda quedar sin explicación.

import { describe, expect, it, vi } from 'vitest';

const { createPrestamosService } = await import('../../src/modules/prestamos-service.js');

const CUENTA = {
  id: 'cuenta-1',
  persona_id: 'persona-1',
  moneda: 'ARS',
  activa: true,
  dni: '30111222',
  cbu: '0060001930111222000402',
};

/**
 * Un pool de mentira que responde lo que cada consulta necesita.
 * `escrituras` guarda todo lo que se ejecutó, para poder afirmar sobre ello.
 */
function armarPool({ prestamoExistente = null } = {}) {
  const escrituras = [];

  const responder = async (sqlCrudo, params) => {
    // Normalizar primero: el SQL del servicio viene con saltos de línea y
    // sangría, y las expresiones de abajo esperan espacios simples.
    const sql = sqlCrudo.replace(/\s+/g, ' ').trim();
    escrituras.push({ sql, params });

    if (/FROM cuentas c JOIN personas p/i.test(sql)) return { rowCount: 1, rows: [CUENTA] };
    if (/FROM tipos_transaccion/i.test(sql)) return { rowCount: 1, rows: [{ id: 'tipo-prestamo' }] };
    if (/SELECT cbu FROM cuentas/i.test(sql)) return { rowCount: 1, rows: [{ cbu: CUENTA.cbu }] };
    if (/INSERT INTO prestamos/i.test(sql)) {
      const [, , , capital, cuotas] = params;
      return {
        rowCount: 1,
        rows: [{
          id: 'prestamo-1', persona_id: CUENTA.persona_id, cuenta_id: CUENTA.id,
          capital, cuotas, estado: params[13], situacion_al_solicitar: params[14],
          saldo_deuda: params[11],
        }],
      };
    }
    if (/FROM prestamos pr JOIN personas p/i.test(sql)) {
      return prestamoExistente
        ? { rowCount: 1, rows: [{ ...prestamoExistente, dni: CUENTA.dni }] }
        : { rowCount: 0, rows: [] };
    }
    if (/UPDATE prestamos/i.test(sql)) {
      return { rowCount: 1, rows: [{ id: 'prestamo-1', estado: params[0], saldo_deuda: params[1], motivo_revision: params[3] }] };
    }
    return { rowCount: 0, rows: [] };
  };

  const client = { query: vi.fn(responder), release: vi.fn() };
  const pool = { query: vi.fn(responder), connect: vi.fn().mockResolvedValue(client) };
  return { pool, client, escrituras };
}

function armar({ situacion = 1, centralFalla = false, prestamoExistente = null } = {}) {
  const { pool, escrituras } = armarPool({ prestamoExistente });
  const riesgoCrediticio = {
    consultarSituacion: centralFalla
      ? vi.fn().mockRejectedValue(new Error('el Banco Central no responde'))
      : vi.fn().mockResolvedValue({ situacion, descripcion: 'x', deudas: [] }),
    verificarPuedeOperar: vi.fn(),
  };
  const servicio = createPrestamosService({
    pool,
    riesgoCrediticio,
    mercado: { obtenerTasasReferencia: vi.fn().mockResolvedValue({ prestamos: { tna: 72 } }) },
    centralBankService: { informarDeuda: vi.fn() },
    escribirLogDeAuditoria: vi.fn(),
  });
  return { servicio, escrituras, riesgoCrediticio };
}

/** ¿Se ejecutó una acreditación en la cuenta del cliente? */
function huboAcreditacion(escrituras) {
  return escrituras.some((e) => /INSERT INTO transacciones|UPDATE cuentas SET saldo/i.test(e.sql));
}

describe('al pedir un préstamo', () => {
  it('con situación 1 se aprueba solo y la plata se acredita', async () => {
    const { servicio, escrituras } = armar({ situacion: 1 });

    const prestamo = await servicio.otorgar({ cuentaId: CUENTA.id, capital: 50000, cuotas: 6 });

    expect(prestamo.estado).toBe('vigente');
    expect(prestamo.requiere_revision).toBe(false);
    expect(huboAcreditacion(escrituras)).toBe(true);
  });

  it('con situación 3 queda esperando al gerente y NO se acredita nada', async () => {
    const { servicio, escrituras } = armar({ situacion: 3 });

    const prestamo = await servicio.otorgar({ cuentaId: CUENTA.id, capital: 50000, cuotas: 6 });

    expect(prestamo.estado).toBe('pendiente_revision');
    expect(prestamo.requiere_revision).toBe(true);
    // Lo importante: el cliente no recibió un peso todavía.
    expect(huboAcreditacion(escrituras)).toBe(false);
  });

  it('deja el saldo de deuda en cero mientras espera', async () => {
    const { servicio } = armar({ situacion: 4 });

    const prestamo = await servicio.otorgar({ cuentaId: CUENTA.id, capital: 50000, cuotas: 6 });

    // Si quedara con deuda, aparecería como pasivo del cliente sin que el banco
    // le haya entregado nada.
    expect(Number(prestamo.saldo_deuda)).toBe(0);
  });

  it('si el Banco Central no responde, también va a revisión', async () => {
    // Otorgar a ciegas es peor que hacer esperar.
    const { servicio, escrituras } = armar({ centralFalla: true });

    const prestamo = await servicio.otorgar({ cuentaId: CUENTA.id, capital: 50000, cuotas: 6 });

    expect(prestamo.estado).toBe('pendiente_revision');
    expect(prestamo.situacion_al_solicitar).toBeNull();
    expect(huboAcreditacion(escrituras)).toBe(false);
  });

  it('guarda la situación que tenía el cliente ese día', async () => {
    const { servicio } = armar({ situacion: 3 });

    const prestamo = await servicio.otorgar({ cuentaId: CUENTA.id, capital: 50000, cuotas: 6 });

    // Dentro de seis meses puede ser otra; para entender la decisión hace falta
    // saber cuál era al momento de pedir.
    expect(prestamo.situacion_al_solicitar).toBe(3);
  });
});

describe('cuando el gerente resuelve', () => {
  const PENDIENTE = {
    id: 'prestamo-1', persona_id: 'persona-1', cuenta_id: CUENTA.id,
    capital: '50000.00', cuotas: 6, estado: 'pendiente_revision',
  };

  it('al aprobar, acredita la plata y lo deja vigente', async () => {
    const { servicio, escrituras } = armar({ prestamoExistente: PENDIENTE });

    const resuelto = await servicio.resolverSolicitud({
      prestamoId: 'prestamo-1',
      aprobar: true,
      motivo: 'Cliente histórico, la deuda informada corresponde a un tercero.',
      usuarioActual: { id: 'u-gerente' },
    });

    expect(resuelto.estado).toBe('vigente');
    expect(huboAcreditacion(escrituras)).toBe(true);
  });

  it('al rechazar, no toca la cuenta', async () => {
    const { servicio, escrituras } = armar({ prestamoExistente: PENDIENTE });

    const resuelto = await servicio.resolverSolicitud({
      prestamoId: 'prestamo-1',
      aprobar: false,
      motivo: 'La situación en la Central no permite otorgar en este momento.',
      usuarioActual: { id: 'u-gerente' },
    });

    expect(resuelto.estado).toBe('rechazado');
    expect(Number(resuelto.saldo_deuda)).toBe(0);
    expect(huboAcreditacion(escrituras)).toBe(false);
  });

  it('exige un motivo escrito: una excepción sin explicación no se puede defender', async () => {
    const { servicio } = armar({ prestamoExistente: PENDIENTE });

    await expect(
      servicio.resolverSolicitud({ prestamoId: 'prestamo-1', aprobar: true, motivo: 'ok', usuarioActual: { id: 'u' } })
    ).rejects.toMatchObject({ status: 400 });

    await expect(
      servicio.resolverSolicitud({ prestamoId: 'prestamo-1', aprobar: true, motivo: '   ', usuarioActual: { id: 'u' } })
    ).rejects.toMatchObject({ status: 400 });
  });

  it('no deja resolver dos veces el mismo préstamo', async () => {
    // El segundo gerente encuentra el préstamo ya vigente: sin esto, la plata
    // se acreditaría dos veces.
    const { servicio } = armar({ prestamoExistente: { ...PENDIENTE, estado: 'vigente' } });

    await expect(
      servicio.resolverSolicitud({
        prestamoId: 'prestamo-1',
        aprobar: true,
        motivo: 'Aprobado por gerencia, segundo intento.',
        usuarioActual: { id: 'u' },
      })
    ).rejects.toMatchObject({ status: 409 });
  });

  it('avisa si el préstamo no existe', async () => {
    const { servicio } = armar({ prestamoExistente: null });

    await expect(
      servicio.resolverSolicitud({
        prestamoId: 'no-existe',
        aprobar: true,
        motivo: 'Aprobado por gerencia tras revisar el legajo.',
        usuarioActual: { id: 'u' },
      })
    ).rejects.toMatchObject({ status: 404 });
  });
});
