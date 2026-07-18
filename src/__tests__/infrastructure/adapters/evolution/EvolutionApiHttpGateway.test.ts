/**
 * N1 (noc-broadcast) — EvolutionApiHttpGateway against a FAKE transport.
 * REGLA DURA: jamás se toca la instancia real del Pi ("ronald noc") — todo con
 * el `post` inyectado. Cubre:
 *  - reads config AL MOMENTO de llamar (no en el ctor): si !configured → error
 *    tipado NocBroadcastNotConfiguredError SIN tocar el transport.
 *  - request shape (url `/message/sendText/{instance}`, header `apikey`, body { number, text }).
 *  - mapeo de errores: throw del transport / status >= 400 → EvolutionApiError.
 */
import { EvolutionApiHttpGateway } from '@infrastructure/adapters/evolution/EvolutionApiHttpGateway';
import { InMemoryNocBroadcastConfigRepository } from '@infrastructure/adapters/in-memory/InMemoryNocBroadcastConfigRepository';
import { NocBroadcastNotConfiguredError, EvolutionApiError } from '@domain/errors/nocBroadcast';

interface RecordedPost {
  url: string;
  body: unknown;
  config: { headers: Record<string, string>; timeout: number };
}

class FakeTransport {
  calls: RecordedPost[] = [];
  error: unknown = null;
  status = 200;
  data: unknown = { key: { id: 'MSG1' } };

  post = async (
    url: string,
    body: unknown,
    config: { headers: Record<string, string>; timeout: number },
  ): Promise<{ status: number; data: unknown }> => {
    this.calls.push({ url, body, config });
    if (this.error) throw this.error;
    return { status: this.status, data: this.data };
  };
}

const CONFIGURED = {
  enabled: true,
  evolutionBaseUrl: 'http://pi.local:8080',
  evolutionApiKey: 'key-abcd',
  evolutionInstance: 'ronald noc',
  targetChat: '12036304@g.us',
  appPublicUrl: 'http://190.7.234.37:7778',
};

async function build(overrides: Partial<typeof CONFIGURED> = {}) {
  const configRepo = new InMemoryNocBroadcastConfigRepository();
  await configRepo.update({ ...CONFIGURED, ...overrides });
  const transport = new FakeTransport();
  const gateway = new EvolutionApiHttpGateway({ configRepo, post: transport.post });
  return { configRepo, transport, gateway };
}

describe('EvolutionApiHttpGateway — configured guard', () => {
  it('disabled config → NocBroadcastNotConfiguredError SIN tocar el transport', async () => {
    const { transport, gateway } = await build({ enabled: false });
    await expect(gateway.sendText('hola')).rejects.toBeInstanceOf(NocBroadcastNotConfiguredError);
    expect(transport.calls).toHaveLength(0);
  });

  it('missing targetChat → NocBroadcastNotConfiguredError SIN tocar el transport', async () => {
    const { transport, gateway } = await build({ targetChat: '' });
    await expect(gateway.sendText('hola')).rejects.toMatchObject({ code: 'NOC_BROADCAST_NOT_CONFIGURED' });
    expect(transport.calls).toHaveLength(0);
  });
});

describe('EvolutionApiHttpGateway — sendText request shape', () => {
  it('POST {baseUrl}/message/sendText/{instance} with `apikey` header and { number, text } body', async () => {
    const { transport, gateway } = await build();
    await gateway.sendText('mensaje de red');

    expect(transport.calls).toHaveLength(1);
    const call = transport.calls[0]!;
    expect(call.url).toBe('http://pi.local:8080/message/sendText/ronald%20noc');
    expect(call.config.headers['apikey']).toBe('key-abcd');
    expect(call.body).toEqual({ number: '12036304@g.us', text: 'mensaje de red' });
    expect(call.config.timeout).toBeGreaterThan(0);
  });

  it('trims a trailing slash on baseUrl before appending the Evolution path', async () => {
    const { transport, gateway } = await build({ evolutionBaseUrl: 'http://pi.local:8080/' });
    await gateway.sendText('x');
    expect(transport.calls[0]!.url).toBe('http://pi.local:8080/message/sendText/ronald%20noc');
  });

  it('reads config AL MOMENTO de llamar — a runtime edit is picked up on the next send', async () => {
    const { configRepo, transport, gateway } = await build();
    await configRepo.update({ targetChat: 'nuevo@g.us', evolutionApiKey: 'rotada-9999' });
    await gateway.sendText('y');
    expect(transport.calls[0]!.body).toMatchObject({ number: 'nuevo@g.us' });
    expect(transport.calls[0]!.config.headers['apikey']).toBe('rotada-9999');
  });
});

describe('EvolutionApiHttpGateway — error mapping', () => {
  it('transport throws (red/timeout) → EvolutionApiError', async () => {
    const { transport, gateway } = await build();
    transport.error = new Error('connect ECONNREFUSED');
    await expect(gateway.sendText('x')).rejects.toBeInstanceOf(EvolutionApiError);
  });

  it('non-throwing transport returning status >= 400 → EvolutionApiError', async () => {
    const { transport, gateway } = await build();
    transport.status = 502;
    await expect(gateway.sendText('x')).rejects.toMatchObject({ code: 'EVOLUTION_API_ERROR' });
  });
});
