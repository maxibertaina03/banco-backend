// El pago de un QR: el camino que mueve la plata.
//
// Existe por un agujero real: una transferencia común pasa por
// `validarLimiteDeTransferencia`, que compara el monto contra el
// `limite_transferencia` del tipo de cuenta (Caja de Ahorro: $500.000). El pago
// por QR no lo hacía. Su único techo era el MAX_QR_AMOUNT del router, que es un
// millón, así que por QR se movía el doble de lo que el banco permite por el
// formulario de siempre.
//
// El router no se construye con dependencias inyectadas: hace `require` de la
// base y de Clerk al cargarse, y se exporta ya armado. Para poder ejercitarlo
// sin tocar Supabase ni Clerk, se siembra el `require.cache` con dobles ANTES
// de pedirlo. Es lo que hace `montarRouter()`.

import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
// En Node 18 `crypto` no es global.
import { randomUUID } from 'node:crypto';
import express from 'express';

const require_ = createRequire(import.meta.url);
const RAIZ = new URL('../../', import.meta.url).pathname;

// `src/config/env.js` se lee al cargar el router: sin DATABASE_URL explota, y
// sin CLERK_PUBLISHABLE_KEY el router contesta 503 a todo. No se conecta a
// ninguna de las dos: la base es un doble y Clerk también.
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.CLERK_PUBLISHABLE_KEY ||= 'pk_test_para_los_tests';

const PERSONA_PAGADOR = 'persona-paga';
const CUENTA_PAGADOR = 'cuenta-paga';
const CUENTA_COBRADOR = 'cuenta-cobra';
const TIPO_CAJA_DE_AHORRO = 'tipo-caja';

/** Reemplaza un módulo por un doble, antes de que nadie lo pida. */
function sembrar(ruta, exports) {
  const id = require_.resolve(ruta);
  require_.cache[id] = { id, filename: id, loaded: true, exports };
}

/**
 * Un cliente de pg de mentira. Responde lo que cada consulta del router
 * necesita y anota todo, para después poder afirmar qué se ejecutó.
 */
function armarBase({ montoDelCobro, limiteDeTransferencia, estadoDelCobro = 'pendiente' }) {
  const ejecutadas = [];

  const cuenta = (id, personaId) => ({
    id,
    persona_id: personaId,
    tipo_cuenta_id: TIPO_CAJA_DE_AHORRO,
    moneda: 'ARS',
    activa: true,
    principal: true,
    cbu: `006000193011122200040${id.length}`,
    nombre: 'Quien',
    apellido: 'Sea',
  });

  const query = async (sqlCrudo, params) => {
    const sql = sqlCrudo.replace(/\s+/g, ' ').trim();
    ejecutadas.push({ sql, params });

    if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) return { rowCount: 0, rows: [] };
    if (/FROM cobros WHERE id/i.test(sql)) {
      return {
        rowCount: 1,
        rows: [{
          id: 'cobro-1',
          cuenta_destino_id: CUENTA_COBRADOR,
          monto: montoDelCobro,
          estado: estadoDelCobro,
          expira_at: new Date(Date.now() + 600_000).toISOString(),
        }],
      };
    }
    if (/SELECT id FROM cuentas WHERE persona_id/i.test(sql)) {
      return { rowCount: 1, rows: [{ id: CUENTA_PAGADOR }] };
    }
    if (/FROM cuentas c JOIN personas p/i.test(sql)) {
      return {
        rowCount: 2,
        rows: [cuenta(CUENTA_PAGADOR, PERSONA_PAGADOR), cuenta(CUENTA_COBRADOR, 'persona-cobra')],
      };
    }
    if (/MAX\(limite_transferencia\)/i.test(sql)) {
      return { rowCount: 1, rows: [{ maximo: limiteDeTransferencia }] };
    }
    if (/FROM tipos_cuenta/i.test(sql)) {
      return { rowCount: 1, rows: [{ limite_transferencia: limiteDeTransferencia }] };
    }
    if (/FROM cuentas c WHERE c.persona_id/i.test(sql) || /SELECT c.id, c.persona_id/i.test(sql)) {
      return { rowCount: 1, rows: [{ id: CUENTA_COBRADOR, persona_id: 'persona-cobra' }] };
    }
    if (/INSERT INTO cobros/i.test(sql)) {
      return {
        rowCount: 1,
        rows: [{ id: 'cobro-1', monto: params[1], estado: 'pendiente', expira_at: new Date().toISOString(), creado_at: new Date().toISOString() }],
      };
    }
    if (/FROM tipos_transaccion/i.test(sql)) return { rowCount: 1, rows: [{ id: 'tipo-transferencia' }] };
    if (/UPDATE cuentas SET saldo = saldo -/i.test(sql)) return { rowCount: 1, rows: [{ id: CUENTA_PAGADOR }] };
    if (/INSERT INTO transacciones/i.test(sql)) {
      return { rowCount: 1, rows: [{ id: 'tx-1', monto: montoDelCobro, estado: 'completada', created_at: new Date().toISOString() }] };
    }
    return { rowCount: 0, rows: [] };
  };

  const pool = {
    query,
    connect: async () => ({ query, release() {} }),
  };
  return { pool, ejecutadas };
}

