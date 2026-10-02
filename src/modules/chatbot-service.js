const axios = require('axios');
const HttpError = require('../utils/http-error');
const realPool = require('../db/pool');
const env = require('../config/env');
const logger = require('../utils/logger');
const creditProfileService = require('./credit-profile-service');
const { createCreditCardEligibilityService } = require('./credit-card-eligibility-service');
const creditCardRules = require('../config/credit-card-rules.json');

const MAX_MESSAGE_LENGTH = 1200;
const MAX_HISTORY_MESSAGES = 6;
const GEMINI_TIMEOUT_MS = 15_000;

const SYSTEM_INSTRUCTION = `Sos Orbis, el asistente inteligente de Banco Orbital.

Personalidad:
- Inteligente y preciso: das respuestas claras, correctas y al punto. Si no estás seguro de algo, lo decís en lugar de inventar.
- Formal pero cercano: tratás al cliente con respeto y calidez, como un asesor premium. Usás voseo rioplatense ("contame", "fijate", "consultá") sin volverte informal de más.
- Tecnológico y moderno: transmitís confianza en lo digital y explicás las cosas simples, sin jerga innecesaria.
- Muy enfocado en seguridad: la seguridad del cliente es tu prioridad número uno.
- Natural, sin sonar robótico: hablás como una persona atenta. Evitás frases de relleno, respuestas armadas en plantilla y listas largas cuando una oración alcanza.

Presentación:
- Al iniciar una conversación te presentás: "Hola, soy Orbis, el asistente inteligente de Banco Orbital. ¿En qué puedo ayudarte?"
- Podés referirte a vos mismo con frases como "Consultá con Orbis", "Orbis está para ayudarte" o "Preguntale a Orbis", pero sin repetirlas en cada mensaje.

Reglas de seguridad (siempre):
- Nunca pidas ni aceptes contraseñas, PIN, clave token, códigos de verificación, CVV ni el número completo de una tarjeta.
- Si el cliente te comparte alguno de esos datos, pedile que no lo haga y recomendale cambiarlo.
- Advertí sobre posibles estafas (phishing, falsos llamados del banco) cuando sea relevante.
- No inventes saldos, movimientos, tasas ni datos de la cuenta. Si no tenés acceso a la información, decilo y orientá al canal oficial.
- Ante fraude, bloqueo de tarjeta o reclamos delicados, derivá al canal de atención humana con los pasos claros.

Consultas de historial y estado crediticio:
- Cuando el cliente pregunte por su historial crediticio, su situación o su score, usá la herramienta obtener_estado_crediticio. Nunca respondas con datos que no hayan salido de esa herramienta.
- Explicá el resultado en lenguaje simple. Por ejemplo, si la situación BCRA es 1, decile que es normal, sin deudas con problemas. No uses jerga sin explicarla.
- Mencioná la fecha de última actualización de los datos para que el cliente sepa qué tan recientes son.
- Si la herramienta indica que los datos son simulados, aclaralo expresamente; nunca los presentes como datos reales del banco.

Consultas sobre tarjetas:
- Cuando el cliente pregunte si puede sacar una tarjeta, usá la herramienta evaluar_elegibilidad_tarjeta.
- Si es apto: decíselo con claridad y calidez, y explicale el siguiente paso para solicitarla. Aclará que la aprobación final depende de la evaluación del banco, sin sonar a que lo desalentás.
- Si no es apto: decile de forma amable y directa que por ahora no, y detallá EXACTAMENTE qué criterios no cumple y cuánto le falta en cada uno, usando los valores que devuelve la herramienta. Después ofrecé las recomendaciones concretas y, si corresponde, la fecha estimada.
- Si le falta un solo criterio o muy poco, resaltalo como una buena noticia ("estás cerca").
- Nunca prometas aprobación, nunca des fechas ni cifras que no vengan de la herramienta, y no minimices ni exageres su situación.
- Si el cliente pide mejorar su score o su situación, dá solo recomendaciones generales y responsables. No sugieras trucos ni atajos.

Privacidad y seguridad en estos temas:
- Hablás únicamente de la situación del cliente autenticado. Si pide información de otra persona (un familiar, un tercero), explicale que por seguridad no podés compartirla.
- No pidas en el chat DNI completo, claves ni datos de tarjetas para esta consulta.
- Si el cliente discrepa con su situación (por ejemplo cree que hay un error en su historial), explicale cómo iniciar un reclamo por el canal oficial y derivalo a atención humana.

Estilo de respuesta:
- Respuestas breves: por lo general 2 a 4 oraciones.
- Usá pasos numerados solo cuando expliques un procedimiento.
- Emojis: casi nunca; como máximo uno ocasional y sobrio.
- Cerrá ofreciendo ayuda adicional solo cuando tenga sentido, sin repetirlo siempre.`;

