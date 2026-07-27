import { IClassClient } from '@infrastructure/adapters/iclass/IClassClient';

/**
 * Hallazgos 2.1 / 2.3 / 2.4 / 2.6 / 2.8 del review adversarial.
 *
 * Todos son la MISMA clase de defecto: traer de menos y reportar éxito. El change se
 * blindó contra la página corta y dejó entrar el mismo problema por otras cinco puertas.
 */

interface Scripted {
  post: Array<{ ok?: { data: unknown }; err?: unknown }>;
  get: Array<{ ok?: { data: unknown }; err?: unknown }>;
}

function makeHttp(script: Scripted) {
  const calls: { method: string; url: string }[] = [];
  const next = (queue: Scripted['get']) => {
    const step = queue.shift();
    if (!step) throw new Error('no scripted response left');
    if (step.err) return Promise.reject(step.err);
    return Promise.resolve(step.ok);
  };
  return {
    calls,
    http: {
      post: jest.fn((url: string) => {
        calls.push({ method: 'POST', url });
        return next(script.post);
      }),
      get: jest.fn((url: string) => {
        calls.push({ method: 'GET', url });
        return next(script.get);
      }),
    },
  };
}

const LOGIN_OK = { ok: { data: { access_token: 'tok' } } };
const EMPTY_204 = { ok: { data: '' } };

/** El rate limit de IClass llega como HTTP 200 con cuerpo de TEXTO PLANO. */
const RATE_LIMIT_200 = { ok: { data: 'Espere um pouco antes de fazer outra requisição' } };

function page(n: number, startMin = 0, day = '26') {
  const objects = Array.from({ length: n }, (_, i) => ({
    latitude: -34.65 - i * 0.0001,
    longitude: -59.44,
    dataRegistro: `${day}-07-2026 ${String(9 + Math.floor((startMin + i) / 60)).padStart(2, '0')}:${String((startMin + i) % 60).padStart(2, '0')}:00`,
    raio: 7.5,
    origem: 1,
  }));
  return { ok: { data: { objects } } };
}

function makeClient(script: Scripted) {
  const { http, calls } = makeHttp(script);
  const client = new IClassClient({
    baseUrl: 'http://iclass.test',
    username: 'u',
    password: 'p',
    thirdPartyId: 'TP1',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    http: http as any,
    subresourceBackoffMs: 0,
    _sleep: async () => undefined,
  });
  return { client, calls };
}

describe('2.1 — el rate limit (HTTP 200 + texto) NO es una página vacía', () => {
  it('marks the trail INCOMPLETE instead of ending it silently', async () => {
    const { client } = makeClient({
      post: [LOGIN_OK],
      get: [page(100, 0), RATE_LIMIT_200, RATE_LIMIT_200],
    });

    const res = await client.listTeamLocations('1', 'IPNXANDYM');

    // Antes: dos "páginas vacías" seguidas → corte con incomplete:false y 25 días perdidos.
    expect(res.incomplete).toBe(true);
    expect(res.points).toHaveLength(100);
  });

  it('does not confuse a real 204 with a rate limit', async () => {
    const { client } = makeClient({
      post: [LOGIN_OK],
      get: [page(100, 0), EMPTY_204, EMPTY_204],
    });
    const res = await client.listTeamLocations('1', 'IPNXANDYM');
    expect(res.incomplete).toBe(false);
  });

  it('surfaces a rate limit in the team roster too, instead of returning an empty roster', async () => {
    const { client } = makeClient({ post: [LOGIN_OK], get: [RATE_LIMIT_200] });
    await expect(client.listTeamLocationDescriptors()).rejects.toThrow();
  });
});

