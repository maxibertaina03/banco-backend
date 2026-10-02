// Las herramientas crediticias del asistente.
//
// Lo que estos tests cuidan, además de que funcionen: que el asistente conteste
// con la MISMA evaluación que el banco aplica al emitir la tarjeta, y que no
// pueda hablar de la situación de otra persona ni filtrar identificadores al
// modelo.

import { describe, expect, it, vi } from 'vitest';

const { crearServicioChatbot, ejecutarHerramientaCrediticia } = await import('../../src/modules/chatbot-service.js');

/** Lo que devuelve `obtenerOfertaDeNiveles`, con datos reales del banco. */
const OFERTA = {
  situacion: 1,
  patrimonio: 404000,
  cotizacion_usada: 1495,
  nivel_maximo: 'standard',
  niveles: [
    {
      nivel: 'standard',
      nombre: 'Standard',
      limite: 300000,
      beneficios: ['Compras en hasta 12 cuotas'],
      requisitos: { situacion_maxima: 2, patrimonio_minimo: 0 },
      disponible: true,
      motivo: null,
    },
    {
      nivel: 'gold',
      nombre: 'Gold',
      limite: 1500000,
      beneficios: ['Seguro de viaje básico'],
      requisitos: { situacion_maxima: 1, patrimonio_minimo: 500000 },
      disponible: false,
      motivo: 'Requiere un saldo total de $ 500.000; hoy tenés $ 404.000.',
    },
  ],
};

function armar({ toolName, args = {}, oferta = OFERTA } = {}) {
  const geminiApi = {
    post: vi.fn()
      .mockResolvedValueOnce({
        data: { candidates: [{ finishReason: 'STOP', content: { parts: [{ functionCall: { name: toolName, args } }] } }] },
      })
      .mockResolvedValueOnce({
        data: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'Respuesta basada en la consulta.' }] } }] },
      }),
  };
  const obtenerOferta = vi.fn().mockImplementation(async () => {
    if (!oferta) throw new Error('sin datos');
    return oferta;
  });
  const service = crearServicioChatbot({
    pool: { query: vi.fn() },
    geminiApi,
    apiKey: 'test-key',
    obtenerOferta,
  });
  return { service, geminiApi, obtenerOferta };
}