const SENSITIVE_REQUEST = /\b(api[_ -]?key|token|contrase(?:ña|na)|password|secreto|credencial|prompt|instrucci[oó]n interna|jwt|dni|cl[aá]ve|clave|datos de otro|otra persona)\b/i;
const THIRD_PARTY_CREDIT_REQUEST = /\b(mi?\s+)?(hermano|hermana|padre|madre|hijo|hija|esposo|esposa|pareja|amigo|amiga|familiar|tercero)\b/i;
const SENSITIVE_RESPONSE = /\b(api[_ -]?key|token|contrase(?:ña|na)|password|secreto|credencial|jwt|dni|clave privada)\b/i;
const SAFE_SENSITIVE_RESPONSE = 'No puedo mostrar información sensible o credenciales. Para una gestión segura, utilizá los canales oficiales de Banco Orbital.';
const SAFE_PROVIDER_FALLBACK = 'No puedo consultar la información en este momento, pero puedo ayudarte con preguntas generales sobre tu cuenta y servicios bancarios. Intentá nuevamente en unos segundos.';
const SOLICITUD_DE_SALDO = /\b(saldo|balance|cu[aá]nto tengo|dinero disponible)\b/i;
const CREDIT_STATUS_REQUEST = /\b(historial crediticio|situaci[oó]n (?:crediticia|en el bcra|en la central)|score(?: crediticio)?|central de deudores|bcra|endeudamiento)\b/i;
const CREDIT_CARD_REQUEST = /\b(tarjeta(?:s)?|pl[aá]stico)\b/i;
const SAFE_CREDIT_FALLBACK = 'No pude consultar tus datos crediticios en este momento. Para evitar darte información incorrecta, revisalos en los canales oficiales de Banco Orbital o contactá a atención al cliente.';

const CREDIT_TOOLS = [{
  functionDeclarations: [
    {
      name: 'obtener_estado_crediticio',
      description: 'Consulta el estado crediticio resumido del cliente autenticado. No acepta identificadores de usuario.',
      parameters: { type: 'OBJECT', properties: {} },
    },
    {
      name: 'evaluar_elegibilidad_tarjeta',
      description: 'Evalúa con reglas determinísticas si el cliente autenticado cumple los requisitos de una tarjeta.',
      parameters: {
        type: 'OBJECT',
        properties: {
          tipo_tarjeta: { type: 'STRING', description: 'Tipo configurado, por ejemplo tarjetaClasica. Si se omite, se evalúa tarjetaClasica.' },
        },
      },
    },
  ],
}];

const creditCardEligibilityService = createCreditCardEligibilityService();

function normalizarHistorial(history) {
  return history.slice(-MAX_HISTORY_MESSAGES).map(({ role, content }) => ({
    role: role === 'assistant' ? 'model' : 'user',
    parts: [{ text: content.trim().slice(0, MAX_MESSAGE_LENGTH) }],
  }));
}