describe('2.3 — salir por el tope de páginas es INCOMPLETO', () => {
  it('reports incomplete when the page cap is exhausted', async () => {
    // Siempre páginas LLENAS y con timestamps VÁLIDOS: nunca llega el corte natural.
    // (Ojo: si los timestamps fueran inválidos saltaría antes el guard de "página
    // entera ilegible", que es otro camino distinto — se testea aparte.)
    const validPage = () => ({
      ok: {
        data: {
          objects: Array.from({ length: 100 }, (_, i) => ({
            latitude: -34.65 - i * 0.0001,
            longitude: -59.44,
            dataRegistro: `26-07-2026 09:${String(i % 60).padStart(2, '0')}:00`,
            raio: 7.5,
            origem: 1,
          })),
        },
      },
    });
    const get = Array.from({ length: 260 }, validPage);
    const { client } = makeClient({ post: [LOGIN_OK], get });

    const res = await client.listTeamLocations('1', 'IPNXANDYM');

    expect(res.incomplete).toBe(true);
    expect(res.pagesRead).toBeGreaterThan(100);
  });
});

describe('2.4 — los puntos ilegibles se CUENTAN', () => {
  it('reports how many points were dropped', async () => {
    const { client } = makeClient({
      post: [LOGIN_OK],
      get: [
        {
          ok: {
            data: {
              objects: [
                { latitude: -34.65, longitude: -59.44, dataRegistro: 'basura', raio: 7, origem: 1 },
                { latitude: -34.65, longitude: -59.44, dataRegistro: '2026-07-26T09:10:00', raio: 7, origem: 1 },
                { latitude: -34.66, longitude: -59.45, dataRegistro: '26-07-2026 09:10:00', raio: 7, origem: 1 },
              ],
            },
          },
        },
        EMPTY_204,
        EMPTY_204,
      ],
    });

    const res = await client.listTeamLocations('1', 'IPNXANDYM');

    expect(res.points).toHaveLength(1);
    // Si IClass migra el formato de fecha, esto es lo único que delata el desastre.
    expect(res.pointsDropped).toBe(2);
  });

  it('flags the trail as incomplete when EVERY point of a full page is unreadable', async () => {
    const bad = {
      ok: {
        data: {
          objects: Array.from({ length: 100 }, () => ({
            latitude: -34.65,
            longitude: -59.44,
            dataRegistro: '2026-07-26T09:10:00', // formato ISO: IClass cambió el contrato
            raio: 7,
            origem: 1,
          })),
        },
      },
    };
    const { client } = makeClient({ post: [LOGIN_OK], get: [bad, EMPTY_204, EMPTY_204] });

    const res = await client.listTeamLocations('1', 'IPNXANDYM');
    expect(res.points).toHaveLength(0);
    expect(res.pointsDropped).toBe(100);
    expect(res.incomplete).toBe(true);
  });
});

describe('2.6 / 2.7 — watermark estricto y con solapamiento', () => {
  it('keeps a point recorded exactly AT the watermark (different coordinates are a different row)', async () => {
    const { client } = makeClient({
      post: [LOGIN_OK],
      get: [
        {
          ok: {
            data: {
              objects: [
                { latitude: -34.65, longitude: -59.44, dataRegistro: '26-07-2026 09:00:00', raio: 7, origem: 1 },
                { latitude: -34.99, longitude: -59.99, dataRegistro: '26-07-2026 09:00:00', raio: 7, origem: 1 },
                { latitude: -34.65, longitude: -59.44, dataRegistro: '26-07-2026 08:00:00', raio: 7, origem: 1 },
              ],
            },
          },
        },
      ],
    });

    // watermark == 09:00 AR == 12:00 UTC
    const res = await client.listTeamLocations('1', 'IPNXANDYM', new Date('2026-07-26T12:00:00.000Z'));

    // Los dos puntos de las 09:00 sobreviven (el unique de la base los distingue por
    // coordenada); el de las 08:00 queda por debajo del solapamiento sólo si es viejo.
    expect(res.points.length).toBeGreaterThanOrEqual(2);
  });
});

