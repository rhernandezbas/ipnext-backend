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

const sampleOrchestratorResponse = {
  items: [
    {
      unique_id:        'a1b2c3',
      username:         'cliente001',
      nasipaddress:     '10.75.0.30',
      framedipaddress:  '100.64.1.2',
      callingstationid: 'AA:BB:CC:DD:EE:FF',
      vlan:             3713,
      acctstarttime:    '2026-06-22T13:04:11Z',
      acctstoptime:     null,
      acctsessiontime:  0,
      acctinputoctets:  '1048576',
      acctoutputoctets: '2097152',
    },
  ],
  page: 1,
  page_size: 500,
  next_page: null,
};

describe('HttpRadiusOrchestratorGateway.listAccounting', () => {
  it('llama a GET /accounting sin params cuando filters está vacío', async () => {
    const { http, gw } = fakeHttpGet(sampleOrchestratorResponse);
    await gw.listAccounting({});
    expect(http.get).toHaveBeenCalledWith('/accounting', { params: {} });
  });

  it('FIX2: serializa sinceUpdate → since_update en los query params', async () => {
    const { http, gw } = fakeHttpGet(sampleOrchestratorResponse);
    await gw.listAccounting({ sinceUpdate: '2026-06-01T00:00:00Z' });
    expect(http.get).toHaveBeenCalledWith('/accounting', {
      params: { since_update: '2026-06-01T00:00:00Z' },
    });
  });

  it('FIX2: serializa todos los filtros a snake_case con since_update/until_update, omite undefined', async () => {
    const { http, gw } = fakeHttpGet(sampleOrchestratorResponse);
    await gw.listAccounting({
      sinceUpdate:  '2026-06-01T00:00:00Z',
      untilUpdate:  '2026-06-22T00:00:00Z',
      username:     'cliente001',
      nasIpAddress: '10.75.0.30',
      page:         2,
      pageSize:     100,
    });
    expect(http.get).toHaveBeenCalledWith('/accounting', {
      params: {
        since_update:  '2026-06-01T00:00:00Z',
        until_update:  '2026-06-22T00:00:00Z',
        username:      'cliente001',
        nasipaddress:  '10.75.0.30',
        page:          2,
        page_size:     100,
      },
    });
  });

  it('mapea la respuesta snake_case → AccountingPage (camelCase), octets → bigint', async () => {
    const { gw } = fakeHttpGet(sampleOrchestratorResponse);
    const page = await gw.listAccounting({});

    expect(page.page).toBe(1);
    expect(page.pageSize).toBe(500);
    expect(page.nextPage).toBeNull();
    expect(page.items).toHaveLength(1);

    const ev = page.items[0];
    expect(ev.uniqueId).toBe('a1b2c3');
    expect(ev.username).toBe('cliente001');
    expect(ev.nasIpAddress).toBe('10.75.0.30');
    expect(ev.framedIp).toBe('100.64.1.2');
    expect(ev.macAddress).toBe('AA:BB:CC:DD:EE:FF');
    expect(ev.vlan).toBe(3713);
    expect(ev.startedAt).toBe('2026-06-22T13:04:11Z');
    expect(ev.stoppedAt).toBeNull();
    expect(ev.sessionTime).toBe(0);
    expect(ev.inOctets).toBe(BigInt(1048576));
    expect(ev.outOctets).toBe(BigInt(2097152));
  });

  it('campos nullable: framedip/mac/vlan/stoppedAt null → null', async () => {
    const { gw } = fakeHttpGet({
      items: [{
        unique_id:        'x1',
        username:         'u',
        nasipaddress:     '10.0.0.1',
        framedipaddress:  null,
        callingstationid: null,
        vlan:             null,
        acctstarttime:    '2026-06-22T00:00:00Z',
        acctstoptime:     null,
        acctsessiontime:  null,
        acctinputoctets:  '0',
        acctoutputoctets: '0',
      }],
      page: 1,
      page_size: 500,
      next_page: null,
    });
    const page = await gw.listAccounting({});
    const ev = page.items[0];
    expect(ev.framedIp).toBeNull();
    expect(ev.macAddress).toBeNull();
    expect(ev.vlan).toBeNull();
    expect(ev.stoppedAt).toBeNull();
    expect(ev.sessionTime).toBeNull();
  });

  it('next_page numérico → nextPage como número', async () => {
    const { gw } = fakeHttpGet({ ...sampleOrchestratorResponse, next_page: 3 });
    const page = await gw.listAccounting({});
    expect(page.nextPage).toBe(3);
  });

  it('octets como string BigInt-safe → parseados a bigint correctamente', async () => {
    // 10 TB — más allá de Number.MAX_SAFE_INTEGER
    const bigNum = '10995116277760';
    const { gw } = fakeHttpGet({
      items: [{ ...sampleOrchestratorResponse.items[0], acctinputoctets: bigNum, acctoutputoctets: bigNum }],
      page: 1, page_size: 500, next_page: null,
    });
    const page = await gw.listAccounting({});
    expect(page.items[0].inOctets).toBe(BigInt('10995116277760'));
    expect(page.items[0].outOctets).toBe(BigInt('10995116277760'));
  });

  it('orchestrator 4xx → OrchestratorRejectedError', async () => {
    const err = Object.assign(new Error('400 Bad Request'), {
      isAxiosError: true,
      response: { status: 400, data: { detail: 'bad param' } },
    });
    const http = { get: jest.fn().mockRejectedValue(err) };
    const gw = new HttpRadiusOrchestratorGateway({
      baseUrl: 'http://orch:8080',
      token: 't',
      http: http as unknown as AxiosInstance,
    });
    await expect(gw.listAccounting({})).rejects.toBeInstanceOf(OrchestratorRejectedError);
  });

  it('orchestrator 422 → OrchestratorRejectedError con status 422', async () => {
    const err = Object.assign(new Error('422'), {
      isAxiosError: true,
      response: { status: 422, data: { detail: 'unprocessable' } },
    });
    const http = { get: jest.fn().mockRejectedValue(err) };
    const gw = new HttpRadiusOrchestratorGateway({
      baseUrl: 'http://orch:8080',
      token: 't',
      http: http as unknown as AxiosInstance,
    });
    const caught = await gw.listAccounting({}).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(OrchestratorRejectedError);
    expect((caught as OrchestratorRejectedError).upstreamStatus).toBe(422);
  });

  it('orchestrator 500 → OrchestratorUnreachableError', async () => {
    const err = Object.assign(new Error('500'), {
      isAxiosError: true,
      response: { status: 500, data: {} },
    });
    const http = { get: jest.fn().mockRejectedValue(err) };
    const gw = new HttpRadiusOrchestratorGateway({
      baseUrl: 'http://orch:8080',
      token: 't',
      http: http as unknown as AxiosInstance,
    });
    await expect(gw.listAccounting({})).rejects.toBeInstanceOf(OrchestratorUnreachableError);
  });

  it('error de red (sin response) → OrchestratorUnreachableError', async () => {
    const err = Object.assign(new Error('ECONNREFUSED'), { isAxiosError: true });
    const http = { get: jest.fn().mockRejectedValue(err) };
    const gw = new HttpRadiusOrchestratorGateway({
      baseUrl: 'http://orch:8080',
      token: 't',
      http: http as unknown as AxiosInstance,
    });
    await expect(gw.listAccounting({})).rejects.toBeInstanceOf(OrchestratorUnreachableError);
  });

  it('FIX2: filters undefined no generan params extra en la query string', async () => {
    const { http, gw } = fakeHttpGet(sampleOrchestratorResponse);
    await gw.listAccounting({ sinceUpdate: '2026-06-01T00:00:00Z' });
    const call = http.get.mock.calls[0];
    const params = call[1].params as Record<string, unknown>;
    // No debe haber llaves con undefined ni null para campos no pasados
    for (const [key, val] of Object.entries(params)) {
      expect(val).not.toBeUndefined();
      if (key !== 'since_update') {
        fail(`param inesperado en query string: ${key}=${String(val)}`);
      }
    }
  });

  it('FIX2: mapea acctupdatetime → lastUpdate en AccountingEventRow', async () => {
    const { gw } = fakeHttpGet({
      items: [{
        ...sampleOrchestratorResponse.items[0],
        acctupdatetime: '2026-06-22T15:00:00Z',
      }],
      page: 1, page_size: 500, next_page: null,
    });
    const page = await gw.listAccounting({});
    expect(page.items[0].lastUpdate).toBe('2026-06-22T15:00:00Z');
  });

  it('FIX2: acctupdatetime ausente → lastUpdate null', async () => {
    const { gw } = fakeHttpGet(sampleOrchestratorResponse);
    const page = await gw.listAccounting({});
    expect(page.items[0].lastUpdate).toBeNull();
  });
});