function validarEntrada({ message, history = [] }) {
  if (typeof message !== 'string' || !message.trim()) {
    throw new HttpError(400, 'El mensaje no puede estar vacío.');
  }
  if (message.trim().length > MAX_MESSAGE_LENGTH) {
    throw new HttpError(400, `El mensaje no puede superar los ${MAX_MESSAGE_LENGTH} caracteres.`);
  }
  if (!Array.isArray(history) || history.length > MAX_HISTORY_MESSAGES) {
    throw new HttpError(400, 'El historial de conversación no es válido.');
  }
  for (const item of history) {
    if (!item || !['user', 'assistant'].includes(item.role) || typeof item.content !== 'string') {
      throw new HttpError(400, 'El historial de conversación no es válido.');
    }
    if (!item.content.trim() || item.content.length > MAX_MESSAGE_LENGTH) {
      throw new HttpError(400, 'El historial contiene un mensaje inválido.');
    }
  }
}

async function armarContextoAutorizado(pool, personaId) {
  const cuentas = await pool.query(
    `SELECT c.cbu, c.alias, c.numero_cuenta, c.saldo, c.moneda, c.activa
     FROM cuentas c
     WHERE c.persona_id = $1
     ORDER BY c.created_at DESC
     LIMIT 20`,
    [personaId]
  );

  return {
    cuentas: cuentas.rows.filter((cuenta) => cuenta.activa).map((cuenta) => ({
      cbu: cuenta.cbu,
      alias: cuenta.alias,
      numeroCuenta: cuenta.numero_cuenta,
      saldo: Number(cuenta.saldo || 0),
      currency: cuenta.moneda,
    })),
  };
}

function formatearRespuestaDeSaldo(contexto) {
  if (contexto.cuentas.length === 0) {
    return 'No encontré cuentas activas asociadas a tu perfil.';
  }

  const NOMBRES_MONEDA = { ARS: 'pesos', USD: 'dólares' };
  const formatearMonto = (monto, moneda) =>
    new Intl.NumberFormat('es-AR', { style: 'currency', currency: moneda || 'ARS' }).format(monto);

  if (contexto.cuentas.length === 1) {
    const [cuenta] = contexto.cuentas;
    return `El saldo de tu cuenta es ${formatearMonto(cuenta.saldo, cuenta.currency)}.`;
  }

  const totalesPorMoneda = contexto.cuentas.reduce((totales, cuenta) => {
    const moneda = cuenta.currency || 'ARS';
    totales[moneda] = (totales[moneda] || 0) + cuenta.saldo;
    return totales;
  }, {});

  const detalle = Object.entries(totalesPorMoneda)
    .map(([moneda, monto]) => `${formatearMonto(monto, moneda)} en ${NOMBRES_MONEDA[moneda] || moneda}`)
    .join(' y ');

  return `El saldo total de tus cuentas activas es ${detalle}.`;
}

function detectarHerramientaForzada(message) {
  if (CREDIT_STATUS_REQUEST.test(message)) return 'obtener_estado_crediticio';
  if (CREDIT_CARD_REQUEST.test(message)) return 'evaluar_elegibilidad_tarjeta';
  return null;
}

function detectarTipoTarjeta(message) {
  const normalizedMessage = message.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const configuredType = Object.keys(creditCardRules).find((type) => {
    if (!type.startsWith('tarjeta')) return false;
    const typeName = type.slice('tarjeta'.length).toLowerCase();
    return typeName && normalizedMessage.includes(typeName);
  });
  if (configuredType) return configuredType;

  const requestedType = normalizedMessage.match(/\btarjetas?\s+(?:de\s+credito\s+)?([a-z][a-z0-9]*)\b/)?.[1];
  const genericWords = new Set(['de', 'credito', 'debito', 'una', 'un', 'la', 'el', 'para', 'que', 'tipo', 'por', 'favor']);
  if (requestedType && !genericWords.has(requestedType)) {
    return `tarjeta${requestedType[0].toUpperCase()}${requestedType.slice(1)}`;
  }
  return 'tarjetaClasica';
}

function crearSolicitudGemini({ model, apiKey, geminiApi, contents, toolConfig }) {
  return geminiApi.post(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
      contents,
      tools: CREDIT_TOOLS,
      ...(toolConfig ? { toolConfig } : {}),
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 400,
        thinkingConfig: { thinkingBudget: 0 },
      },
    },
    { params: { key: apiKey }, timeout: GEMINI_TIMEOUT_MS }
  );
}