describe('R7 — el watermark es ESTRICTO (< y no <=)', () => {
  it('keeps a point recorded EXACTLY at the (overlapped) cutoff', async () => {
    // El solapamiento de 2 h del fix 2.7 enmascaraba por completo este test: con todos
    // los puntos por encima del corte, `<` y `<=` daban idéntico resultado.
    // Acá el punto cae JUSTO en el corte solapado, que es donde se distinguen.
    const { client } = makeClient({
      post: [LOGIN_OK],
      get: [
        {
          ok: {
            data: {
              objects: [
                // watermark 12:00 UTC − 2 h = 10:00 UTC == 07:00 AR
                { latitude: -34.65, longitude: -59.44, dataRegistro: '26-07-2026 07:00:00', raio: 7, origem: 1 },
                { latitude: -34.99, longitude: -59.99, dataRegistro: '26-07-2026 06:00:00', raio: 7, origem: 1 },
              ],
            },
          },
        },
      ],
    });

    const res = await client.listTeamLocations('1', 'IPNXANDYM', new Date('2026-07-26T12:00:00.000Z'));

    // Con `<=` el punto del corte exacto se descartaba para siempre; con `<` sobrevive.
    expect(res.points).toHaveLength(1);
    expect(res.points[0].recordedAt.toISOString()).toBe('2026-07-26T10:00:00.000Z');
  });
});

describe('2.8 — un timestamp futuro no puede envenenar el rastro', () => {
  it('drops points dated far in the future', async () => {
    const { client } = makeClient({
      post: [LOGIN_OK],
      get: [
        {
          ok: {
            data: {
              objects: [
                { latitude: -34.65, longitude: -59.44, dataRegistro: '26-07-2036 09:00:00', raio: 7, origem: 1 },
                { latitude: -34.66, longitude: -59.45, dataRegistro: '26-07-2026 09:10:00', raio: 7, origem: 1 },
              ],
            },
          },
        },
        EMPTY_204,
        EMPTY_204,
      ],
    });

    const res = await client.listTeamLocations('1', 'IPNXANDYM', null, new Date('2026-07-26T13:00:00Z'));

    // Sin este guard, el punto de 2036 se convierte en el watermark y bloquea el ingest
    // por diez años, con incomplete:false y sin que nadie sepa que hay que intervenir.
    expect(res.points).toHaveLength(1);
    expect(res.points[0].recordedAt.toISOString()).toBe('2026-07-26T12:10:00.000Z');
    expect(res.pointsDropped).toBe(1);
  });

  it('R9 — a FULL page of future-dated points does NOT stall the team forever', async () => {
    // El rastro viene DESCENDENTE, así que un dispositivo con el reloj adelantado pone
    // sus puntos futuros PRIMEROS. Contarlos como "no parseados" disparaba el detector
    // de página ilegible → incomplete permanente → el watermark contiguo no avanzaba
    // NUNCA y la cuadrilla quedaba congelada hasta que IClass purgara el resto.
    const future = {
      ok: {
        data: {
          objects: Array.from({ length: 100 }, (_, i) => ({
            latitude: -34.65,
            longitude: -59.44,
            dataRegistro: `26-07-2036 09:${String(i % 60).padStart(2, '0')}:00`,
            raio: 7,
            origem: 1,
          })),
        },
      },
    };
    const { client } = makeClient({
      post: [LOGIN_OK],
      get: [
        future,
        {
          ok: {
            data: {
              objects: [
                { latitude: -34.66, longitude: -59.45, dataRegistro: '26-07-2026 09:10:00', raio: 7, origem: 1 },
              ],
            },
          },
        },
        EMPTY_204,
        EMPTY_204,
      ],
    });

    const res = await client.listTeamLocations('1', 'IPNXANDYM', null, new Date('2026-07-26T13:00:00Z'));

    // Los futuros se descartan (y se cuentan), pero la paginación SIGUE y el rastro se
    // da por completo: la cuadrilla no queda bloqueada.
    expect(res.incomplete).toBe(false);
    expect(res.pointsDropped).toBe(100);
    expect(res.points).toHaveLength(1);
  });
});
