import axios from 'axios';
import type { AxiosInstance } from 'axios';
import { HttpRadiusOrchestratorGateway } from '@infrastructure/adapters/orchestrator/HttpRadiusOrchestratorGateway';
import { OrchestratorUnreachableError, OrchestratorRejectedError } from '@domain/errors/pppoe';

function fakeHttp(over?: Partial<Record<'post' | 'get' | 'delete', jest.Mock>>) {
  const http = {
    post: jest.fn().mockResolvedValue({ data: {} }),
    get: jest.fn().mockResolvedValue({ data: [] }),
    delete: jest.fn().mockResolvedValue({ data: {} }),
    ...over,
  };
  return { http, gw: new HttpRadiusOrchestratorGateway({ baseUrl: 'http://orch:8080', token: 't', http: http as unknown as AxiosInstance }) };
}

describe('HttpRadiusOrchestratorGateway (Inc3b — cliente HTTP real, espeja la API v0.1.0)', () => {
  it('createUser → POST /users con {username, password, plan, framed_ip}', async () => {
    const { http, gw } = fakeHttp();
    await gw.createUser({ username: 'juanperez', password: 'pass1234', plan: 'IP-Air-30-10', framedIp: '100.64.10.10' });
    expect(http.post).toHaveBeenCalledWith('/users', {
      username: 'juanperez',
      password: 'pass1234',
      plan: 'IP-Air-30-10',
      framed_ip: '100.64.10.10',
    });
  });

  it('createUser sin framedIp → framed_ip: null', async () => {
    const { http, gw } = fakeHttp();
    await gw.createUser({ username: 'juanperez', password: 'pass1234', plan: 'IP-Air-30-10' });
    expect(http.post).toHaveBeenCalledWith('/users', {
      username: 'juanperez',
      password: 'pass1234',
      plan: 'IP-Air-30-10',
      framed_ip: null,
    });
  });

  it('createUser: usuario duplicado (orchestrator 409) → OrchestratorRejectedError', async () => {
    const err = Object.assign(new Error('Request failed with status code 409'), {
      isAxiosError: true,
      response: { status: 409, data: { detail: 'user already exists' } },
    });
    const { gw } = fakeHttp({ post: jest.fn().mockRejectedValue(err) });
    const caught = await gw.createUser({ username: 'dup', password: 'p', plan: 'IP-Air-30-10' }).catch(e => e);
    expect(caught).toBeInstanceOf(OrchestratorRejectedError);
    expect((caught as OrchestratorRejectedError).upstreamStatus).toBe(409);
  });

  it('changePlan → POST /users/{u}/plan con {plan, apply_in_session}', async () => {
    const { http, gw } = fakeHttp();
    await gw.changePlan('JoseMassaMerc', 'IP-REDUCCION', { applyInSession: true });
    expect(http.post).toHaveBeenCalledWith('/users/JoseMassaMerc/plan', { plan: 'IP-REDUCCION', apply_in_session: true });
  });

  it('suspend → POST /users/{u}/suspend con {disconnect_active_sessions}', async () => {
    const { http, gw } = fakeHttp();
    await gw.suspend('JoseMassaMerc', { disconnectActiveSessions: true });
    expect(http.post).toHaveBeenCalledWith('/users/JoseMassaMerc/suspend', { disconnect_active_sessions: true, reason: null });
  });

  it('reactivate → POST /users/{u}/reactivate', async () => {
    const { http, gw } = fakeHttp();
    await gw.reactivate('JoseMassaMerc');
    expect(http.post).toHaveBeenCalledWith('/users/JoseMassaMerc/reactivate', {});
  });

  it('changePassword → POST /users/{u}/password con {password}', async () => {
    const { http, gw } = fakeHttp();
    await gw.changePassword('JoseMassaMerc', 'nuevaPass123');
    expect(http.post).toHaveBeenCalledWith('/users/JoseMassaMerc/password', { password: 'nuevaPass123' });
  });

  it('changeFramedIp → POST /users/{u}/framed-ip con {framed_ip}', async () => {
    const { http, gw } = fakeHttp();
    await gw.changeFramedIp('JoseMassaMerc', '100.64.10.20');
    expect(http.post).toHaveBeenCalledWith('/users/JoseMassaMerc/framed-ip', { framed_ip: '100.64.10.20' });
  });

  it('changeFramedIp con null → POST /users/{u}/framed-ip con {framed_ip: null} (IP del pool)', async () => {
    const { http, gw } = fakeHttp();
    await gw.changeFramedIp('JoseMassaMerc', null);
    expect(http.post).toHaveBeenCalledWith('/users/JoseMassaMerc/framed-ip', { framed_ip: null });
  });

  it('listSessions → GET /users/{u}/sessions y mapea snake_case → camelCase', async () => {
    const { gw } = fakeHttp({
      get: jest.fn().mockResolvedValue({
        data: [{ session_id: 's1', username: 'u', nas_ip: '10.60.0.38', framed_ip: '100.64.10.10', started_at: 'T', bytes_in: 10, bytes_out: 20 }],
      }),
    });
    const sessions = await gw.listSessions('u');
    expect(sessions).toEqual([{ sessionId: 's1', username: 'u', nasIp: '10.60.0.38', framedIp: '100.64.10.10', startedAt: 'T', bytesIn: 10, bytesOut: 20 }]);
  });

  it('disconnectSessions → DELETE /users/{u}/sessions (CoA)', async () => {
    const { http, gw } = fakeHttp();
    await gw.disconnectSessions('u');
    expect(http.delete).toHaveBeenCalledWith('/users/u/sessions');
  });

  it('encodea el username en la URL', async () => {
    const { http, gw } = fakeHttp();
    await gw.reactivate('Maria Jose/Merc');
    expect(http.post).toHaveBeenCalledWith('/users/Maria%20Jose%2FMerc/reactivate', {});
  });

  it('error de red/HTTP → OrchestratorUnreachableError', async () => {
    const { gw } = fakeHttp({ post: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) });
    await expect(gw.reactivate('u')).rejects.toBeInstanceOf(OrchestratorUnreachableError);
  });

  it('listAssignedIps → GET /assigned-ips y devuelve body.ips', async () => {
    const { http, gw } = fakeHttp({
      get: jest.fn().mockResolvedValue({ data: { ips: ['100.64.10.42', '100.64.10.43'] } }),
    });
    const ips = await gw.listAssignedIps();
    expect(http.get).toHaveBeenCalledWith('/assigned-ips');
    expect(ips).toEqual(['100.64.10.42', '100.64.10.43']);
  });

  it('listAssignedIps → sin ips en el body devuelve []', async () => {
    const { gw } = fakeHttp({ get: jest.fn().mockResolvedValue({ data: {} }) });
    const ips = await gw.listAssignedIps();
    expect(ips).toEqual([]);
  });

  it('listUsers → GET /users y mapea framed_ip → framedIp (con password)', async () => {
    const { http, gw } = fakeHttp({
      get: jest.fn().mockResolvedValue({
        data: [
          { username: 'juanperez', password: 'pass1234', plan: 'IP-Air-30-10', framed_ip: '100.64.10.10' },
          { username: 'mariam',    password: 'otra',     plan: null,           framed_ip: null },
        ],
      }),
    });
    const users = await gw.listUsers();
    expect(http.get).toHaveBeenCalledWith('/users');
    expect(users).toEqual([
      { username: 'juanperez', password: 'pass1234', plan: 'IP-Air-30-10', framedIp: '100.64.10.10' },
      { username: 'mariam',    password: 'otra',     plan: null,           framedIp: null },
    ]);
  });

  it('listUsers → body no-array devuelve []', async () => {
    const { gw } = fakeHttp({ get: jest.fn().mockResolvedValue({ data: {} }) });
    const users = await gw.listUsers();
    expect(users).toEqual([]);
  });
});

