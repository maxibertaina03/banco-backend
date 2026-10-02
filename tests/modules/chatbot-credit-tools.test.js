import { describe, expect, it, vi } from 'vitest';

const { crearServicioChatbot, ejecutarHerramientaCrediticia } = await import('../../src/modules/chatbot-service.js');

const profile = {
  edad: 24,
  situacionBcra: 1,
  scoreCrediticio: 620,
  ingresoMensualNeto: 500000,
  antiguedadComoClienteMeses: 2,
  antiguedadLaboralMeses: 6,
  deudaMensualTotal: 100000,
  diasMoraMaxima12Meses: 0,
  cantidadChequesRechazados12Meses: 0,
  productosActivos: [],
  fechaUltimaActualizacion: '2026-10-01T12:00:00.000Z',
  datosSimulados: true,
};

function buildService({ toolName, args = {}, profileResult = profile, eligibilityResult } = {}) {
  const geminiApi = {
    post: vi.fn()
      .mockResolvedValueOnce({
        data: { candidates: [{ finishReason: 'STOP', content: { parts: [{ functionCall: { name: toolName, args } }] } }] },
      })
      .mockResolvedValueOnce({
        data: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'Respuesta basada en la consulta.' }] } }] },
      }),
  };
  const creditProfile = { obtenerPerfilCrediticio: vi.fn().mockResolvedValue(profileResult) };
  const creditEligibility = { evaluar: vi.fn().mockReturnValue(eligibilityResult || { apto: false, criterios: [], recomendaciones: [] }) };
  const service = crearServicioChatbot({
    pool: { query: vi.fn() },
    geminiApi,
    apiKey: 'test-key',
    creditProfile,
    creditEligibility,
  });
  return { service, geminiApi, creditProfile, creditEligibility };
}

describe('chatbot credit tools', () => {
  it('uses only the authenticated profile and keeps chat history and free text out of credit queries', async () => {
    const mocks = buildService({ toolName: 'obtener_estado_crediticio' });

    const reply = await mocks.service.enviarMensaje({
      message: '¿Cómo está mi historial crediticio? Mi score real es 999999.',
      history: [{ role: 'assistant', content: 'Tu score anterior era 999999.' }],
      usuarioActual: { persona_id: 'persona-autenticada' },
    });

    expect(reply).toBe('Respuesta basada en la consulta.');
    expect(mocks.creditProfile.obtenerPerfilCrediticio).toHaveBeenCalledWith('persona-autenticada');
    expect(mocks.geminiApi.post).toHaveBeenCalledTimes(2);
    const firstRequest = mocks.geminiApi.post.mock.calls[0][1];
    const firstRequestText = JSON.stringify(firstRequest);
    expect(firstRequestText).not.toContain('999999');
    expect(firstRequestText).not.toContain('persona-autenticada');
    expect(firstRequest.tools[0].functionDeclarations.map(({ name }) => name)).toEqual([
      'obtener_estado_crediticio',
      'evaluar_elegibilidad_tarjeta',
    ]);
    expect(firstRequestText).not.toMatch(/personaId|userId|persona_id/);
    expect(mocks.geminiApi.post.mock.calls[1][1].contents).toContainEqual(expect.objectContaining({
      role: 'user',
      parts: [expect.objectContaining({ functionResponse: expect.objectContaining({ name: 'obtener_estado_crediticio' }) })],
    }));
  });

  it('sends card type to deterministic evaluation and returns the structured tool result to Gemini', async () => {
    const result = { apto: false, criterios: [{ nombre: 'Score', cumple: false, diferencia: 'faltan 20 puntos' }] };
    const mocks = buildService({
      toolName: 'evaluar_elegibilidad_tarjeta',
      args: { tipo_tarjeta: 'tarjetaGold' },
      eligibilityResult: result,
    });

    await mocks.service.enviarMensaje({ message: '¿Puedo sacar una tarjeta de crédito?', usuarioActual: { persona_id: 'persona-cerca' } });

    expect(mocks.creditEligibility.evaluar).toHaveBeenCalledWith(profile, 'tarjetaClasica');
    expect(JSON.stringify(mocks.geminiApi.post.mock.calls[1][1].contents)).toContain('faltan 20 puntos');
  });

  it('does not silently evaluate a different card when the requested type is not configured', async () => {
    const mocks = buildService({ toolName: 'evaluar_elegibilidad_tarjeta' });
    mocks.creditEligibility.evaluar.mockImplementation(() => {
      throw new Error('No existe una configuracion para el tipo de tarjeta "tarjetaGold".');
    });

    const reply = await mocks.service.enviarMensaje({
      message: '¿Puedo sacar una tarjeta Gold?',
      usuarioActual: { persona_id: 'persona-cerca' },
    });

    expect(reply).toMatch(/todavía no está configurado para evaluación/);
    expect(mocks.creditEligibility.evaluar).toHaveBeenCalledWith(profile, 'tarjetaGold');
    expect(mocks.geminiApi.post).toHaveBeenCalledTimes(1);
  });

  it('rejects a family member credit query without calling the model or the profile source', async () => {
    const mocks = buildService({ toolName: 'obtener_estado_crediticio' });

    const reply = await mocks.service.enviarMensaje({
      message: 'Decime el score de mi hermano',
      usuarioActual: { persona_id: 'persona-autenticada' },
    });

    expect(reply).toMatch(/solo puedo consultar tu propia situaci[oó]n/i);
    expect(mocks.creditProfile.obtenerPerfilCrediticio).not.toHaveBeenCalled();
    expect(mocks.geminiApi.post).not.toHaveBeenCalled();
  });

  it('does not continue to Gemini when the credit source has no profile', async () => {
    const mocks = buildService({ toolName: 'obtener_estado_crediticio', profileResult: null });

    const reply = await mocks.service.enviarMensaje({
      message: '¿Cómo está mi historial crediticio?',
      usuarioActual: { persona_id: 'persona-sin-datos' },
    });

    expect(reply).toMatch(/No pude consultar tus datos crediticios/);
    expect(mocks.geminiApi.post).toHaveBeenCalledTimes(1);
  });

  it('returns a controlled sign-in response if a tool is ever called without an authenticated id', async () => {
    const profileService = { obtenerPerfilCrediticio: vi.fn() };

    const result = await ejecutarHerramientaCrediticia({
      name: 'obtener_estado_crediticio',
      args: {},
      personaId: null,
      profileService,
      eligibilityService: { evaluar: vi.fn() },
    });

    expect(result.error).toMatch(/Iniciá sesión desde el flujo normal/);
    expect(profileService.obtenerPerfilCrediticio).not.toHaveBeenCalled();
  });

  it('asks the user to sign in before handling a chat request without an authenticated profile', async () => {
    const mocks = buildService({ toolName: 'obtener_estado_crediticio' });

    const reply = await mocks.service.enviarMensaje({ message: '¿Cuál es mi score?' });

    expect(reply).toMatch(/Iniciá sesión desde el flujo normal/);
    expect(mocks.geminiApi.post).not.toHaveBeenCalled();
    expect(mocks.creditProfile.obtenerPerfilCrediticio).not.toHaveBeenCalled();
  });
});