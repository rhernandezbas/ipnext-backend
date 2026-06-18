import type { AxiosInstance } from 'axios';
import { HttpRadiusOrchestratorGateway } from '@infrastructure/adapters/orchestrator/HttpRadiusOrchestratorGateway';
import { OrchestratorUnreachableError } from '@domain/errors/pppoe';

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
});
