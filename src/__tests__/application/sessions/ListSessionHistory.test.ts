/**
 * ListSessionHistory use case tests (SDD sessions-history Phase 3).
 */
import { InMemorySessionRepository } from '@infrastructure/adapters/in-memory/InMemorySessionRepository';
import { ListSessionHistory } from '@application/use-cases/sessions/ListSessionHistory';

function makeRepoWithMixed(activeCount: number, revokedCount: number) {
  const repo = new InMemorySessionRepository();
  for (let i = 0; i < activeCount; i++) {
    repo.seed({ tokenHash: `active-${i}`, revokedAt: null });
  }
  for (let i = 0; i < revokedCount; i++) {
    const d = new Date(2026, 4, i + 1).toISOString();
    repo.seed({ tokenHash: `revoked-${i}`, revokedAt: d });
  }
  return repo;
}

describe('ListSessionHistory', () => {
  it('happy path: returns revoked sessions ordered revokedAt DESC, defaults page=1 pageSize=20', async () => {
    const repo = makeRepoWithMixed(2, 3);
    const uc = new ListSessionHistory(repo);
    const result = await uc.execute({});
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(20);
    expect(result.total).toBe(3);
    expect(result.items).toHaveLength(3);
    // ordered DESC
    const dates = result.items.map(i => i.revokedAt as string);
    expect(dates[0] >= dates[1]).toBe(true);
    expect(dates[1] >= dates[2]).toBe(true);
  });

  it('empty: no revoked sessions → items=[], total=0', async () => {
    const repo = makeRepoWithMixed(3, 0);
    const uc = new ListSessionHistory(repo);
    const result = await uc.execute({});
    expect(result.items).toHaveLength(0);
    expect(result.total).toBe(0);
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(20);
  });

  it('active sessions excluded: 2 active + 1 revoked → exactly 1 item', async () => {
    const repo = makeRepoWithMixed(2, 1);
    const uc = new ListSessionHistory(repo);
    const result = await uc.execute({});
    expect(result.items).toHaveLength(1);
  });

  it('pagination: 25 revoked, page=2 pageSize=20 → 5 items, total=25', async () => {
    const repo = makeRepoWithMixed(0, 25);
    const uc = new ListSessionHistory(repo);
    const result = await uc.execute({ page: 2, pageSize: 20 });
    expect(result.items).toHaveLength(5);
    expect(result.total).toBe(25);
    expect(result.page).toBe(2);
    expect(result.pageSize).toBe(20);
  });

  it('default params: execute() → page=1 pageSize=20', async () => {
    const repo = makeRepoWithMixed(0, 5);
    const uc = new ListSessionHistory(repo);
    const result = await uc.execute();
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(20);
  });

  it('tokenHash absent in DTO items', async () => {
    const repo = makeRepoWithMixed(0, 1);
    const uc = new ListSessionHistory(repo);
    const result = await uc.execute({});
    expect(result.items).toHaveLength(1);
    expect('tokenHash' in result.items[0]).toBe(false);
  });

  it('clamps page to min 1 when 0 passed', async () => {
    const repo = makeRepoWithMixed(0, 3);
    const uc = new ListSessionHistory(repo);
    const result = await uc.execute({ page: 0 });
    expect(result.page).toBe(1);
    expect(result.items).toHaveLength(3);
  });

  it('clamps pageSize to max 100', async () => {
    const repo = makeRepoWithMixed(0, 5);
    const uc = new ListSessionHistory(repo);
    const result = await uc.execute({ pageSize: 999 });
    expect(result.pageSize).toBe(100);
  });
});
