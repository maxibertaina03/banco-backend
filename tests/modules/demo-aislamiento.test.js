// El aislamiento del modo demo: que la plata de prueba no se mezcle con la real
// y que nada salga al Banco Central.
//
// La consigna de la cátedra es explícita: el usuario de prueba tiene que poder
// transferir "sin que impacte en el dinero real o en algo del banco". Estos
// tests cuidan las dos formas en que eso podría romperse:
//
//  1. Que una operación del demo llegue al Banco Central, que es un ambiente
//     compartido con todo el curso.
//  2. Que la plata cruce entre los dos mundos: que el demo acredite en la
//     cuenta de un cliente real, o que un cliente real le transfiera a una
//     cuenta que después se borra.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { createTransaccionesService } = await import('../../src/modules/transacciones-service.js');
const { crearSelectorDeCentral } = await import('../../src/modules/el-central.js');

const CUENTA_DEMO = {
  id: 'cuenta-demo', persona_id: 'persona-demo', cbu: '0060000000000000000001',
  moneda: 'ARS', saldo: '850000.00', activa: true, tipo_cuenta_id: 'tipo-1', es_demo: true,
};
const CUENTA_REAL = {
  id: 'cuenta-real', persona_id: 'persona-real', cbu: '0060000000000000000002',
  moneda: 'ARS', saldo: '10000.00', activa: true, tipo_cuenta_id: 'tipo-1', es_demo: false,
  nombre: 'Cliente', apellido: 'De Verdad',
};

const visitante = { id: 'u-demo', persona_id: 'persona-demo', roles: ['cliente'], es_demo: true };
const cliente = { id: 'u-real', persona_id: 'persona-real', roles: ['cliente'], es_demo: false };

/**
 * Arma el service con una base de mentira que devuelve la cuenta `destino`
 * cuando se busca por CBU, y registra todo lo que se ejecutó.
 */
function armar({ origen, destino }) {
  const ejecutadas = [];
  const query = vi.fn(async (sqlCrudo, params) => {
    const sql = String(sqlCrudo?.text || sqlCrudo).replace(/\s+/g, ' ').trim();
    ejecutadas.push({ sql, params });

    if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) return { rowCount: 0, rows: [] };
    if (/FROM cuentas c JOIN personas p ON p.id = c.persona_id WHERE c.cbu/i.test(sql)) {
      const cbuPedido = params?.[0];
      if (cbuPedido === origen.cbu) return { rowCount: 1, rows: [origen] };
      if (destino && cbuPedido === destino.cbu) return { rowCount: 1, rows: [destino] };
      return { rowCount: 0, rows: [] };
    }
    if (/FROM tipos_cuenta/i.test(sql)) return { rowCount: 1, rows: [{ limite_transferencia: null }] };
    if (/FROM tipos_transaccion/i.test(sql)) return { rowCount: 1, rows: [{ id: 'tipo-transferencia' }] };
    if (/UPDATE cuentas SET saldo = saldo -/i.test(sql)) return { rowCount: 1, rows: [{ id: origen.id }] };
    if (/INSERT INTO transacciones/i.test(sql)) {
      return { rowCount: 1, rows: [{ id: 'tx-1', monto: '1000.00', estado: 'completada', created_at: new Date() }] };
    }
    return { rowCount: 0, rows: [] };
  });

  const client = { query, release: vi.fn() };
  const pool = { connect: vi.fn().mockResolvedValue(client), query };

  // El Central REAL. Si alguno de estos espías se llama durante una operación
  // demo, el aislamiento se rompió.
  const centralReal = {
    crearTransaccion: vi.fn().mockResolvedValue({ data: { idTransaccion: 'REAL-1', cbu: destino?.cbu } }),
    findPersonByCbu: vi.fn(), findPersonByAlias: vi.fn(), getBankByCode: vi.fn(),
    extractCentralCbu: (d) => d?.cbu ?? null,
    extraerIdTransaccionCentral: (d) => d?.idTransaccion ?? null,
  };
  const centralSimulado = {
    crearTransaccion: vi.fn().mockResolvedValue({ data: { idTransaccion: 'demo-tx-1', cbu: destino?.cbu } }),
    findPersonByCbu: vi.fn(), findPersonByAlias: vi.fn(), getBankByCode: vi.fn(),
  };

  const service = createTransaccionesService({
    pool,
    centralBankService: centralReal,
    elCentral: crearSelectorDeCentral({ real: centralReal, simulado: centralSimulado }),
    escribirLogDeAuditoria: vi.fn().mockResolvedValue(undefined),
    monedas: {
      resolverMonedaDeCbu: vi.fn().mockResolvedValue(null),
      validarMonedasCompatibles: vi.fn().mockResolvedValue({ verificado: false }),
      validarEntrante: vi.fn(),
    },
  });

  return { service, client, ejecutadas, centralReal, centralSimulado };
}

