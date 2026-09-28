// Niveles de tarjeta de crédito.
//
// Hasta acá el cliente elegía su propio límite, que es justo lo que un banco no
// hace: el límite lo define el banco según el perfil de quien la pide. Cada
// nivel tiene su límite, sus beneficios y sus requisitos.
//
// Los requisitos se miden con lo que el sistema conoce de verdad:
//   - La situación en la Central de Deudores del Banco Central (1 a 5).
//   - El patrimonio: la suma de los saldos, con los dólares valuados a la
//     cotización de compra (lo que el banco pagaría por ellos).
//
// Nada de "ingresos declarados": no tenemos forma de verificarlos.

// Situación 3 o peor ya bloquea préstamos y apertura de cuentas; una tarjeta de
// crédito es la misma clase de riesgo.
const SITUACION_BLOQUEANTE = 3;

const NIVELES = [
  {
    nivel: 'standard',
    nombre: 'Standard',
    limite: 300000,
    situacionMaxima: 2,
    patrimonioMinimo: 0,
    beneficios: [
      'Compras en hasta 12 cuotas',
      'Resumen mensual y control de consumos desde el portal',
    ],
  },
  {
    nivel: 'gold',
    nombre: 'Gold',
    limite: 1500000,
    situacionMaxima: 1,
    patrimonioMinimo: 500000,
    beneficios: [
      'Todo lo de Standard',
      'Seguro de viaje básico',
      'Asistencia automotriz',
    ],
  },
  {
    nivel: 'platinum',
    nombre: 'Platinum',
    limite: 5000000,
    situacionMaxima: 1,
    patrimonioMinimo: 3000000,
    beneficios: [
      'Todo lo de Gold',
      'Asistencia en viajes con cobertura global',
      'Acceso a salas VIP de aeropuertos (2 por año)',
      'Seguros de compra y garantía extendida',
    ],
  },
  {
    nivel: 'black',
    nombre: 'Black',
    limite: 15000000,
    situacionMaxima: 1,
    patrimonioMinimo: 12000000,
    beneficios: [
      'Todo lo de Platinum',
      'Salas VIP sin límite de accesos',
      'Servicio de conserjería 24 horas',
      'Las coberturas de seguro más amplias del banco',
    ],
  },
];

const PorNivel = new Map(NIVELES.map((n) => [n.nivel, n]));

const pesos = (monto) =>
  new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }).format(monto);

/** Datos de un nivel, o null si el nombre no existe. */
function buscarNivel(nivel) {
  return PorNivel.get(String(nivel || '').toLowerCase()) || null;
}

/**
 * Qué niveles puede pedir una persona, y por qué no los demás.
 *
 * Cuando no se pudo consultar al Banco Central (`situacion: null`) se ofrece
 * sólo el nivel de entrada: es preferible quedarse corto que otorgar un límite
 * alto sin saber si la persona está en mora en otro banco.
 *
 * @param {{situacion: number|null, patrimonio: number}} perfil
 */
function evaluarNiveles({ situacion, patrimonio }) {
  const patrimonioNumero = Number(patrimonio) || 0;

  const niveles = NIVELES.map((n) => {
    const { situacionMaxima, patrimonioMinimo, ...publico } = n;
    let motivo = null;

    if (situacion !== null && situacion >= SITUACION_BLOQUEANTE) {
      motivo = `Tu situación en la Central de Deudores es ${situacion}: no podés pedir tarjetas de crédito hasta regularizarla.`;
    } else if (situacion === null && n.nivel !== 'standard') {
      motivo = 'No pudimos consultar tu situación crediticia. Por ahora podés pedir la Standard.';
    } else if (situacion !== null && situacion > situacionMaxima) {
      motivo = `Requiere situación ${situacionMaxima} en la Central de Deudores; la tuya es ${situacion}.`;
    } else if (patrimonioNumero < patrimonioMinimo) {
      motivo = `Requiere un saldo total de ${pesos(patrimonioMinimo)}; hoy tenés ${pesos(patrimonioNumero)}.`;
    }

    return { ...publico, requisitos: { situacion_maxima: situacionMaxima, patrimonio_minimo: patrimonioMinimo }, disponible: motivo === null, motivo };
  });

  const disponibles = niveles.filter((n) => n.disponible);
  return {
    niveles,
    nivel_maximo: disponibles.length ? disponibles[disponibles.length - 1].nivel : null,
  };
}

module.exports = { NIVELES, SITUACION_BLOQUEANTE, buscarNivel, evaluarNiveles };