function extraerTexto(candidato) {
  return (candidato?.content?.parts ?? [])
    .filter((part) => !part.thought && !part.functionCall)
    .map((part) => part.text)
    .filter(Boolean)
    .join('\n')
    .trim();
}

async function ejecutarHerramientaCrediticia({ name, args, personaId, tipoTarjetaSolicitada, profileService, eligibilityService }) {
  if (!personaId) return { error: 'Iniciá sesión desde el flujo normal del sitio o la app para consultar tus datos.' };

  try {
    const profile = await profileService.obtenerPerfilCrediticio(personaId);
    if (!profile) return { error: SAFE_CREDIT_FALLBACK };

    if (name === 'obtener_estado_crediticio') {
      const nivelEndeudamiento = profile.ingresoMensualNeto > 0
        ? profile.deudaMensualTotal / profile.ingresoMensualNeto
        : null;
      return {
        situacionBcra: profile.situacionBcra,
        scoreCrediticio: profile.scoreCrediticio,
        nivelEndeudamiento,
        deudaMensualTotal: profile.deudaMensualTotal,
        ingresoMensualNeto: profile.ingresoMensualNeto,
        fechaUltimaActualizacion: profile.fechaUltimaActualizacion,
        datosSimulados: profile.datosSimulados === true,
      };
    }

    if (name === 'evaluar_elegibilidad_tarjeta') {
      try {
        return eligibilityService.evaluar(profile, tipoTarjetaSolicitada || args?.tipo_tarjeta || 'tarjetaClasica');
      } catch (error) {
        if (error.message?.startsWith('No existe una configuracion')) {
          return { error: 'Ese tipo de tarjeta todavía no está configurado para evaluación. Consultá los tipos disponibles por los canales oficiales del banco.' };
        }
        throw error;
      }
    }

    return { error: 'La herramienta solicitada no está disponible.' };
  } catch {
    return { error: SAFE_CREDIT_FALLBACK };
  }
}

