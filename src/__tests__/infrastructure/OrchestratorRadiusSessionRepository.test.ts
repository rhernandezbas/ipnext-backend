/**
 * OrchestratorRadiusSessionRepository.test.ts
 *
 * El adapter que hace que el tab "Sesiones activas" muestre las sesiones REALES EN VIVO del
 * radius-orchestrator (GET /sessions) en lugar de la tabla LOCAL `radiusSession` (mock, siempre 0).
 *
 * Implementa RadiusSessionRepository.listSessions() llamando al gateway.listActiveSessions()
 * y mapeando OrchestratorSession → RadiusSession. El cruce a contrato lo sigue haciendo
 * ListRadiusSessions (use case) por username; este repo deja contractId/clientId/customerName en null.
 *
 * LÍMITE CONOCIDO (no es bug): el orchestrator HA solo ve Acceso Sur/NE8000; las sesiones de
 * MikroTik legacy NO están ahí.
 */
import { OrchestratorRadiusSessionRepository } from '@infrastructure/adapters/orchestrator/OrchestratorRadiusSessionRepository';
import { InMemoryRadiusOrchestratorGateway } from '@infrastructure/adapters/in-memory/InMemoryRadiusOrchestratorGateway';
import { OrchestratorSession } from '@domain/ports/RadiusOrchestratorGateway';
import { OrchestratorUnreachableError } from '@domain/errors/pppoe';

function makeOrchSession(overrides: Partial<OrchestratorSession> = {}): OrchestratorSession {
  return {
    sessionId: 'ACCT-1',
    username: 'juan@ipnext.com.ar',
    nasIp: '10.60.0.38',
    framedIp: '100.64.10.10',
    startedAt: '2026-06-23T10:00:00Z',
    bytesIn: 1000,   // subida (acctinputoctets)
    bytesOut: 5000,  // bajada (acctoutputoctets)
    callerId: '78:8A:20:96:6A:AE',
    ...overrides,
  };
}

describe('OrchestratorRadiusSessionRepository.listSessions', () => {
  it('trae las sesiones EN VIVO del orchestrator (GET /sessions), NO la tabla local', async () => {
    const gateway = new InMemoryRadiusOrchestratorGateway({
      globalSessions: [
        makeOrchSession({ sessionId: 's1', username: 'a@ipnext.com.ar' }),
        makeOrchSession({ sessionId: 's2', username: 'b@ipnext.com.ar' }),
      ],
    });
    const repo = new OrchestratorRadiusSessionRepository(gateway);

    const sessions = await repo.listSessions();

    expect(sessions).toHaveLength(2);
    expect(sessions.map(s => s.username).sort()).toEqual(['a@ipnext.com.ar', 'b@ipnext.com.ar']);
  });

  it('mapea OrchestratorSession → RadiusSession (campos clave)', async () => {
    const gateway = new InMemoryRadiusOrchestratorGateway({
      globalSessions: [makeOrchSession()],
    });
    const repo = new OrchestratorRadiusSessionRepository(gateway);

    const [s] = await repo.listSessions();

    expect(s.sessionId).toBe('ACCT-1');
    expect(s.username).toBe('juan@ipnext.com.ar');
    expect(s.ipAddress).toBe('100.64.10.10');     // framedIp
    expect(s.macAddress).toBe('78:8A:20:96:6A:AE'); // callerId
    expect(s.nasId).toBe('10.60.0.38');            // nasIp (el orchestrator solo expone nasIp)
    expect(s.nasName).toBe('10.60.0.38');
    expect(s.startedAt).toBe('2026-06-23T10:00:00Z');
    // bytesOut = bajada (download), bytesIn = subida (upload)
    expect(s.downloadBytes).toBe(5000);
    expect(s.uploadBytes).toBe(1000);
    expect(s.status).toBe('active');
    // El cruce a contrato lo hace el use case (ListRadiusSessions) por username → null acá.
    expect(s.contractId).toBeNull();
    expect(s.clientId).toBeNull();
    expect(s.customerName).toBeNull();
  });

  it('id estable = sessionId del orchestrator (para que DELETE /sessions/:id tenga referencia)', async () => {
    const gateway = new InMemoryRadiusOrchestratorGateway({
      globalSessions: [makeOrchSession({ sessionId: 'ACCT-XYZ' })],
    });
    const repo = new OrchestratorRadiusSessionRepository(gateway);

    const [s] = await repo.listSessions();

    expect(s.id).toBe('ACCT-XYZ');
  });

  it('duration = segundos desde startedAt (computado, el orchestrator no lo expone)', async () => {
    const startedAt = new Date(Date.now() - 60_000).toISOString(); // hace 60s
    const gateway = new InMemoryRadiusOrchestratorGateway({
      globalSessions: [makeOrchSession({ startedAt })],
    });
    const repo = new OrchestratorRadiusSessionRepository(gateway);

    const [s] = await repo.listSessions();

    expect(s.duration).toBeGreaterThanOrEqual(59);
    expect(s.duration).toBeLessThanOrEqual(120);
  });

  it('framedIp/callerId null → ipAddress/macAddress null', async () => {
    const gateway = new InMemoryRadiusOrchestratorGateway({
      globalSessions: [makeOrchSession({ framedIp: null, callerId: null })],
    });
    const repo = new OrchestratorRadiusSessionRepository(gateway);

    const [s] = await repo.listSessions();

    expect(s.ipAddress).toBeNull();
    expect(s.macAddress).toBeNull();
  });

  it('lista vacía → []', async () => {
    const gateway = new InMemoryRadiusOrchestratorGateway({ globalSessions: [] });
    const repo = new OrchestratorRadiusSessionRepository(gateway);

    expect(await repo.listSessions()).toEqual([]);
  });

  it('orchestrator caído → propaga OrchestratorUnreachableError (la ruta → 502)', async () => {
    const gateway = new InMemoryRadiusOrchestratorGateway({ globalSessionsUnreachable: true });
    const repo = new OrchestratorRadiusSessionRepository(gateway);

    await expect(repo.listSessions()).rejects.toBeInstanceOf(OrchestratorUnreachableError);
  });
});

describe('OrchestratorRadiusSessionRepository.disconnectSession', () => {
  it('apunta al orchestrator (DELETE /users/:u/sessions) por username = id de la sesión viva', async () => {
    const gateway = new InMemoryRadiusOrchestratorGateway({
      globalSessions: [makeOrchSession({ sessionId: 's1', username: 'juan@ipnext.com.ar' })],
    });
    const repo = new OrchestratorRadiusSessionRepository(gateway);

    // El id que el FE manda en DELETE /sessions/:id es el sessionId; resolvemos el username
    // de la sesión viva y llamamos al CoA-Disconnect del orchestrator.
    const result = await repo.disconnectSession('s1');

    expect(result.success).toBe(true);
    expect(gateway.opsFor('juan@ipnext.com.ar')).toContain('disconnectSessions');
  });

  it('id desconocido (sesión ya no viva) → success false, no llama al orchestrator', async () => {
    const gateway = new InMemoryRadiusOrchestratorGateway({ globalSessions: [] });
    const repo = new OrchestratorRadiusSessionRepository(gateway);

    const result = await repo.disconnectSession('ghost');

    expect(result.success).toBe(false);
  });
});
