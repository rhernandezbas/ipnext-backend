import { IClassClient } from '@infrastructure/adapters/iclass/IClassClient';

/**
 * Paginación del rastro GPS de cuadrillas (change `iclass-gps-audit`, delta REQ-ICLASS-LOC-*).
 *
 * El defecto que estos tests blindan es SILENCIOSO: traer de menos y parecer exitoso.
 * Medido contra la API real — cortar en la primera página incompleta trajo 2.600 de
 * 6.286 puntos (59% perdido, sin un solo error).
 */

function axiosError(status: number, data?: unknown) {
  const err = new Error(`HTTP ${status}`) as Error & {
    response?: { status: number; data?: unknown };
    isAxiosError: boolean;
  };
  err.isAxiosError = true;
  err.response = { status, data };
  return err;
}

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
  const http = {
    post: jest.fn((url: string) => {
      calls.push({ method: 'POST', url });
      return next(script.post);
    }),
    get: jest.fn((url: string) => {
      calls.push({ method: 'GET', url });
      return next(script.get);
    }),
  };
  return { http, calls };
}

const LOGIN_OK = { ok: { data: { access_token: 'tok' } } };

/** Página de `n` breadcrumbs; el paginador de IClass NO incluye hasMoreElements. */
function locationPage(n: number, startMinute = 0) {
  const objects = Array.from({ length: n }, (_, i) => ({
    latitude: -34.65 - i * 0.0001,
    longitude: -59.44,
    dataRegistro: `26-07-2026 ${String(9 + Math.floor((startMinute + i) / 60)).padStart(2, '0')}:${String((startMinute + i) % 60).padStart(2, '0')}:00`,
    raio: 7.5,
    origem: 1,
  }));
  return { ok: { data: { currentpage: 1, pagesize: 100, offset: 0, objects } } };
}

/** IClass responde 204 con cuerpo vacío (no un objeto). */
const EMPTY_204 = { ok: { data: '' } };

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

describe('IClassClient — listTeamLocations (REQ-ICLASS-LOC-2)', () => {
  it('does NOT stop on a short page mid-stream', async () => {
    const { client, calls } = makeClient({
      post: [LOGIN_OK],
      get: [
        locationPage(100, 0),
        locationPage(63, 100), // CORTA pero NO es la última — el bug que perdió el 59%
        locationPage(100, 200),
        EMPTY_204,
        EMPTY_204,
      ],
    });

    const res = await client.listTeamLocations('30598635', 'IPNXANDYM');

    expect(res.points).toHaveLength(263);
    expect(res.incomplete).toBe(false);
    // 5 GETs: llegó más allá de la página corta
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(5);
  });

  it('stops after TWO consecutive empty pages, not one', async () => {
    const { client, calls } = makeClient({
      post: [LOGIN_OK],
      get: [locationPage(100, 0), EMPTY_204, locationPage(50, 100), EMPTY_204, EMPTY_204],
    });

    const res = await client.listTeamLocations('30598635', 'IPNXANDYM');

    // La página vacía intermedia NO cortó: los 50 puntos posteriores entraron.
    expect(res.points).toHaveLength(150);
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(5);
  });

  it('never relies on hasMoreElements / totalpages / totalobjects', async () => {
    // IClass NO los devuelve (medido). Si la implementación los consultara, cortaría en la 1.
    const { client } = makeClient({
      post: [LOGIN_OK],
      get: [locationPage(100, 0), locationPage(100, 100), EMPTY_204, EMPTY_204],
    });

    const res = await client.listTeamLocations('30598635', 'IPNXANDYM');
    expect(res.points).toHaveLength(200);
  });

  it('parses the payload into domain points with Argentina time normalised to UTC', async () => {
    const { client } = makeClient({
      post: [LOGIN_OK],
      get: [
        {
          ok: {
            data: {
              objects: [
                {
                  latitude: -34.6517124,
                  longitude: -59.44804908,
                  dataRegistro: '26-07-2026 09:08:32',
                  raio: 7.3713,
                  origem: 1,
                },
              ],
            },
          },
        },
        EMPTY_204,
        EMPTY_204,
      ],
    });

    const res = await client.listTeamLocations('30598635', 'IPNXANDYM');
    const p = res.points[0];
    expect(p.teamLogin).toBe('IPNXANDYM');
    expect(p.latitude).toBeCloseTo(-34.6517124, 6);
    expect(p.accuracyMeters).toBeCloseTo(7.3713, 4);
    expect(p.sources).toEqual([1]);
    // 09:08:32 AR == 12:08:32 UTC — el container de prod corre en UTC
    expect(p.recordedAt.toISOString()).toBe('2026-07-26T12:08:32.000Z');
  });

  it('drops points with an unparseable timestamp instead of emitting Invalid Date', async () => {
    const { client } = makeClient({
      post: [LOGIN_OK],
      get: [
        {
          ok: {
            data: {
              objects: [
                { latitude: -34.65, longitude: -59.44, dataRegistro: 'basura', raio: 7, origem: 1 },
                { latitude: -34.66, longitude: -59.45, dataRegistro: '26-07-2026 09:10:00', raio: 7, origem: 1 },
              ],
            },
          },
        },
        EMPTY_204,
        EMPTY_204,
      ],
    });

    const res = await client.listTeamLocations('30598635', 'IPNXANDYM');
    expect(res.points).toHaveLength(1);
    expect(res.points[0].recordedAt.toISOString()).toBe('2026-07-26T12:10:00.000Z');
  });

  it('applies the watermark WITH a 2h overlap (offline-buffered breadcrumbs)', async () => {
    // El rastro viene DESCENDENTE: alcanzado el watermark no hace falta seguir paginando.
    const { client, calls } = makeClient({
      post: [LOGIN_OK],
      get: [
        {
          ok: {
            data: {
              objects: [
                { latitude: -34.65, longitude: -59.44, dataRegistro: '26-07-2026 09:10:00', raio: 7, origem: 1 },
                { latitude: -34.65, longitude: -59.44, dataRegistro: '26-07-2026 09:00:00', raio: 7, origem: 1 },
                { latitude: -34.65, longitude: -59.44, dataRegistro: '26-07-2026 08:50:00', raio: 7, origem: 1 },
              ],
            },
          },
        },
        EMPTY_204,
        EMPTY_204,
      ],
    });

    // watermark 12:00 UTC − 2 h de solapamiento = 10:00 UTC. Los tres puntos del fixture
    // (12:10, 12:00, 11:50) quedan POR ENCIMA, así que ninguno corta: el adapter sigue
    // paginando hasta el fin natural del rastro.
    const watermark = new Date('2026-07-26T12:00:00.000Z'); // == 09:00 AR
    const res = await client.listTeamLocations('30598635', 'IPNXANDYM', watermark);

    // El watermark se aplica con un SOLAPAMIENTO de 2 h (hallazgo 2.7): un celular sin
    // señal bufferea fixes y los sube al reconectar con timestamps anteriores. Sin
    // solapamiento se perdían para siempre — justo el caso que la auditoría necesita.
    // Releer es gratis: el unique de la base deduplica.
    expect(res.points).toHaveLength(3);
    expect(res.points[0].recordedAt.toISOString()).toBe('2026-07-26T12:10:00.000Z');
  });

  it('marks the window INCOMPLETE when the rate limit never clears (REQ 2.6)', async () => {
    const { client } = makeClient({
      post: [LOGIN_OK],
      get: [
        locationPage(100, 0),
        { err: axiosError(429) },
        { err: axiosError(429) },
        { err: axiosError(429) },
        { err: axiosError(429) },
        { err: axiosError(429) },
        { err: axiosError(429) },
      ],
    });

    const res = await client.listTeamLocations('30598635', 'IPNXANDYM');

    // Devuelve lo que alcanzó a leer, pero NO lo reporta como éxito.
    expect(res.incomplete).toBe(true);
    expect(res.points.length).toBeGreaterThan(0);
  });
});

