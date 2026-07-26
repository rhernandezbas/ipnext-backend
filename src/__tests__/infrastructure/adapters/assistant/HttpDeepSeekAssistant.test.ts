import { HttpDeepSeekAssistant } from '@infrastructure/adapters/deepseek/HttpDeepSeekAssistant';
import type { AxiosInstance } from 'axios';

/**
 * ai-assistant-multiagent (T5.3) — el adapter de DeepSeek.
 *
 * Lo que importa acá NO es que funcione el camino feliz: es que **ninguna falla lance**.
 * El motor corre dentro del webhook de Chatwoot, que tiene que poder ackear 200 siempre. Un
 * throw de este archivo sería un 500 y una tormenta de reintentos de Sidekiq.
 */

const clientOf = (impl: () => unknown): AxiosInstance =>
  ({ post: async () => impl() }) as unknown as AxiosInstance;

const ok = (content: unknown) =>
  clientOf(() => ({ data: { choices: [{ message: { content } }] } }));

const boom = (message: string) =>
  clientOf(() => {
    throw new Error(message);
  });

const adapter = (client: AxiosInstance, apiKey = 'sk-test') =>
  new HttpDeepSeekAssistant({ baseUrl: 'https://api.deepseek.com', apiKey, client });

const classifyReq = {
  model: 'deepseek-chat',
  persona: 'Cordial',
  thread: [{ role: 'customer' as const, text: '¿cuánto debo?' }],
  candidates: [
    { key: 'intent-1', name: 'estado de cuenta', description: 'cuánto debe', examples: [] },
  ],
  timeoutMs: 5000,
};

const generateReq = {
  model: 'deepseek-chat',
  persona: 'Cordial',
  responseGuide: 'Respondé breve',
  thread: [{ role: 'customer' as const, text: '¿cuánto debo?' }],
  facts: { saldo: 45000 },
  timeoutMs: 5000,
};

describe('HttpDeepSeekAssistant — classify', () => {
  it('devuelve la intención cuando el modelo responde una key conocida', async () => {
    await expect(adapter(ok('intent-1')).classify(classifyReq)).resolves.toEqual({
      kind: 'intent',
      key: 'intent-1',
    });
  });

  it('tolera espacios alrededor de la respuesta', async () => {
    await expect(adapter(ok('  intent-1 \n')).classify(classifyReq)).resolves.toMatchObject({
      kind: 'intent',
    });
  });

  it('reconoce el centinela de charla', async () => {
    await expect(adapter(ok('CHARLA')).classify(classifyReq)).resolves.toEqual({ kind: 'chat' });
  });

  it('reconoce el centinela de fuera de alcance', async () => {
    await expect(adapter(ok('FUERA_DE_ALCANCE')).classify(classifyReq)).resolves.toEqual({
      kind: 'out_of_scope',
    });
  });

  it('una key INVENTADA por el modelo NO se acepta — set cerrado', async () => {
    // Si se aceptara, el motor buscaría una intención que no existe y terminaría en un
    // handoff igual, pero después de haber gastado la llamada de redacción.
    await expect(adapter(ok('intent-inventada')).classify(classifyReq)).resolves.toEqual({
      kind: 'out_of_scope',
    });
  });

  it('sin candidatas NO llama al modelo y trata el turno como charla', async () => {
    const spy = jest.fn();
    const client = { post: spy } as unknown as AxiosInstance;

    await expect(
      adapter(client).classify({ ...classifyReq, candidates: [] }),
    ).resolves.toEqual({ kind: 'chat' });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('HttpDeepSeekAssistant — generate', () => {
  it('devuelve el texto generado', async () => {
    await expect(adapter(ok('Tu saldo es $45000.')).generate(generateReq)).resolves.toEqual({
      kind: 'text',
      text: 'Tu saldo es $45000.',
    });
  });

  it('detecta el centinela NO_PUEDO_RESPONDER', async () => {
    await expect(adapter(ok('NO_PUEDO_RESPONDER')).generate(generateReq)).resolves.toEqual({
      kind: 'cannot_answer',
    });
  });

  it('detecta el centinela aunque venga embebido en prosa', async () => {
    await expect(
      adapter(ok('Mmm, NO_PUEDO_RESPONDER esto con lo que tengo')).generate(generateReq),
    ).resolves.toEqual({ kind: 'cannot_answer' });
  });

  it('una respuesta vacía se trata como no disponible, no como texto', async () => {
    await expect(adapter(ok('   ')).generate(generateReq)).resolves.toEqual({
      kind: 'unavailable',
    });
  });
});

// ── RUN-1: nada de esto puede lanzar ───────────────────────────────────────
describe('HttpDeepSeekAssistant — MUST NOT THROW', () => {
  it('timeout ⇒ unavailable', async () => {
    await expect(adapter(boom('timeout of 5000ms exceeded')).generate(generateReq)).resolves.toEqual(
      { kind: 'unavailable' },
    );
  });

  it('5xx ⇒ unavailable', async () => {
    await expect(adapter(boom('Request failed with status code 503')).classify(classifyReq))
      .resolves.toEqual({ kind: 'unavailable' });
  });

  it('4xx (credencial mala) ⇒ unavailable', async () => {
    await expect(adapter(boom('Request failed with status code 401')).generate(generateReq))
      .resolves.toEqual({ kind: 'unavailable' });
  });

  it('respuesta sin la forma esperada ⇒ unavailable, no explota al navegar el JSON', async () => {
    const weird = clientOf(() => ({ data: { unexpected: true } }));

    await expect(adapter(weird).generate(generateReq)).resolves.toEqual({ kind: 'unavailable' });
  });

  it('content que no es string ⇒ unavailable', async () => {
    await expect(adapter(ok({ nested: 'object' })).generate(generateReq)).resolves.toEqual({
      kind: 'unavailable',
    });
  });

  it('SIN API KEY ⇒ unavailable, y NUNCA se llama a la API', async () => {
    // Deploy sin el secret: el bot queda mudo, el server levanta igual, nadie se entera por
    // un 500. Es el fail-safe que justifica que esta config NO sea fail-fast.
    const spy = jest.fn();
    const client = { post: spy } as unknown as AxiosInstance;

    await expect(adapter(client, '').generate(generateReq)).resolves.toEqual({
      kind: 'unavailable',
    });
    await expect(adapter(client, '').classify(classifyReq)).resolves.toEqual({
      kind: 'unavailable',
    });
    expect(spy).not.toHaveBeenCalled();
  });
});
