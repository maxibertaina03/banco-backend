const crypto = require('node:crypto');
const realPool = require('../db/pool');
const realLogger = require('../utils/logger');
const HttpError = require('../utils/http-error');
const movimientos = require('./movimientos');

/**
 * Sesiones de prueba.
 *
 * La cátedra pide un usuario al que se entre escaneando un QR, que ya tenga
 * cuenta con plata y movimientos, que pueda operar como un cliente cualquiera,
 * y que al cerrar la sesión no quede nada.
 *
 * La decisión de fondo: los datos del demo viven en las MISMAS tablas que los
 * de un cliente real. No es un descuido, es lo que hace que el visitante use el
 * sistema de verdad —las mismas validaciones, los mismos cálculos— en vez de
 * una maqueta. El aislamiento no lo da una base aparte: lo da el scoping por
 * `persona_id` que ya tienen todos los endpoints, más el borrado de acá abajo.
 */

/** Lo que vive una sesión sin tocarla. Alcanza para recorrer todo el banco. */
const DURACION_MS = 45 * 60 * 1000;

/** Rol cliente. Fijo y único: una sesión demo nunca puede ser interna. */
const ROL_CLIENTE = '11111111-1111-1111-1111-000000000002';

const SALDO_INICIAL_ARS = '850000.00';
const SALDO_INICIAL_USD = '1200.00';

/** Prefijo del token. Es lo que mira el middleware para saber por dónde entrar. */
const PREFIJO_TOKEN = 'orbdemo_';

/** 006 es Banco Orbital en el Banco Central. */
const CODIGO_BANCO = '006';

function hashDeToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/**
 * CBU inventado con nuestro prefijo.
 *
 * El CBU de una cuenta real lo asigna el Banco Central; el de una demo no puede
 * pedirse, así que se genera local. Misma idea que `generateCbu` en
 * relations-router, que es lo que hace el banco cuando el Central no responde.
 */
function cbuDemo() {
  const resto = crypto.randomBytes(10).readBigUInt64BE(0).toString().padStart(19, '0').slice(0, 19);
  return `${CODIGO_BANCO}${resto}`;
}

function numeroDeCuentaDemo() {
  return crypto.randomInt(10 ** 11, 10 ** 12 - 1).toString();
}

