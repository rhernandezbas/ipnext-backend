import type { AxiosInstance } from 'axios';
import { HttpRadiusOrchestratorGateway } from '@infrastructure/adapters/orchestrator/HttpRadiusOrchestratorGateway';
import { OrchestratorUnreachableError, OrchestratorRejectedError } from '@domain/errors/pppoe';

function fakeHttpGet(data: unknown) {
  const http = {
    post:   jest.fn().mockResolvedValue({ data: {} }),
    get:    jest.fn().mockResolvedValue({ data }),
    delete: jest.fn().mockResolvedValue({ data: {} }),
    put:    jest.fn().mockResolvedValue({ data: {} }),
  };
  const gw = new HttpRadiusOrchestratorGateway({
    baseUrl: 'http://orch:8080',
    token: 'test-token',
    http: http as unknown as AxiosInstance,
  });
  return { http, gw };
}

const sampleResponse = {
  items: [
    {
      source_id: 'pa-001',
      username:  'cliente001',
      reply:     'Access-Reject',
      authdate:  '2026-06-22T13:04:11Z',
      class:     'CLASS-XYZ',
    },
  ],
  page: 1,
  page_size: 500,
  next_page: null,
};

describe('HttpRadiusOrchestratorGateway.listPostauth', () => {
  it('llama a GET /postauth sin params cuando filters está vacío', async () => {
    const { http, gw } = fakeHttpGet(sampleResponse);
    await gw.listPostauth({});
    expect(http.get).toHaveBeenCalledWith('/postauth', { params: {} });
  });

  it('serializa sinceAuthdate → since_authdate en los query params', async () => {
    const { http, gw } = fakeHttpGet(sampleResponse);
    await gw.listPostauth({ sinceAuthdate: '2026-06-01T00:00:00Z' });
    expect(http.get).toHaveBeenCalledWith('/postauth', {
      params: { since_authdate: '2026-06-01T00:00:00Z' },
    });
  });

  it('serializa todos los filtros a snake_case, omite undefined', async () => {
    const { http, gw } = fakeHttpGet(sampleResponse);
    await gw.listPostauth({
      sinceAuthdate: '2026-06-01T00:00:00Z',
      untilAuthdate: '2026-06-22T00:00:00Z',
      username:      'cliente001',
      reply:         'Access-Reject',
      page:          2,
      pageSize:      100,
    });
    expect(http.get).toHaveBeenCalledWith('/postauth', {
      params: {
        since_authdate: '2026-06-01T00:00:00Z',
        until_authdate: '2026-06-22T00:00:00Z',
        username:       'cliente001',
        reply:          'Access-Reject',
        page:           2,
        page_size:      100,
      },
    });
  });

  it('mapea la respuesta snake_case → PostauthPage (camelCase)', async () => {
    const { gw } = fakeHttpGet(sampleResponse);
    const page = await gw.listPostauth({});

    expect(page.page).toBe(1);
    expect(page.pageSize).toBe(500);
    expect(page.nextPage).toBeNull();
    expect(page.items).toHaveLength(1);

    const ev = page.items[0];
    expect(ev.sourceId).toBe('pa-001');
    expect(ev.username).toBe('cliente001');
    expect(ev.reply).toBe('Access-Reject');
    expect(ev.authdate).toBe('2026-06-22T13:04:11Z');
    expect(ev.class).toBe('CLASS-XYZ');
  });

  it('BUG-PROD: source_id viene como NUMBER (radpostauth.id int) → sourceId DEBE ser string', async () => {
    // El orchestrator real devuelve source_id como número (id auto_increment de radpostauth).
    // RadiusAuthEvent.sourceUniqueId es String en Prisma → si no se stringifica acá,
    // el upsert revienta ("Expected String, provided Int") y la tabla queda en 0.
    const { gw } = fakeHttpGet({
      items: [{ source_id: 1, username: 'test-user', reply: 'Access-Reject', authdate: '2026-06-22T13:04:11Z', class: null }],
      page: 1, page_size: 500, next_page: null,
    });
    const page = await gw.listPostauth({});
    const ev = page.items[0];
    expect(ev.sourceId).toBe('1');
    expect(typeof ev.sourceId).toBe('string');
  });

  it('class ausente → null', async () => {
    const { gw } = fakeHttpGet({
      items: [{ source_id: 'x1', username: 'u', reply: 'Access-Accept', authdate: '2026-06-22T00:00:00Z' }],
      page: 1, page_size: 500, next_page: null,
    });
    const page = await gw.listPostauth({});
    expect(page.items[0].class).toBeNull();
  });

  it('next_page numérico → nextPage como número', async () => {
    const { gw } = fakeHttpGet({ ...sampleResponse, next_page: 3 });
    const page = await gw.listPostauth({});
    expect(page.nextPage).toBe(3);
  });

  it('orchestrator 4xx → OrchestratorRejectedError', async () => {
    const err = Object.assign(new Error('400 Bad Request'), {
      isAxiosError: true,
      response: { status: 400, data: { detail: 'bad param' } },
    });
    const http = { get: jest.fn().mockRejectedValue(err) };
    const gw = new HttpRadiusOrchestratorGateway({
      baseUrl: 'http://orch:8080', token: 't', http: http as unknown as AxiosInstance,
    });
    await expect(gw.listPostauth({})).rejects.toBeInstanceOf(OrchestratorRejectedError);
  });

  it('orchestrator 500 → OrchestratorUnreachableError', async () => {
    const err = Object.assign(new Error('500'), {
      isAxiosError: true,
      response: { status: 500, data: {} },
    });
    const http = { get: jest.fn().mockRejectedValue(err) };
    const gw = new HttpRadiusOrchestratorGateway({
      baseUrl: 'http://orch:8080', token: 't', http: http as unknown as AxiosInstance,
    });
    await expect(gw.listPostauth({})).rejects.toBeInstanceOf(OrchestratorUnreachableError);
  });

  it('error de red (sin response) → OrchestratorUnreachableError', async () => {
    const err = Object.assign(new Error('ECONNREFUSED'), { isAxiosError: true });
    const http = { get: jest.fn().mockRejectedValue(err) };
    const gw = new HttpRadiusOrchestratorGateway({
      baseUrl: 'http://orch:8080', token: 't', http: http as unknown as AxiosInstance,
    });
    await expect(gw.listPostauth({})).rejects.toBeInstanceOf(OrchestratorUnreachableError);
  });

  it('filters undefined no generan params extra en la query string', async () => {
    const { http, gw } = fakeHttpGet(sampleResponse);
    await gw.listPostauth({ sinceAuthdate: '2026-06-01T00:00:00Z' });
    const call = http.get.mock.calls[0];
    const params = call[1].params as Record<string, unknown>;
    for (const [key, val] of Object.entries(params)) {
      expect(val).not.toBeUndefined();
      if (key !== 'since_authdate') {
        fail(`param inesperado en query string: ${key}=${String(val)}`);
      }
    }
  });
});
