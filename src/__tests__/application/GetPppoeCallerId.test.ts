/**
 * GetPppoeCallerId.test.ts — TDD
 *
 * Cubre:
 *   - returns callerId from the most recent active session
 *   - returns null when no session exists
 *   - throws PppoeServiceNotFoundError for unknown id
 */
import { GetPppoeCallerId } from '@application/use-cases/GetPppoeCallerId';
import { InMemoryPppoeServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryPppoeServiceRepository';
import { InMemoryRadiusOrchestratorGateway } from '@infrastructure/adapters/in-memory/InMemoryRadiusOrchestratorGateway';
import { PppoeServiceNotFoundError } from '@domain/errors/pppoe';
import type { OrchestratorSession } from '@domain/ports/RadiusOrchestratorGateway';

function makeSession(overrides: Partial<OrchestratorSession> = {}): OrchestratorSession {
  return {
    sessionId: 'sess-1',
    username: 'user1',
    nasIp: '10.0.0.1',
    framedIp: '100.64.1.1',
    startedAt: new Date().toISOString(),
    bytesIn: 0,
    bytesOut: 0,
    callerId: 'AA:BB:CC:DD:EE:FF',
    ...overrides,
  };
}

describe('GetPppoeCallerId', () => {
  it('returns callerId from active session', async () => {
    const repo = new InMemoryPppoeServiceRepository();
    const orchestrator = new InMemoryRadiusOrchestratorGateway({
      seed: [{ username: 'user1', sessions: [makeSession()] }],
    });
    const uc = new GetPppoeCallerId(repo, orchestrator);

    const row = await repo.upsertByUsername({ username: 'user1', password: 'pwd', nasId: '3', status: 'enabled' });

    const result = await uc.execute(row.id);
    expect(result).toBe('AA:BB:CC:DD:EE:FF');
  });

  it('returns null when session callerId is null', async () => {
    const repo = new InMemoryPppoeServiceRepository();
    const orchestrator = new InMemoryRadiusOrchestratorGateway({
      seed: [{ username: 'user2', sessions: [makeSession({ username: 'user2', callerId: null })] }],
    });
    const uc = new GetPppoeCallerId(repo, orchestrator);

    const row = await repo.upsertByUsername({ username: 'user2', password: 'pwd', nasId: '3', status: 'enabled' });

    const result = await uc.execute(row.id);
    expect(result).toBeNull();
  });

  it('returns null when no sessions exist', async () => {
    const repo = new InMemoryPppoeServiceRepository();
    const orchestrator = new InMemoryRadiusOrchestratorGateway();
    const uc = new GetPppoeCallerId(repo, orchestrator);

    const row = await repo.upsertByUsername({ username: 'user3', password: 'pwd', nasId: '3', status: 'enabled' });

    const result = await uc.execute(row.id);
    expect(result).toBeNull();
  });

  it('throws PppoeServiceNotFoundError for unknown id', async () => {
    const repo = new InMemoryPppoeServiceRepository();
    const orchestrator = new InMemoryRadiusOrchestratorGateway();
    const uc = new GetPppoeCallerId(repo, orchestrator);

    await expect(uc.execute('non-existent-id')).rejects.toThrow(PppoeServiceNotFoundError);
  });
});
