import {
  resolveProviderCredentials,
  type AssistantProviderConfig,
  type AssistantProviderConfigRepository,
  type UpdateAssistantProviderConfigInput,
} from '@domain/ports/AssistantProviderConfigRepository';
import { toAssistantProviderConfigDto } from '@application/dto/assistantProvider.dto';
import { TestAssistantConnection } from '@application/use-cases/assistant/TestAssistantConnection';
import type { AssistantGenerateResult, AssistantRuntime } from '@domain/ports/AssistantRuntime';

/**
 * ai-assistant-multiagent — credenciales del proveedor.
 *
 * Lo que se prueba acá es que **la key nunca salga del backend** y que editar el formulario
 * no la pise sin querer. Son las dos formas en que este patrón se rompe en la práctica.
 */

class FakeProviderConfigRepo implements AssistantProviderConfigRepository {
  constructor(private config: AssistantProviderConfig = { baseUrl: '', apiKey: '' }) {}

  async get() {
    return { ...this.config };
  }

  async update(input: UpdateAssistantProviderConfigInput) {
    this.config = {
      baseUrl: input.baseUrl ?? this.config.baseUrl,
      // La regla: vacío/ausente PRESERVA; sólo `clearApiKey` borra.
      apiKey: input.clearApiKey ? '' : input.apiKey ? input.apiKey : this.config.apiKey,
    };
    return { ...this.config };
  }
}

const ENV = { baseUrl: 'https://api.deepseek.com', apiKey: 'sk-del-deploy' };

describe('resolveProviderCredentials — la DB pisa al env', () => {
  it('sin nada guardado, usa el env', () => {
    const r = resolveProviderCredentials({ baseUrl: '', apiKey: '' }, ENV);

    expect(r).toEqual({ ...ENV, source: 'env' });
  });

  it('con key guardada, la DB gana', () => {
    const r = resolveProviderCredentials({ baseUrl: '', apiKey: 'sk-de-la-ui' }, ENV);

    expect(r.apiKey).toBe('sk-de-la-ui');
    expect(r.source).toBe('db');
  });

  it('sin key en ningún lado ⇒ source none (el asistente queda mudo)', () => {
    const r = resolveProviderCredentials(
      { baseUrl: '', apiKey: '' },
      { baseUrl: 'https://x', apiKey: '' },
    );

    expect(r.source).toBe('none');
  });

  it('borrar el valor de la DB devuelve el control al env — la decisión es reversible', () => {
    const conStored = resolveProviderCredentials({ baseUrl: '', apiKey: 'sk-ui' }, ENV);
    const sinStored = resolveProviderCredentials({ baseUrl: '', apiKey: '' }, ENV);

    expect(conStored.source).toBe('db');
    expect(sinStored.source).toBe('env');
    expect(sinStored.apiKey).toBe('sk-del-deploy');
  });
});

describe('toAssistantProviderConfigDto — la key NUNCA se serializa', () => {
  it('no expone la apiKey por ningún campo', () => {
    const stored = { baseUrl: '', apiKey: 'sk-super-secreta-1234' };
    const dto = toAssistantProviderConfigDto(
      stored,
      resolveProviderCredentials(stored, ENV),
    );

    // La prueba dura: serializado completo, la key no aparece.
    expect(JSON.stringify(dto)).not.toContain('sk-super-secreta-1234');
    expect(JSON.stringify(dto)).not.toContain('sk-del-deploy');
  });

  it('expone hasApiKey + los últimos 4 para que el operador reconozca cuál cargó', () => {
    const stored = { baseUrl: '', apiKey: 'sk-super-secreta-1234' };
    const dto = toAssistantProviderConfigDto(stored, resolveProviderCredentials(stored, ENV));

    expect(dto.hasApiKey).toBe(true);
    expect(dto.apiKeyLast4).toBe('1234');
  });

  it('NO muestra los últimos 4 de una key que vive en el env (esta pantalla no la administra)', () => {
    const stored = { baseUrl: '', apiKey: '' };
    const dto = toAssistantProviderConfigDto(stored, resolveProviderCredentials(stored, ENV));

    expect(dto.hasApiKey).toBe(true);
    expect(dto.apiKeyLast4).toBeNull();
    expect(dto.source).toBe('env');
  });
});

