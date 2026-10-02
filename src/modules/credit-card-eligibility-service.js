const rules = require('../config/credit-card-rules.json');

const pesos = (amount) => new Intl.NumberFormat('es-AR', {
  style: 'currency',
  currency: 'ARS',
  maximumFractionDigits: 0,
}).format(amount);

function addMonths(date, months) {
  const result = new Date(date);
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

function createCreditCardEligibilityService({ rulesConfig = rules, now = () => new Date() } = {}) {
  function evaluar(perfil, tipoTarjeta = 'tarjetaClasica') {
    if (!perfil) throw new Error('No hay datos crediticios disponibles.');
    const regla = rulesConfig[tipoTarjeta];
    if (!regla || typeof regla !== 'object') {
      throw new Error(`No existe una configuracion para el tipo de tarjeta "${tipoTarjeta}".`);
    }

    const criterios = [];
    const recomendaciones = [];
    const addCriterion = (nombre, valorActual, valorRequerido, cumple, diferencia, recomendacion, mesesFaltantes = 0) => {
      criterios.push({ nombre, cumple, valorActual, valorRequerido, diferencia });
      if (!cumple) recomendaciones.push({ criterio: nombre, accion: recomendacion });
      if (!cumple && mesesFaltantes > 0) criterios[criterios.length - 1].mesesFaltantes = mesesFaltantes;
    };

    const ageGap = Math.max(0, regla.edadMinima - perfil.edad);
    addCriterion(
      'Edad minima', perfil.edad, regla.edadMinima, ageGap === 0,
      ageGap ? `${ageGap === 1 ? 'falta 1 ano' : `faltan ${ageGap} anos`}` : 'Cumple el minimo.',
      'Cuando cumplas la edad minima, volve a consultar los requisitos.', ageGap * 12
    );

    const situationOk = perfil.situacionBcra <= regla.situacionBcraMaxima;
    addCriterion(
      'Situacion BCRA', perfil.situacionBcra, regla.situacionBcraMaxima, situationOk,
      situationOk ? 'Cumple el maximo permitido.' : `requiere situacion ${regla.situacionBcraMaxima} o mejor; hoy figura ${perfil.situacionBcra}`,
      'Consultá tu informe de la Central de Deudores y, si hay información incorrecta, iniciá un reclamo por los canales oficiales.'
    );

    const scoreGap = Math.max(0, regla.scoreMinimo - perfil.scoreCrediticio);
    addCriterion(
      'Score crediticio minimo', perfil.scoreCrediticio, regla.scoreMinimo, scoreGap === 0,
      scoreGap ? `${scoreGap === 1 ? 'falta 1 punto' : `faltan ${scoreGap} puntos`} de score` : 'Cumple el minimo.',
      'Mantené tus pagos al día y consultá tu informe crediticio; no hay una fecha garantizada para que cambie el score.'
    );

    const incomeGap = Math.max(0, regla.ingresoMinimoMensual - perfil.ingresoMensualNeto);
    addCriterion(
      'Ingreso mensual neto minimo', perfil.ingresoMensualNeto, regla.ingresoMinimoMensual, incomeGap === 0,
      incomeGap ? `faltan ${pesos(incomeGap)} de ingreso mensual` : 'Cumple el minimo.',
      'Actualizá la documentación de ingresos verificables por los canales oficiales del banco.'
    );

    const customerMonthsGap = Math.max(0, regla.antiguedadClienteMinimaMeses - perfil.antiguedadComoClienteMeses);
    addCriterion(
      'Antiguedad como cliente', perfil.antiguedadComoClienteMeses, regla.antiguedadClienteMinimaMeses,
      customerMonthsGap === 0,
      customerMonthsGap ? `${customerMonthsGap === 1 ? 'falta 1 mes' : `faltan ${customerMonthsGap} meses`} de antiguedad como cliente` : 'Cumple el minimo.',
      'Volvé a consultar cuando completes la antigüedad requerida.', customerMonthsGap
    );

    const employmentMonthsGap = Math.max(0, regla.antiguedadLaboralMinimaMeses - perfil.antiguedadLaboralMeses);
    addCriterion(
      'Antiguedad laboral', perfil.antiguedadLaboralMeses, regla.antiguedadLaboralMinimaMeses,
      employmentMonthsGap === 0,
      employmentMonthsGap ? `${employmentMonthsGap === 1 ? 'falta 1 mes' : `faltan ${employmentMonthsGap} meses`} de antiguedad laboral` : 'Cumple el minimo.',
      'Volvé a consultar cuando completes la antigüedad laboral requerida.', employmentMonthsGap
    );

    const maxDebt = perfil.ingresoMensualNeto * regla.relacionCuotaIngresoMaxima;
    const debtGap = Math.max(0, perfil.deudaMensualTotal - maxDebt);
    addCriterion(
      'Relacion cuota-ingreso', perfil.deudaMensualTotal, maxDebt, debtGap === 0,
      debtGap ? `la cuota mensual de deudas supera el limite en ${pesos(debtGap)}` : 'La deuda mensual está dentro del limite.',
      'Evaluá cancelar o reducir cuotas vigentes y consultá al banco antes de refinanciar.'
    );

    const lateOk = perfil.diasMoraMaxima12Meses <= regla.diasMoraMaximaPermitida;
    addCriterion(
      'Dias de mora en los ultimos 12 meses', perfil.diasMoraMaxima12Meses, regla.diasMoraMaximaPermitida,
      lateOk,
      lateOk ? 'Cumple el maximo permitido.' : `supera el maximo permitido por ${perfil.diasMoraMaxima12Meses - regla.diasMoraMaximaPermitida} dias`,
      'Regularizá cualquier deuda vencida y consultá el estado actualizado por los canales oficiales.'
    );

    const checksOk = perfil.cantidadChequesRechazados12Meses <= regla.chequesRechazadosMaximos;
    addCriterion(
      'Cheques rechazados en los ultimos 12 meses', perfil.cantidadChequesRechazados12Meses,
      regla.chequesRechazadosMaximos, checksOk,
      checksOk ? 'Cumple el maximo permitido.' : `supera el maximo permitido por ${perfil.cantidadChequesRechazados12Meses - regla.chequesRechazadosMaximos} cheques`,
      'Regularizá la situación de los cheques rechazados y consultá el informe oficial para confirmar su actualización.'
    );

    const pending = criterios.filter((criterio) => !criterio.cumple);
    const onlyTimeBased = pending.length > 0 && pending.every((criterio) => criterio.mesesFaltantes > 0);
    const proximaFechaEstimada = onlyTimeBased
      ? addMonths(now(), Math.max(...pending.map((criterio) => criterio.mesesFaltantes))).toISOString().slice(0, 10)
      : null;

    return {
      apto: pending.length === 0,
      tipoTarjeta,
      criterios: criterios.map(({ mesesFaltantes, ...criterio }) => criterio),
      proximaFechaEstimada,
      recomendaciones,
      datosSimulados: perfil.datosSimulados === true,
      fuenteDatos: perfil.fuenteDatos || 'no especificada',
    };
  }

  return { evaluar };
}

const servicio = createCreditCardEligibilityService();

module.exports = {
  createCreditCardEligibilityService,
  evaluarElegibilidad: servicio.evaluar,
};