describe('IClassClient — getLastTeamLocation (REQ-ICLASS-LOC-1)', () => {
  it('returns the point for a team that reports', async () => {
    const { client } = makeClient({
      post: [LOGIN_OK],
      get: [
        {
          ok: {
            data: {
              latitude: -34.6585033333,
              longitude: -59.4538666667,
              dataRegistro: '26-07-2026 09:41:45',
              raio: 6.4,
              origem: 1,
            },
          },
        },
      ],
    });

    const p = await client.getLastTeamLocation('IPNXDENIC');
    expect(p).not.toBeNull();
    expect(p!.teamLogin).toBe('IPNXDENIC');
    expect(p!.recordedAt.toISOString()).toBe('2026-07-26T12:41:45.000Z');
  });

  it('returns null on 204 instead of throwing (cancelled/duplicate logins)', async () => {
    // 5 de los 11 logins de IPNEXT están en esta condición. Tratarlo como error
    // rompería el ingest en CADA corrida.
    const { client } = makeClient({ post: [LOGIN_OK], get: [EMPTY_204] });
    await expect(client.getLastTeamLocation('IPNXSEBAM')).resolves.toBeNull();
  });
});

describe('IClassClient — listTeamLocationDescriptors (REQ-ICLASS-LOC-4)', () => {
  it('extracts the team id from the embedded locations URL when id is null', async () => {
    const { client } = makeClient({
      post: [LOGIN_OK],
      get: [
        {
          ok: {
            data: {
              objects: [
                {
                  id: null,
                  login: 'IPNXANDYM',
                  nome: 'Andy Medina',
                  status: 'Inativo',
                  localizacoes: '/teams/30598635/locations',
                },
              ],
            },
          },
        },
      ],
    });

    const teams = await client.listTeamLocationDescriptors();
    expect(teams).toHaveLength(1);
    expect(teams[0]).toEqual({
      login: 'IPNXANDYM',
      name: 'Andy Medina',
      externalId: '30598635',
      status: 'Inativo',
    });
  });

  it('skips teams whose locations URL cannot be parsed', async () => {
    const { client } = makeClient({
      post: [LOGIN_OK],
      get: [
        {
          ok: {
            data: {
              objects: [
                { id: null, login: 'BAD', nome: 'x', localizacoes: null },
                { id: null, login: 'OK', nome: 'y', localizacoes: '/teams/999/locations' },
              ],
            },
          },
        },
      ],
    });

    const teams = await client.listTeamLocationDescriptors();
    expect(teams.map((t) => t.login)).toEqual(['OK']);
  });
});