describe('HttpRadiusOrchestratorGateway — W2 4xx vs 5xx/red distinction', () => {
  function make4xxError(status: number, data: unknown) {
    const err = Object.assign(new Error(`Request failed with status code ${status}`), {
      isAxiosError: true,
      response: { status, data },
    });
    return err;
  }

  function fakeHttpRejecting(status: number, data: unknown) {
    const err = make4xxError(status, data);
    const http = {
      post:   jest.fn().mockRejectedValue(err),
      get:    jest.fn().mockRejectedValue(err),
      delete: jest.fn().mockRejectedValue(err),
      put:    jest.fn().mockRejectedValue(err),
    };
    const gw = new HttpRadiusOrchestratorGateway({
      baseUrl: 'http://orch:8080',
      token: 't',
      http: http as unknown as AxiosInstance,
    });
    return { http, gw };
  }

  it('syncPlan: orchestrator 403 → OrchestratorRejectedError (NO OrchestratorUnreachableError)', async () => {
    const { gw } = fakeHttpRejecting(403, { detail: 'plan code _BLOCKED is reserved' });
    await expect(gw.syncPlan('_BLOCKED', 10000, 5000))
      .rejects.toBeInstanceOf(OrchestratorRejectedError);
  });

  it('syncPlan: orchestrator 400 → OrchestratorRejectedError con status=400', async () => {
    const { gw } = fakeHttpRejecting(400, { detail: 'download_kbps out of range' });
    const err = await gw.syncPlan('IP-Bad', 9999999, 5000).catch(e => e);
    expect(err).toBeInstanceOf(OrchestratorRejectedError);
    expect((err as OrchestratorRejectedError).upstreamStatus).toBe(400);
  });

  it('syncPlan: orchestrator 409 → OrchestratorRejectedError con status=409', async () => {
    const { gw } = fakeHttpRejecting(409, { detail: 'code conflict' });
    const err = await gw.syncPlan('IP-Dup', 10000, 5000).catch(e => e);
    expect(err).toBeInstanceOf(OrchestratorRejectedError);
    expect((err as OrchestratorRejectedError).upstreamStatus).toBe(409);
  });

  it('syncPlan: orchestrator 403 → OrchestratorRejectedError preserva el mensaje del body', async () => {
    const { gw } = fakeHttpRejecting(403, { detail: 'plan code _BLOCKED is reserved' });
    const err = await gw.syncPlan('_BLOCKED', 10000, 5000).catch(e => e);
    expect((err as OrchestratorRejectedError).message).toContain('_BLOCKED is reserved');
  });

  it('deletePlan: orchestrator 404 → OrchestratorRejectedError (NO 502)', async () => {
    const { gw } = fakeHttpRejecting(404, { detail: 'plan not found in RADIUS' });
    await expect(gw.deletePlan('IP-Gone'))
      .rejects.toBeInstanceOf(OrchestratorRejectedError);
  });

  it('deletePlan: orchestrator 404 → OrchestratorRejectedError con status=404', async () => {
    const { gw } = fakeHttpRejecting(404, { detail: 'plan not found' });
    const err = await gw.deletePlan('IP-Gone').catch(e => e);
    expect((err as OrchestratorRejectedError).upstreamStatus).toBe(404);
  });

  it('red caída / timeout → sigue siendo OrchestratorUnreachableError (502)', async () => {
    const { gw } = fakeHttpRejecting(0, null); // sin response = red caída
    // Reemplazamos el error por uno sin .response para simular error de red real
    const httpNoResponse = {
      put: jest.fn().mockRejectedValue(Object.assign(new Error('ECONNREFUSED'), { isAxiosError: true })),
    };
    const gwNet = new HttpRadiusOrchestratorGateway({
      baseUrl: 'http://orch:8080',
      token: 't',
      http: httpNoResponse as unknown as AxiosInstance,
    });
    await expect(gwNet.syncPlan('IP-Air', 10000, 5000))
      .rejects.toBeInstanceOf(OrchestratorUnreachableError);
  });

  it('5xx del orchestrator → OrchestratorUnreachableError (502)', async () => {
    const http5xx = {
      put: jest.fn().mockRejectedValue(
        Object.assign(new Error('Internal Server Error'), {
          isAxiosError: true,
          response: { status: 503, data: { detail: 'service unavailable' } },
        }),
      ),
    };
    const gw5xx = new HttpRadiusOrchestratorGateway({
      baseUrl: 'http://orch:8080',
      token: 't',
      http: http5xx as unknown as AxiosInstance,
    });
    await expect(gw5xx.syncPlan('IP-Air', 10000, 5000))
      .rejects.toBeInstanceOf(OrchestratorUnreachableError);
  });
});
