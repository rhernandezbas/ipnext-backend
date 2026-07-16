import type { AxiosInstance } from 'axios';
import { HttpRadiusOrchestratorGateway } from '@infrastructure/adapters/orchestrator/HttpRadiusOrchestratorGateway';
import { OrchestratorUnreachableError, OrchestratorRejectedError } from '@domain/errors/pppoe';

/**
 * radius-session-autocure BE-1 (REQ-CURE-3, S3.1-S3.4) — extensión ADITIVA del gateway:
 * cureSession() → POST /users/{username}/sessions/{sessionId}/cure, wire snake_case real
 * (contrato ORCH-1 commit d37de58): {cured, already_closed, closed_at, coa: [{nas_ip, status, detail}]}.
 * El gateway MAPEA already_closed→alreadyClosed, closed_at→closedAt, coa items → camelCase
 * (consistencia con el resto del port: nasIp, framedIp, etc.).
 */
function fakeHttp(data: unknown) {
  const http = {
    post:   jest.fn().mockResolvedValue({ data }),
    get:    jest.fn().mockResolvedValue({ data: {} }),
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

describe('HttpRadiusOrchestratorGateway.cureSession', () => {
  it('S3.1: llama a POST /users/{username}/sessions/{sessionId}/cure', async () => {
    const { http, gw } = fakeHttp({
      cured: true, already_closed: false, closed_at: '2026-07-16T10:05:00Z',
      coa: [{ nas_ip: '10.60.0.10', status: 'ack', detail: null }],
    });
    await gw.cureSession('cliente001', 'sid-123');
    expect(http.post).toHaveBeenCalledWith('/users/cliente001/sessions/sid-123/cure', {});
  });

  it('S3.4: sessionId con caracteres no alfanuméricos va con encodeURIComponent', async () => {
    const { http, gw } = fakeHttp({ cured: true, already_closed: false, closed_at: null, coa: [] });
    await gw.cureSession('cliente001', 'sid/raro con espacio&x=1');
    expect(http.post).toHaveBeenCalledWith(
      `/users/cliente001/sessions/${encodeURIComponent('sid/raro con espacio&x=1')}/cure`,
      {},
    );
  });

  it('mapea el wire snake_case → camelCase (cured, alreadyClosed, closedAt, coa)', async () => {
    const { gw } = fakeHttp({
      cured: true, already_closed: false, closed_at: '2026-07-16T10:05:00Z',
      coa: [{ nas_ip: '10.60.0.10', status: 'ack', detail: 'disconnect ok' }],
    });
    const result = await gw.cureSession('cliente001', 'sid-123');
    expect(result.cured).toBe(true);
    expect(result.alreadyClosed).toBe(false);
    expect(result.closedAt).toBe('2026-07-16T10:05:00Z');
    expect(result.coa).toEqual([{ nasIp: '10.60.0.10', status: 'ack', detail: 'disconnect ok' }]);
  });

  it('S3.2: already_closed:true en el wire → alreadyClosed:true, closedAt null (no-op limpio)', async () => {
    const { gw } = fakeHttp({ cured: false, already_closed: true, closed_at: null, coa: [] });
    const result = await gw.cureSession('cliente001', 'sid-123');
    expect(result.cured).toBe(false);
    expect(result.alreadyClosed).toBe(true);
    expect(result.closedAt).toBeNull();
    expect(result.coa).toEqual([]);
  });

  it('coa ausente en el wire → [] (defensivo)', async () => {
    const { gw } = fakeHttp({ cured: true, already_closed: false, closed_at: '2026-07-16T10:05:00Z' });
    const result = await gw.cureSession('cliente001', 'sid-123');
    expect(result.coa).toEqual([]);
  });

  it('404 upstream → OrchestratorRejectedError (la ruta/core lo mapea a session_not_found)', async () => {
    const err = Object.assign(new Error('404'), {
      isAxiosError: true,
      response: { status: 404, data: { detail: 'session not found' } },
    });
    const http = { post: jest.fn().mockRejectedValue(err) };
    const gw = new HttpRadiusOrchestratorGateway({
      baseUrl: 'http://orch:8080', token: 't', http: http as unknown as AxiosInstance,
    });
    const rejected = await gw.cureSession('cliente001', 'sid-x').catch((e) => e);
    expect(rejected).toBeInstanceOf(OrchestratorRejectedError);
    expect((rejected as OrchestratorRejectedError).upstreamStatus).toBe(404);
  });

  it('red/5xx → OrchestratorUnreachableError', async () => {
    const err = Object.assign(new Error('ECONNREFUSED'), { isAxiosError: true });
    const http = { post: jest.fn().mockRejectedValue(err) };
    const gw = new HttpRadiusOrchestratorGateway({
      baseUrl: 'http://orch:8080', token: 't', http: http as unknown as AxiosInstance,
    });
    await expect(gw.cureSession('cliente001', 'sid-x')).rejects.toBeInstanceOf(OrchestratorUnreachableError);
  });
});
