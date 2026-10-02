// Fuente temporal simulada. Reemplazar por una integracion con datos verificados
// del banco antes de usar esta capacidad en produccion.
const MOCK_CREDIT_PROFILES = {
  apto: {
    edad: 32,
    situacionBcra: 1,
    scoreCrediticio: 760,
    ingresoMensualNeto: 1200000,
    antiguedadComoClienteMeses: 36,
    antiguedadLaboralMeses: 72,
    deudaMensualTotal: 100000,
    diasMoraMaxima12Meses: 0,
    cantidadChequesRechazados12Meses: 0,
    productosActivos: [{ tipo: 'cuenta', nombre: 'Cuenta en pesos' }],
    fechaUltimaActualizacion: '2026-10-01T12:00:00.000Z',
  },
  cerca: {
    edad: 24,
    situacionBcra: 1,
    scoreCrediticio: 620,
    ingresoMensualNeto: 500000,
    antiguedadComoClienteMeses: 2,
    antiguedadLaboralMeses: 6,
    deudaMensualTotal: 100000,
    diasMoraMaxima12Meses: 0,
    cantidadChequesRechazados12Meses: 0,
    productosActivos: [{ tipo: 'cuenta', nombre: 'Cuenta en pesos' }],
    fechaUltimaActualizacion: '2026-10-01T12:00:00.000Z',
  },
  noApto: {
    edad: 17,
    situacionBcra: 3,
    scoreCrediticio: 420,
    ingresoMensualNeto: 250000,
    antiguedadComoClienteMeses: 1,
    antiguedadLaboralMeses: 2,
    deudaMensualTotal: 120000,
    diasMoraMaxima12Meses: 45,
    cantidadChequesRechazados12Meses: 2,
    productosActivos: [{ tipo: 'prestamo', nombre: 'Prestamo personal' }],
    fechaUltimaActualizacion: '2026-10-01T12:00:00.000Z',
  },
};

const TEST_PROFILE_IDS = {
  'persona-prueba-apto': 'apto',
  'persona-prueba-cerca': 'cerca',
  'persona-prueba-no-apto': 'noApto',
};

function profileIndex(personaId) {
  let hash = 0;
  for (const char of String(personaId)) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % Object.keys(MOCK_CREDIT_PROFILES).length;
}

function createCreditProfileService({ profiles = MOCK_CREDIT_PROFILES } = {}) {
  const profileNames = Object.keys(profiles);

  async function obtenerPerfilCrediticio(personaId) {
    if (!personaId) return null;

    const forcedProfile = TEST_PROFILE_IDS[personaId];
    const profileName = forcedProfile || profileNames[profileIndex(personaId)];
    const profile = profiles[profileName];
    if (!profile) return null;

    return {
      ...profile,
      productosActivos: profile.productosActivos.map((producto) => ({ ...producto })),
      datosSimulados: true,
      fuenteDatos: 'simulado-temporal',
    };
  }

  return { obtenerPerfilCrediticio };
}

const servicio = createCreditProfileService();

module.exports = {
  MOCK_CREDIT_PROFILES,
  createCreditProfileService,
  obtenerPerfilCrediticio: servicio.obtenerPerfilCrediticio,
};