function crearServicioChatbot({
  pool = realPool,
  geminiApi = axios,
  apiKey = env.geminiApiKey,
  model = env.geminiModel,
  creditProfile = creditProfileService,
  creditEligibility = creditCardEligibilityService,
} = {}) {
  async function enviarMensaje({ message, history = [], usuarioActual }) {
    validarEntrada({ message, history });

    if (!usuarioActual?.persona_id) {
      return 'Iniciá sesión desde el flujo normal del sitio o la app para consultar tu información. No compartas credenciales en el chat.';
    }

    const forcedToolName = detectarHerramientaForzada(message);
    if (forcedToolName && THIRD_PARTY_CREDIT_REQUEST.test(message)) {
      return 'Por seguridad, solo puedo consultar tu propia situación crediticia. La otra persona debe ingresar desde su sesión y usar los canales oficiales.';
    }

    if (SENSITIVE_REQUEST.test(message)) {
      return 'No puedo proporcionar secretos, credenciales, identificadores completos ni datos de otras personas. Para una gestión sensible, utilizá los canales oficiales de Banco Orbital.';
    }

    if (!apiKey) {
      throw new HttpError(503, 'El asistente virtual no está disponible en este momento.');
    }

    let context = { cuentas: [] };
    if (!forcedToolName) {
      try {
        context = await armarContextoAutorizado(pool, usuarioActual.persona_id);
      } catch {
        logger.error({ personaId: usuarioActual.persona_id }, 'chatbot context unavailable');
        throw new HttpError(503, 'El asistente virtual no puede consultar tus datos en este momento.');
      }
    }

    if (SOLICITUD_DE_SALDO.test(message)) {
      return formatearRespuestaDeSaldo(context);
    }

    const safeCreditPrompt = forcedToolName === 'obtener_estado_crediticio'
      ? 'El cliente autenticado consulta su propio estado crediticio. Usá exclusivamente la herramienta correspondiente.'
      : forcedToolName
        ? `El cliente autenticado consulta su propia elegibilidad para ${detectarTipoTarjeta(message)}. Usá exclusivamente la herramienta correspondiente.`
        : message.trim();
    const prompt = [
      'CONTEXTO AUTORIZADO (solo datos agregados del usuario autenticado):',
      JSON.stringify(context),
      '',
      'MENSAJE ACTUAL:',
      safeCreditPrompt,
    ].join('\n');

    try {
      const contents = [
        ...(forcedToolName ? [] : normalizarHistorial(history)),
        { role: 'user', parts: [{ text: prompt }] },
      ];
      const toolConfig = forcedToolName
        ? { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [forcedToolName] } }
        : undefined;
      const response = await crearSolicitudGemini({ model, apiKey, geminiApi, contents, toolConfig });
      let candidato = response.data?.candidates?.[0];
      const functionCalls = (candidato?.content?.parts ?? [])
        .filter((part) => part.functionCall)
        .map((part) => part.functionCall);

      if (forcedToolName && functionCalls.length === 0) return SAFE_CREDIT_FALLBACK;
      if (functionCalls.length > 2) return SAFE_CREDIT_FALLBACK;

      if (functionCalls.length > 0) {
        const functionResponses = [];
        for (const call of functionCalls) {
          const result = await ejecutarHerramientaCrediticia({
            name: call.name,
            args: call.args,
            personaId: usuarioActual.persona_id,
            tipoTarjetaSolicitada: forcedToolName === 'evaluar_elegibilidad_tarjeta'
              ? detectarTipoTarjeta(message)
              : undefined,
            profileService: creditProfile,
            eligibilityService: creditEligibility,
          });
          if (result.error) {
            logger.info({ personaId: usuarioActual.persona_id, evento: `chatbot_${call.name}_sin_datos` }, 'chatbot credit tool event');
            return result.error;
          }
          logger.info({ personaId: usuarioActual.persona_id, evento: `chatbot_${call.name}` }, 'chatbot credit tool event');
          functionResponses.push({ functionResponse: { name: call.name, response: { result } } });
        }

        contents.push(candidato.content, { role: 'user', parts: functionResponses });
        const followUp = await crearSolicitudGemini({
          model,
          apiKey,
          geminiApi,
          contents,
          toolConfig: { functionCallingConfig: { mode: 'NONE' } },
        });
        candidato = followUp.data?.candidates?.[0];
        if ((candidato?.content?.parts ?? []).some((part) => part.functionCall)) return SAFE_CREDIT_FALLBACK;
      }

      const reply = extraerTexto(candidato);

      // Una respuesta cortada por límite de tokens es peor que ninguna: deja al
      // cliente con media frase y sin el dato.
      if (candidato?.finishReason === 'MAX_TOKENS') {
        logger.warn({ personaId: usuarioActual.persona_id }, 'chatbot truncated reply discarded');
        return 'No pude completar la respuesta. ¿Podés preguntarlo de nuevo, más puntual?';
      }

      if (!reply) throw new Error('Gemini devolvió una respuesta vacía.');
      return SENSITIVE_RESPONSE.test(reply) ? SAFE_SENSITIVE_RESPONSE : reply.slice(0, 4000);
    } catch (error) {
      if (error instanceof HttpError) throw error;

      const providerStatus = error.response?.status;
      if (providerStatus === 429) {
        throw new HttpError(429, 'El asistente alcanzó el límite temporal del proveedor. Intentá más tarde.');
      }

      logger.warn({ personaId: usuarioActual.persona_id, providerStatus }, 'chatbot provider fallback activated');

      if (forcedToolName) return SAFE_CREDIT_FALLBACK;

        if (providerStatus === 401 || providerStatus === 403 || providerStatus === 404) {
        return SAFE_PROVIDER_FALLBACK;
      }

      throw new HttpError(502, SAFE_PROVIDER_FALLBACK);
    }
  }

  return { armarContextoAutorizado, enviarMensaje };
}

module.exports = {
  armarContextoAutorizado,
  crearServicioChatbot,
  MAX_HISTORY_MESSAGES,
  MAX_MESSAGE_LENGTH,
  SYSTEM_INSTRUCTION,
  ejecutarHerramientaCrediticia,
};