/** Qué cuentas se acreditaron durante la operación. */
const acreditadas = (ejecutadas) =>
  ejecutadas.filter((q) => /UPDATE cuentas SET saldo = saldo \+/i.test(q.sql)).map((q) => q.params?.[1]);

/** El canal con el que quedó grabada la transferencia. */
function canalGrabado(ejecutadas) {
  const insert = ejecutadas.find((q) => /INSERT INTO transacciones/i.test(q.sql));
  // El orden de los parámetros lo fija insertarTransaccionDeTransferencia:
  // [tipo, origen, destino, monto, descripcion, estado, idCentral, canal, ...]
  return insert?.params?.[7];
}

async function transferir(service, { origen, usuarioActual, cbuDestino }) {
  return service.crearTransferenciaPorContrato({
    cbuOrigen: origen.cbu,
    cbuDestino,
    importe: 1000,
    saldoOrigen: null,
    descripcion: 'prueba',
    usuarioActual,
  });
}

describe('el demo no sale al Banco Central', () => {
  let armado;
  beforeEach(() => { armado = armar({ origen: CUENTA_DEMO, destino: null }); });

  it('una transferencia del visitante usa el Central simulado, nunca el real', async () => {
    const { service, centralReal, centralSimulado } = armado;
    await transferir(service, { origen: CUENTA_DEMO, usuarioActual: visitante, cbuDestino: '0080000000000000000009' })
      .catch(() => {});

    expect(centralSimulado.crearTransaccion).toHaveBeenCalled();
    // Lo que de verdad importa: ni una llamada al ambiente compartido.
    expect(centralReal.crearTransaccion).not.toHaveBeenCalled();
  });

  it('la de un cliente real sí va al Central de verdad', async () => {
    const otro = armar({ origen: CUENTA_REAL, destino: null });
    await transferir(otro.service, { origen: CUENTA_REAL, usuarioActual: cliente, cbuDestino: '0080000000000000000009' })
      .catch(() => {});

    expect(otro.centralReal.crearTransaccion).toHaveBeenCalled();
    expect(otro.centralSimulado.crearTransaccion).not.toHaveBeenCalled();
  });
});

describe('la plata no cruza entre los dos mundos', () => {
  it('el visitante NO acredita en la cuenta de un cliente real', async () => {
    // El caso que la consigna prohíbe: alguien tipea el CBU de un cliente de
    // verdad y le entra plata de verdad.
    const { service, ejecutadas } = armar({ origen: CUENTA_DEMO, destino: CUENTA_REAL });
    await transferir(service, { origen: CUENTA_DEMO, usuarioActual: visitante, cbuDestino: CUENTA_REAL.cbu })
      .catch(() => {});

    expect(acreditadas(ejecutadas)).not.toContain(CUENTA_REAL.id);
    // Y queda grabada como lo que es: una salida a otro banco, simulada.
    expect(canalGrabado(ejecutadas)).toBe('interbancaria_saliente');
  });

  it('un cliente real NO acredita en una cuenta de prueba', async () => {
    // El reverso: si acreditara, esa plata desaparecería cuando la sesión de
    // prueba se borre.
    const { service, ejecutadas } = armar({ origen: CUENTA_REAL, destino: CUENTA_DEMO });
    await transferir(service, { origen: CUENTA_REAL, usuarioActual: cliente, cbuDestino: CUENTA_DEMO.cbu })
      .catch(() => {});

    expect(acreditadas(ejecutadas)).not.toContain(CUENTA_DEMO.id);
  });

  it('entre dos cuentas del mismo mundo sí acredita, como siempre', async () => {
    const destinoReal = { ...CUENTA_REAL, id: 'otra-real', cbu: '0060000000000000000003' };
    const { service, ejecutadas } = armar({ origen: CUENTA_REAL, destino: destinoReal });
    await transferir(service, { origen: CUENTA_REAL, usuarioActual: cliente, cbuDestino: destinoReal.cbu })
      .catch(() => {});

    expect(acreditadas(ejecutadas)).toContain(destinoReal.id);
    expect(canalGrabado(ejecutadas)).toBe('local');
  });
});