function createDemoService({ pool = realPool, logger = realLogger, duracionMs = DURACION_MS } = {}) {
  /**
   * Crea una sesión: la persona, sus cuentas, el historial y los productos.
   *
   * Todo en una transacción: o queda una sesión completa y usable, o no queda
   * nada. Una sesión a medias le mostraría al visitante un banco roto.
   */
  async function crearSesion({ ipOrigen = null } = {}) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const sufijo = crypto.randomBytes(4).toString('hex');
      const persona = (await client.query(
        `INSERT INTO personas (nombre, apellido, dni, email, telefono, perfil_completo, es_demo)
         VALUES ($1, $2, $3, $4, $5, TRUE, TRUE)
         RETURNING *`,
        [
          'Visitante',
          'de prueba',
          // DNI y email son UNIQUE. El DNI arranca en 99 para no chocar nunca
          // con uno real argentino, que no llega a esos números.
          `99${crypto.randomInt(100000, 999999)}`,
          `demo-${sufijo}@orbital.net.ar`,
          '1100000000',
        ]
      )).rows[0];

      // `usuarios.clerk_id` es NOT NULL UNIQUE: la sesión demo no tiene cuenta
      // en Clerk, así que lleva un id sintético con el mismo prefijo del token.
      const usuario = (await client.query(
        `INSERT INTO usuarios (persona_id, clerk_id, activo) VALUES ($1, $2, TRUE) RETURNING *`,
        [persona.id, `${PREFIJO_TOKEN}${sufijo}`]
      )).rows[0];

      await client.query(
        `INSERT INTO personas_roles (persona_id, rol_id) VALUES ($1, $2)
         ON CONFLICT (persona_id, rol_id) DO NOTHING`,
        [persona.id, ROL_CLIENTE]
      );

      const tipoCuenta = (await client.query('SELECT id FROM tipos_cuenta LIMIT 1')).rows[0];
      if (!tipoCuenta) throw new HttpError(500, 'No hay tipos de cuenta configurados.');

      const cuentaArs = await crearCuenta(client, persona.id, tipoCuenta.id, 'ARS', SALDO_INICIAL_ARS, true);
      const cuentaUsd = await crearCuenta(client, persona.id, tipoCuenta.id, 'USD', SALDO_INICIAL_USD, false);

      await sembrarHistorial(client, cuentaArs, cuentaUsd);
      await sembrarAgenda(client, persona.id);

      const token = `${PREFIJO_TOKEN}${crypto.randomBytes(32).toString('hex')}`;
      const sesion = (await client.query(
        `INSERT INTO demo_sesiones (token_hash, persona_id, expira_at, ip_origen)
         VALUES ($1, $2, NOW() + ($3 || ' milliseconds')::interval, $4)
         RETURNING id, creada_at, expira_at`,
        [hashDeToken(token), persona.id, String(duracionMs), ipOrigen]
      )).rows[0];

      await client.query('COMMIT');
      logger.info({ subsystem: 'demo', sesion: sesion.id }, 'sesión de prueba creada');

      // El token se devuelve UNA sola vez: la base guarda nada más el hash.
      return { token, expira_at: sesion.expira_at, persona_id: persona.id, usuario_id: usuario.id };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function crearCuenta(client, personaId, tipoCuentaId, moneda, saldo, principal) {
    const r = await client.query(
      `INSERT INTO cuentas
         (persona_id, tipo_cuenta_id, numero_cuenta, cbu, alias, saldo, moneda, principal, activa, banco_central_registrada)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE, FALSE)
       RETURNING *`,
      [
        personaId,
        tipoCuentaId,
        numeroDeCuentaDemo(),
        cbuDemo(),
        // El alias es UNIQUE en toda la tabla: lleva sufijo para no chocar.
        moneda === 'ARS' ? `demo.${crypto.randomBytes(3).toString('hex')}` : null,
        saldo,
        moneda,
        principal,
      ]
    );
    return r.rows[0];
  }

  /**
   * El historial.
   *
   * Sin movimientos, el extracto, los gastos del mes y el resumen se ven vacíos
   * y no se puede "conocer el sistema", que es lo que pide la consigna. Son
   * movimientos de los últimos dos meses, con los tipos y canales que ya existen
   * en el catálogo: nada inventado para el demo.
   *
   * Los montos no se suman al saldo: el saldo ya arranca en su valor final y
   * estos movimientos son el relato de cómo llegó ahí.
   */
  async function sembrarHistorial(client, cuentaArs, cuentaUsd) {
    const guion = [
      { dias: 58, tipo: 'deposito', canal: 'deposito_efectivo', monto: '620000.00', desc: 'Acreditación de haberes', entra: true },
      { dias: 55, tipo: 'pago', canal: 'pago_servicio', monto: '48350.00', desc: 'Pago de Edenor', entra: false },
      { dias: 52, tipo: 'transferencia', canal: 'interbancaria_saliente', monto: '35000.00', desc: 'Transferencia a Martín', entra: false },
      { dias: 44, tipo: 'pago', canal: 'recarga_celular', monto: '6000.00', desc: 'Recarga Movistar', entra: false },
      { dias: 38, tipo: 'consumo_tarjeta', canal: 'consumo_tarjeta', monto: '27480.00', desc: 'Supermercado', entra: false },
      { dias: 30, tipo: 'transferencia', canal: 'interbancaria_entrante', monto: '120000.00', desc: 'Transferencia recibida', entra: true },
      { dias: 28, tipo: 'deposito', canal: 'deposito_efectivo', monto: '620000.00', desc: 'Acreditación de haberes', entra: true },
      { dias: 21, tipo: 'pago', canal: 'pago_servicio', monto: '31200.00', desc: 'Pago de Metrogas', entra: false },
      { dias: 15, tipo: 'transferencia', canal: 'local', monto: '18000.00', desc: 'Transferencia a Lucía', entra: false },
      { dias: 9, tipo: 'consumo_tarjeta', canal: 'consumo_tarjeta', monto: '54900.00', desc: 'Farmacia', entra: false },
      { dias: 4, tipo: 'transferencia', canal: 'interbancaria_entrante', monto: '75000.00', desc: 'Transferencia recibida', entra: true },
      { dias: 2, tipo: 'bonificacion', canal: 'bonificacion', monto: '5000.00', desc: 'Bonificación de bienvenida', entra: true },
    ];

    for (const m of guion) {
      const fila = await movimientos.registrar(client, {
        cuentaId: cuentaArs.id,
        cbu: cuentaArs.cbu,
        monto: m.monto,
        tipo: m.tipo,
        canal: m.canal,
        descripcion: m.desc,
        entra: m.entra,
      });
      // `registrar` no acepta fecha: se corrige después para que el extracto
      // no muestre doce movimientos del mismo minuto.
      await client.query(
        `UPDATE transacciones SET created_at = NOW() - ($1 || ' days')::interval WHERE id = $2`,
        [String(m.dias), fila.id]
      );
    }

    // Una compra de dólares, para que la caja en USD tenga de dónde venir.
    const compra = await movimientos.registrar(client, {
      cuentaId: cuentaUsd.id,
      cbu: cuentaUsd.cbu,
      monto: SALDO_INICIAL_USD,
      tipo: 'cambio',
      canal: 'cambio_divisa',
      descripcion: 'Compra de dólares',
      entra: true,
    });
    await client.query(
      `UPDATE transacciones SET created_at = NOW() - interval '12 days' WHERE id = $1`,
      [compra.id]
    );
  }

  /**
   * La agenda de destinatarios.
   *
   * Son CBU con prefijo de otro banco a propósito: así una transferencia desde
   * el demo sale por el camino interbancario, que es el que el Central simulado
   * atiende, y nunca acredita en la cuenta de un cliente real de Orbital.
   */
  async function sembrarAgenda(client, personaId) {
    const contactos = [
      { alias: 'martin.gomez.demo', banco: 'Banco de prueba' },
      { alias: 'lucia.fernandez.demo', banco: 'Banco de prueba' },
      { alias: 'taller.mecanico.demo', banco: 'Banco de prueba' },
    ];
    for (const c of contactos) {
      await client.query(
        `INSERT INTO destinatarios (persona_id, alias, cbu_externo, banco_externo) VALUES ($1, $2, $3, $4)`,
        [personaId, c.alias, `008${crypto.randomBytes(8).readBigUInt64BE(0).toString().padStart(19, '0').slice(0, 19)}`, c.banco]
      );
    }
  }

  /** Busca una sesión viva por su token. Devuelve null si no existe o venció. */
  async function buscarSesionViva(token) {
    const r = await pool.query(
      `SELECT s.id, s.persona_id, s.expira_at,
              u.id AS usuario_id, u.clerk_id, u.activo, u.created_at,
              p.nombre, p.apellido, p.email, p.perfil_completo
         FROM demo_sesiones s
         JOIN personas p ON p.id = s.persona_id
         JOIN usuarios u ON u.persona_id = s.persona_id
        WHERE s.token_hash = $1
          AND s.cerrada_at IS NULL
          AND s.expira_at > NOW()
        LIMIT 1`,
      [hashDeToken(token)]
    );
    return r.rows[0] || null;
  }

  /**
   * Borra una sesión y todo lo que generó.
   *
   * El orden no es decorativo. Borrar la persona cascadea a usuarios, roles,
   * cuentas, destinatarios, tarjetas, préstamos y plazos fijos, pero FALLA
   * contra `bonificaciones` (RESTRICT), `transacciones` (NO ACTION), `cobros`
   * (RESTRICT) y las FK de préstamos y plazos fijos hacia `cuentas` (RESTRICT).
   * Por eso se limpia de adentro hacia afuera. Mismo problema y misma solución
   * que en migrations/20260528_solo_caja_ahorro.sql.
   *
   * Todo en una transacción: una limpieza a medias deja huérfanos en las tablas
   * de un banco de verdad.
   */
  async function borrarSesion(personaId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const cuentas = `(SELECT id FROM cuentas WHERE persona_id = $1)`;

      await client.query(`DELETE FROM cobros WHERE cuenta_destino_id IN ${cuentas}`, [personaId]);
      await client.query('DELETE FROM bonificaciones WHERE persona_id = $1', [personaId]);
      await client.query(
        `DELETE FROM transacciones
          WHERE cuenta_origen_id IN ${cuentas} OR cuenta_destino_id IN ${cuentas}`,
        [personaId]
      );
      await client.query('DELETE FROM plazos_fijos WHERE persona_id = $1', [personaId]);
      await client.query('DELETE FROM prestamos WHERE persona_id = $1', [personaId]);
      await client.query('DELETE FROM cuentas WHERE persona_id = $1', [personaId]);
      // Lo que queda —usuarios, roles, destinatarios, tarjetas, la sesión—
      // se va en cascada con la persona.
      const r = await client.query('DELETE FROM personas WHERE id = $1 AND es_demo = TRUE RETURNING id', [personaId]);

      await client.query('COMMIT');
      // El `es_demo = TRUE` del WHERE es el seguro: si alguna vez a esta función
      // le llegara el id de una persona real, no borra nada.
      if (r.rowCount === 0) {
        logger.warn({ subsystem: 'demo', personaId }, 'no se borró: la persona no existe o no es de prueba');
      }
      return r.rowCount;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** Cierra las sesiones vencidas y borra sus datos. */
  async function barrerVencidas() {
    const r = await pool.query(
      `SELECT persona_id FROM demo_sesiones
        WHERE cerrada_at IS NULL AND expira_at <= NOW()`
    );
    let borradas = 0;
    for (const fila of r.rows) {
      borradas += await borrarSesion(fila.persona_id);
    }
    return borradas;
  }

  return { crearSesion, buscarSesionViva, borrarSesion, barrerVencidas };
}

const defaultService = createDemoService();

module.exports = {
  ...defaultService,
  createDemoService,
  hashDeToken,
  PREFIJO_TOKEN,
  DURACION_MS,
};
