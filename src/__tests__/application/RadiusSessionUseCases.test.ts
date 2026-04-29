import { InMemoryRadiusSessionRepository } from '../../infrastructure/adapters/in-memory/InMemoryRadiusSessionRepository';
import { ListRadiusSessions } from '../../application/use-cases/ListRadiusSessions';
import { DisconnectSession } from '../../application/use-cases/DisconnectSession';

function makeRepo() {
  return new InMemoryRadiusSessionRepository();
}

describe('ListRadiusSessions', () => {
  it('returns 15 sessions', async () => {
    const repo = makeRepo();
    const uc = new ListRadiusSessions(repo);

    const result = await uc.execute();

    expect(result).toHaveLength(15);
  });

  it('sessions have downloadMbps and duration fields', async () => {
    const repo = makeRepo();
    const uc = new ListRadiusSessions(repo);

    const result = await uc.execute();

    expect(result[0]).toHaveProperty('downloadMbps');
    expect(result[0]).toHaveProperty('duration');
    expect(typeof result[0].downloadMbps).toBe('number');
    expect(typeof result[0].duration).toBe('number');
  });
});

describe('DisconnectSession', () => {
  it('returns { success: true } when session exists', async () => {
    const repo = makeRepo();
    const uc = new DisconnectSession(repo);

    const result = await uc.execute('session-1');

    expect(result.success).toBe(true);
  });
});
