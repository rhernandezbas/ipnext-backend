import axios, { type AxiosInstance } from 'axios';
import type {
  AssistantClassifyRequest,
  AssistantClassifyResult,
  AssistantGenerateRequest,
  AssistantGenerateResult,
  AssistantRuntime,
  AssistantThreadTurn,
} from '@domain/ports/AssistantRuntime';

/**
 * ai-assistant-multiagent (T5.1) — **el ÚNICO archivo del repo que sabe que DeepSeek existe.**
 *
 * El motor habla con el puerto `AssistantRuntime`, no con esto. Cambiar a Kimi, a Claude o a
 * un modelo local es reemplazar este archivo y una línea del composition root — nada más.
 *
 * ⚠️ **MUST NOT THROW (RUN-1).** Ninguna ruta de este adapter lanza: timeout, 4xx/5xx, JSON
 * malformado o salida fuera de contrato se devuelven como `{ kind: 'unavailable' }`. La unión
 * discriminada del puerto obliga al caller a contemplarlo — el contrato es de compilación.
 *
 * ⚠️ **Cero PII.** Este adapter NO redacta: recibe el hilo YA redactado (SEC-1/CONV-5) y los
 * hechos YA verificados libres de identidad. Si acá llegara PII, el problema está aguas
 * arriba y la barrera es `assertFactsArePiiFree`, no este archivo.
 */

/** Centinela del paso de redacción (design D8) — la vía por la que el modelo pide handoff. */
const CANNOT_ANSWER_SENTINEL = 'NO_PUEDO_RESPONDER';

/** Valores que el clasificador puede devolver además de una key de intención. */
const CLASSIFY_CHAT = 'CHARLA';
const CLASSIFY_OUT_OF_SCOPE = 'FUERA_DE_ALCANCE';

export interface HttpDeepSeekAssistantOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  /** Inyectable para tests: nunca se pega a la API real desde la suite. */
  client?: AxiosInstance;
}

interface ChatCompletionMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export class HttpDeepSeekAssistant implements AssistantRuntime {
  private readonly http: AxiosInstance;
  private readonly apiKey: string;

  constructor(options: HttpDeepSeekAssistantOptions) {
    this.apiKey = options.apiKey;
    this.http =
      options.client ??
      axios.create({
        baseURL: options.baseUrl,
        timeout: options.timeoutMs ?? 20000,
        headers: { 'Content-Type': 'application/json' },
      });
  }

  async classify(request: AssistantClassifyRequest): Promise<AssistantClassifyResult> {
    if (!this.apiKey) return { kind: 'unavailable' };
    if (request.candidates.length === 0) {
      // Perfil sin intenciones habilitadas: no hay nada que clasificar. Se ahorra la llamada
      // y se trata como charla — saludar no requiere que existan temas configurados.
      return { kind: 'chat' };
    }

    const catalog = request.candidates
      .map((c) => {
        const examples = c.examples.length > 0 ? ` Ejemplos: ${c.examples.join(' | ')}` : '';
        return `- ${c.key}: ${c.name}. ${c.description}${examples}`;
      })
      .join('\n');

    const system = [
      request.persona,
      '',
      'Sos un clasificador. Leé TODA la conversación y decidí de qué tema se está hablando.',
      'Temas disponibles (respondé con la CLAVE exacta, la parte antes de los dos puntos):',
      catalog,
      '',
      `Si es un saludo, un agradecimiento, una repregunta o charla general, respondé: ${CLASSIFY_CHAT}`,
      `Si piden algo que NO está en la lista, respondé: ${CLASSIFY_OUT_OF_SCOPE}`,
      'Respondé ÚNICAMENTE con la clave, sin explicar y sin agregar nada más.',
    ].join('\n');

    const raw = await this.complete(request.model, system, request.thread, request.timeoutMs, 32);
    if (raw === null) return { kind: 'unavailable' };

    const answer = raw.trim();
    if (answer === CLASSIFY_CHAT) return { kind: 'chat' };
    if (answer === CLASSIFY_OUT_OF_SCOPE) return { kind: 'out_of_scope' };

    // Se valida contra el set CERRADO. Una key inventada por el modelo NO se acepta: el motor
    // la trataría como intención inexistente, así que se corta acá y se degrada a "no sé".
    const known = request.candidates.some((c) => c.key === answer);
    return known ? { kind: 'intent', key: answer } : { kind: 'out_of_scope' };
  }

  async generate(request: AssistantGenerateRequest): Promise<AssistantGenerateResult> {
    if (!this.apiKey) return { kind: 'unavailable' };

    const isChatMode = request.facts === null;

    const system = [
      request.persona,
      request.responseGuide,
      '',
      isChatMode
        ? [
            'Estás conversando SIN datos del cliente a la vista.',
            'NO afirmes montos, fechas, plazos, precios ni estados de servicio.',
            'NO prometas visitas ni políticas comerciales.',
            'Podés saludar, acusar recibo, repreguntar y explicar qué consultas podés hacer.',
          ].join('\n')
        : [
            'HECHOS (única fuente de verdad — no inventes ni calcules nada fuera de esto):',
            JSON.stringify(request.facts),
            '',
            'Escribí los números en DÍGITOS, nunca en letras.',
            'No menciones ninguna cifra que no esté en los HECHOS.',
          ].join('\n'),
      '',
      `Si no podés responder con lo que tenés, respondé EXACTAMENTE: ${CANNOT_ANSWER_SENTINEL}`,
    ]
      .filter((line) => line !== '')
      .join('\n');

    const raw = await this.complete(request.model, system, request.thread, request.timeoutMs, 600);
    if (raw === null) return { kind: 'unavailable' };

    const text = raw.trim();
    if (text.length === 0) return { kind: 'unavailable' };
    // El centinela puede venir solo o embebido si el modelo se puso conversador.
    if (text.includes(CANNOT_ANSWER_SENTINEL)) return { kind: 'cannot_answer' };

    return { kind: 'text', text };
  }

  /**
   * Llamada cruda. Devuelve `null` ante CUALQUIER problema — nunca lanza (RUN-1).
   * El caller traduce ese `null` al `unavailable` de su unión.
   */
  private async complete(
    model: string,
    system: string,
    thread: AssistantThreadTurn[],
    timeoutMs: number,
    maxTokens: number,
  ): Promise<string | null> {
    const messages: ChatCompletionMessage[] = [
      { role: 'system', content: system },
      ...thread.map((turn) => ({
        // El hilo del cliente entra como `user`; lo que dijo el bot, como `assistant`.
        role: turn.role === 'customer' ? ('user' as const) : ('assistant' as const),
        content: turn.text,
      })),
    ];

    try {
      const response = await this.http.post(
        '/chat/completions',
        { model, messages, max_tokens: maxTokens, stream: false },
        {
          timeout: timeoutMs,
          headers: { Authorization: `Bearer ${this.apiKey}` },
        },
      );

      const content = response.data?.choices?.[0]?.message?.content;
      return typeof content === 'string' ? content : null;
    } catch (err) {
      // Timeout, 4xx, 5xx, red caída, JSON ilegible: todo termina acá y se degrada.
      // eslint-disable-next-line no-console
      console.error('[assistant] DeepSeek no respondió — degradado a unavailable', {
        model,
        error: err instanceof Error ? err.message : err,
      });
      return null;
    }
  }
}