function montarRouter(base) {
  // Cada test necesita el router recién cargado, con SUS dobles.
  for (const id of Object.keys(require_.cache)) {
    if (id.startsWith(RAIZ + 'src/')) delete require_.cache[id];
  }

  sembrar('@clerk/express', {
    clerkMiddleware: () => (_req, _res, next) => next(),
    // `has({ reverification })` en true: la reverificación de Clerk es otro
    // asunto y acá estorba.
    getAuth: () => ({ userId: 'clerk_1', has: () => true }),
  });
  sembrar(RAIZ + 'src/db/pool.js', base.pool);
  sembrar(RAIZ + 'src/middlewares/require-active-user.js', (req, _res, next) => {
    req.usuarioActual = { id: 'usuario-1', persona_id: PERSONA_PAGADOR };
    next();
  });
  sembrar(RAIZ + 'src/middlewares/require-complete-profile.js', (_req, _res, next) => next());
  sembrar(RAIZ + 'src/middlewares/idempotency.js', () => (_req, _res, next) => next());

  const router = require_(RAIZ + 'src/modules/cobros-router.js');
  const app = express();
  app.use(express.json());
  app.use('/api/transferencias', router.transferencias);
  app.use('/api/cobros', router.cobros);
  app.use((error, _req, res, _next) =>
    res.status(error.status || 500).json({ error: error.message }));
  return app;
}

async function pagar(app, { clave = randomUUID() } = {}) {
  const server = app.listen(0);
  try {
    const respuesta = await fetch(`http://127.0.0.1:${server.address().port}/api/transferencias`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': clave },
      body: JSON.stringify({ cobro_id: '11111111-1111-4111-8111-111111111111' }),
    });
    return { status: respuesta.status, body: await respuesta.json() };
  } finally {
    server.close();
  }
}