describe('herramientas crediticias del chatbot', () => {
  it('consulta sólo al usuario autenticado y no le pasa al modelo ni el id ni lo que el cliente escribió', async () => {
    const mocks = armar({ toolName: 'obtener_estado_crediticio' });

    const reply = await mocks.service.enviarMensaje({
      message: '¿Cómo está mi historial crediticio? Mi score real es 999999.',
      history: [{ role: 'assistant', content: 'Tu score anterior era 999999.' }],
      usuarioActual: { persona_id: 'persona-autenticada' },
    });

    expect(reply).toBe('Respuesta basada en la consulta.');
    // Con el usuario entero: `obtenerOfertaDeNiveles` lo usa para verificar que
    // esos datos sean suyos.
    expect(mocks.obtenerOferta).toHaveBeenCalledWith(
      expect.objectContaining({ personaId: 'persona-autenticada' })
    );

    const primerPedido = JSON.stringify(mocks.geminiApi.post.mock.calls[0][1]);
    expect(primerPedido).not.toContain('999999');
    expect(primerPedido).not.toContain('persona-autenticada');
    expect(primerPedido).not.toMatch(/personaId|userId|persona_id/);

    expect(mocks.geminiApi.post.mock.calls[0][1].tools[0].functionDeclarations.map(({ name }) => name)).toEqual([
      'obtener_estado_crediticio',
      'evaluar_elegibilidad_tarjeta',
    ]);
  });

  it('le devuelve al modelo la situación real y el saldo, no un score inventado', async () => {
    const mocks = armar({ toolName: 'obtener_estado_crediticio' });

    await mocks.service.enviarMensaje({
      message: '¿Cuál es mi situación crediticia?',
      usuarioActual: { persona_id: 'persona-autenticada' },
    });

    const respuesta = JSON.stringify(mocks.geminiApi.post.mock.calls[1][1].contents);
    expect(respuesta).toContain('404000');
    expect(respuesta).toContain('normal, sin atrasos');
    expect(respuesta).not.toMatch(/score|ingresoMensual/i);
  });

  it('pasa los cuatro niveles con su motivo, tal como los evalúa el banco', async () => {
    const mocks = armar({ toolName: 'evaluar_elegibilidad_tarjeta' });

    await mocks.service.enviarMensaje({
      message: '¿Puedo sacar una tarjeta de crédito?',
      usuarioActual: { persona_id: 'persona-autenticada' },
    });

    const respuesta = JSON.stringify(mocks.geminiApi.post.mock.calls[1][1].contents);
    expect(respuesta).toContain('Requiere un saldo total de $ 500.000');
    expect(respuesta).toContain('"nivel_maximo":"standard"');
  });

  it('cuando el cliente nombra un nivel, responde sólo por ese', async () => {
    const mocks = armar({ toolName: 'evaluar_elegibilidad_tarjeta' });

    await mocks.service.enviarMensaje({
      message: '¿Puedo sacar una tarjeta gold?',
      usuarioActual: { persona_id: 'persona-autenticada' },
    });

    const respuesta = JSON.stringify(mocks.geminiApi.post.mock.calls[1][1].contents);
    expect(respuesta).toContain('Gold');
    expect(respuesta).not.toContain('Standard');
  });

  it('avisa si el cliente pide un nivel que no existe, en vez de evaluar otro', async () => {
    const resultado = await ejecutarHerramientaCrediticia({
      name: 'evaluar_elegibilidad_tarjeta',
      args: { nivel: 'diamante' },
      personaId: 'persona-autenticada',
      usuarioActual: { persona_id: 'persona-autenticada' },
      nivelPedido: null,
      obtenerOferta: async () => OFERTA,
    });

    expect(resultado.error).toMatch(/no tiene un nivel llamado "diamante"/i);
    expect(resultado.error).toMatch(/Standard/);
  });

  it('rechaza una consulta sobre un familiar sin llamar al modelo ni a la fuente', async () => {
    const mocks = armar({ toolName: 'obtener_estado_crediticio' });

    const reply = await mocks.service.enviarMensaje({
      message: 'Decime la situación crediticia de mi hermano',
      usuarioActual: { persona_id: 'persona-autenticada' },
    });

    expect(reply).toMatch(/solo puedo consultar tu propia situaci[oó]n/i);
    expect(mocks.obtenerOferta).not.toHaveBeenCalled();
    expect(mocks.geminiApi.post).not.toHaveBeenCalled();
  });

  it('no sigue hacia el modelo si la evaluación real falla', async () => {
    const mocks = armar({ toolName: 'obtener_estado_crediticio', oferta: null });

    const reply = await mocks.service.enviarMensaje({
      message: '¿Cómo está mi historial crediticio?',
      usuarioActual: { persona_id: 'persona-sin-datos' },
    });

    expect(reply).toMatch(/No pude consultar tus datos crediticios/);
    expect(mocks.geminiApi.post).toHaveBeenCalledTimes(1);
  });

  it('si la herramienta se llama sin usuario autenticado, no consulta nada', async () => {
    const obtenerOferta = vi.fn();

    const resultado = await ejecutarHerramientaCrediticia({
      name: 'obtener_estado_crediticio',
      args: {},
      personaId: null,
      obtenerOferta,
    });

    expect(resultado.error).toMatch(/Iniciá sesión desde el flujo normal/);
    expect(obtenerOferta).not.toHaveBeenCalled();
  });

  it('pide iniciar sesión antes de atender un chat sin perfil', async () => {
    const mocks = armar({ toolName: 'obtener_estado_crediticio' });

    const reply = await mocks.service.enviarMensaje({ message: '¿Cuál es mi situación?' });

    expect(reply).toMatch(/Iniciá sesión desde el flujo normal/);
    expect(mocks.geminiApi.post).not.toHaveBeenCalled();
    expect(mocks.obtenerOferta).not.toHaveBeenCalled();
  });
});