describe('update — vacío PRESERVA la key guardada', () => {
  it('editar la baseUrl NO borra la key', async () => {
    // El bug clásico: el GET devuelve la máscara, el form manda todo de vuelta, y la máscara
    // se guardaría como key. El bot quedaría con "sk-...1234" de credencial.
    const repo = new FakeProviderConfigRepo({ baseUrl: '', apiKey: 'sk-guardada' });

    await repo.update({ baseUrl: 'https://nuevo.host' });

    expect((await repo.get()).apiKey).toBe('sk-guardada');
  });

  it('un apiKey vacío tampoco la pisa', async () => {
    const repo = new FakeProviderConfigRepo({ baseUrl: '', apiKey: 'sk-guardada' });

    await repo.update({ apiKey: '' });

    expect((await repo.get()).apiKey).toBe('sk-guardada');
  });

  it('borrar la key requiere un acto EXPLÍCITO', async () => {
    const repo = new FakeProviderConfigRepo({ baseUrl: '', apiKey: 'sk-guardada' });

    await repo.update({ clearApiKey: true });

    expect((await repo.get()).apiKey).toBe('');
  });
});

describe('TestAssistantConnection — la prueba corre en el SERVIDOR', () => {
  const runtimeOf = (result: AssistantGenerateResult): AssistantRuntime => ({
    classify: async () => ({ kind: 'unavailable' }),
    generate: async () => result,
  });

  it('sin credencial avisa qué hacer, no dice "error"', async () => {
    const useCase = new TestAssistantConnection(
      new FakeProviderConfigRepo(),
      { baseUrl: '', apiKey: '' },
      () => runtimeOf({ kind: 'text', text: 'OK' }),
      'deepseek-chat',
    );

    const result = await useCase.execute();

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/DEEPSEEK_API_KEY|API key/);
  });

  it('credencial válida ⇒ ok con latencia', async () => {
    const useCase = new TestAssistantConnection(
      new FakeProviderConfigRepo({ baseUrl: '', apiKey: 'sk-ui' }),
      ENV,
      () => runtimeOf({ kind: 'text', text: 'OK' }),
      'deepseek-chat',
    );

    const result = await useCase.execute();

    expect(result.ok).toBe(true);
    expect(result.latencyMs).not.toBeNull();
  });

  it('proveedor caído ⇒ falla con un mensaje accionable, SIN filtrar la key', async () => {
    const useCase = new TestAssistantConnection(
      new FakeProviderConfigRepo({ baseUrl: '', apiKey: 'sk-super-secreta' }),
      ENV,
      () => runtimeOf({ kind: 'unavailable' }),
      'deepseek-chat',
    );

    const result = await useCase.execute();

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('sk-super-secreta');
  });

  it('la prueba NO inyecta datos de clientes (facts null = modo charla)', async () => {
    let capturedFacts: unknown = 'no-invocado';
    const useCase = new TestAssistantConnection(
      new FakeProviderConfigRepo({ baseUrl: '', apiKey: 'sk-ui' }),
      ENV,
      () => ({
        classify: async () => ({ kind: 'unavailable' }),
        generate: async (req) => {
          capturedFacts = req.facts;
          return { kind: 'text', text: 'OK' };
        },
      }),
      'deepseek-chat',
    );

    await useCase.execute();

    // Probar la conexión no puede ser una excusa para mandarle datos reales al proveedor.
    expect(capturedFacts).toBeNull();
  });

  it('distingue si la credencial usada vino de la UI o del deploy', async () => {
    const desdeUi = new TestAssistantConnection(
      new FakeProviderConfigRepo({ baseUrl: '', apiKey: 'sk-ui' }),
      ENV,
      () => runtimeOf({ kind: 'text', text: 'OK' }),
      'deepseek-chat',
    );
    const desdeEnv = new TestAssistantConnection(
      new FakeProviderConfigRepo(),
      ENV,
      () => runtimeOf({ kind: 'text', text: 'OK' }),
      'deepseek-chat',
    );

    expect((await desdeUi.execute()).detail).toMatch(/esta pantalla/);
    expect((await desdeEnv.execute()).detail).toMatch(/deploy/);
  });
});