async function crearCobro(app, monto) {
  const server = app.listen(0);
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/cobros`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ monto }),
    });
    return { status: r.status, body: await r.json() };
  } finally {
    server.close();
  }
}

const seCreoElCobro = (ejecutadas) => ejecutadas.some((q) => /INSERT INTO cobros/i.test(q.sql));

const seDebito = (ejecutadas) => ejecutadas.some((q) => /UPDATE cuentas SET saldo = saldo -/i.test(q.sql));

describe('pago de un cobro por QR', () => {
  it('rechaza un monto que supera el límite de la cuenta, y no toca el saldo', async () => {
    // $600.000 por QR contra una Caja de Ahorro que permite $500.000.
    const base = armarBase({ montoDelCobro: '600000.00', limiteDeTransferencia: '500000.00' });
    const { status, body } = await pagar(montarRouter(base));

    expect(status).toBe(400);
    expect(body.error).toMatch(/supera el límite de transferencia/i);
    // Lo que importa de verdad: la plata no se movió.
    expect(seDebito(base.ejecutadas)).toBe(false);
  });

  it('deja pasar un monto dentro del límite', async () => {
    const base = armarBase({ montoDelCobro: '400000.00', limiteDeTransferencia: '500000.00' });
    const { status } = await pagar(montarRouter(base));

    expect(status).toBe(201);
    expect(seDebito(base.ejecutadas)).toBe(true);
  });

  it('el límite se mide contra la cuenta que PAGA, no contra el tope del QR', async () => {
    // El router tiene un MAX_QR_AMOUNT de un millón. Ese no es el límite que
    // manda: manda el del tipo de cuenta, aunque sea más chico.
    const base = armarBase({ montoDelCobro: '900000.00', limiteDeTransferencia: '500000.00' });
    const { status } = await pagar(montarRouter(base));

    expect(status).toBe(400);
    expect(seDebito(base.ejecutadas)).toBe(false);
  });

  it('sin límite configurado, no inventa uno', async () => {
    const base = armarBase({ montoDelCobro: '900000.00', limiteDeTransferencia: null });
    const { status } = await pagar(montarRouter(base));

    expect(status).toBe(201);
    expect(seDebito(base.ejecutadas)).toBe(true);
  });

  it('un QR ya pagado no se puede volver a pagar', async () => {
    const base = armarBase({ montoDelCobro: '1000.00', limiteDeTransferencia: '500000.00', estadoDelCobro: 'pagado' });
    const { status, body } = await pagar(montarRouter(base));

    expect(status).toBe(409);
    expect(body.error).toMatch(/ya fue pagado/i);
    expect(seDebito(base.ejecutadas)).toBe(false);
  });

  it('exige una Idempotency-Key: sin ella no se mueve plata', async () => {
    const base = armarBase({ montoDelCobro: '1000.00', limiteDeTransferencia: '500000.00' });
    const app = montarRouter(base);
    const server = app.listen(0);
    try {
      const r = await fetch(`http://127.0.0.1:${server.address().port}/api/transferencias`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cobro_id: '11111111-1111-4111-8111-111111111111' }),
      });
      expect(r.status).toBe(400);
    } finally {
      server.close();
    }
    expect(seDebito(base.ejecutadas)).toBe(false);
  });

  // ── Generar el QR ────────────────────────────────────────────────────────

  it('no deja generar un QR que después nadie va a poder pagar', async () => {
    // El límite de transferencia es de la cuenta que PAGA, así que antes esto
    // recién saltaba al confirmar: el cobrador armaba el QR, se lo mostraba al
    // otro, y el otro se comía el error.
    const base = armarBase({ montoDelCobro: '0', limiteDeTransferencia: '500000.00' });
    const { status, body } = await crearCobro(montarRouter(base), 800000);

    expect(status).toBe(400);
    expect(body.error).toMatch(/máximo que se puede cobrar por QR/i);
    expect(seCreoElCobro(base.ejecutadas)).toBe(false);
  });

  it('deja generar hasta el límite más alto del banco', async () => {
    const base = armarBase({ montoDelCobro: '0', limiteDeTransferencia: '500000.00' });
    const { status } = await crearCobro(montarRouter(base), 500000);

    expect(status).toBe(201);
    expect(seCreoElCobro(base.ejecutadas)).toBe(true);
  });

  it('sin ningún límite configurado, no inventa un techo', async () => {
    const base = armarBase({ montoDelCobro: '0', limiteDeTransferencia: null });
    const { status } = await crearCobro(montarRouter(base), 900000);

    expect(status).toBe(201);
    expect(seCreoElCobro(base.ejecutadas)).toBe(true);
  });
});
