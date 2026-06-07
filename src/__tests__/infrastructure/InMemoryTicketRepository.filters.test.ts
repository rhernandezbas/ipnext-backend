import { describe, it, expect } from '@jest/globals';
import { InMemoryTicketRepository } from '@infrastructure/adapters/in-memory/InMemoryTicketRepository';

// #25 — the assignee filter was ignored at the repo level (it returned everyone,
// including unassigned tickets). These lock the fixed behavior.
describe('InMemoryTicketRepository — assignee filter (#25)', () => {
  it('filters by assigneeId, excluding unassigned tickets', async () => {
    const repo = new InMemoryTicketRepository();
    await repo.create({ subject: 'A', description: 'a', assigneeId: 'u1' });
    await repo.create({ subject: 'B', description: 'b' }); // unassigned

    const res = await repo.list({ assigneeId: 'u1' });

    expect(res.data).toHaveLength(1);
    expect(res.data[0].assigneeId).toBe('u1');
  });

  it('no assignee filter → returns all', async () => {
    const repo = new InMemoryTicketRepository();
    await repo.create({ subject: 'A', description: 'a', assigneeId: 'u1' });
    await repo.create({ subject: 'B', description: 'b' });

    const res = await repo.list({});

    expect(res.data).toHaveLength(2);
  });
});
