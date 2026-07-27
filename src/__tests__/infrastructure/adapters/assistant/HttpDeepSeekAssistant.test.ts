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

describe('HttpDeepSeekAssistant — credenciales resueltas por invocación', () => {
  // La firma explícita del spy es lo que permite afirmar sobre el config del request
  // (baseURL + Authorization). Con `jest.fn(async () => …)` las calls son tuplas vacías.
  type PostConfig = { baseURL?: string; headers: Record<string, string> };

  const spyClient = () => {
    const spy = jest.fn(async (_url: string, _body: unknown, _config: PostConfig) => ({
      data: { choices: [{ message: { content: 'hola' } }] },
    }));
    return { spy, client: { post: spy } as unknown as AxiosInstance };
  };

  const withResolver = (client: AxiosInstance, resolved: { baseUrl: string; apiKey: string }) =>
    new HttpDeepSeekAssistant({
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-del-deploy',
      client,
      resolveCredentials: async () => resolved,
    });

  it('la API key resuelta pisa a la del constructor', async () => {
    const { spy, client } = spyClient();

    await withResolver(client, {
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-de-la-ui',
    }).generate(generateReq);

    expect(spy.mock.calls[0][2].headers.Authorization).toBe('Bearer sk-de-la-ui');
  });

  it('la URL resuelta pisa a la del constructor', async () => {
    // Sin esto, "Probar conexión" (que SÍ honra la URL nueva) diría "OK" contra un endpoint
    // que el bot no usa. Un falso verde es peor que un error: no te frena.
    const { spy, client } = spyClient();

    await withResolver(client, {
      baseUrl: 'https://gateway.interno',
      apiKey: 'sk-x',
    }).generate(generateReq);

    expect(spy.mock.calls[0][2].baseURL).toBe('https://gateway.interno');
  });

  it('classify también honra la URL resuelta', async () => {
    const { spy, client } = spyClient();

    await withResolver(client, {
      baseUrl: 'https://gateway.interno',
      apiKey: 'sk-x',
    }).classify(classifyReq);

    expect(spy.mock.calls[0][2].baseURL).toBe('https://gateway.interno');
  });

  it('si resolver la credencial EXPLOTA ⇒ unavailable y no se llama a la API', async () => {
    // La resolución pega a la DB. Una DB caída no puede volverse un throw dentro del webhook.
    const { spy, client } = spyClient();
    const adapter = new HttpDeepSeekAssistant({
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-del-deploy',
      client,
      resolveCredentials: async () => {
        throw new Error('DB caída');
      },
    });

    await expect(adapter.generate(generateReq)).resolves.toEqual({ kind: 'unavailable' });
    expect(spy).not.toHaveBeenCalled();
  });
});
