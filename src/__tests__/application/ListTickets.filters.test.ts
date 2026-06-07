import { describe, it, expect } from '@jest/globals';
import { ListTickets } from '@application/use-cases/ListTickets';
import { InMemoryTicketRepository } from '@infrastructure/adapters/in-memory/InMemoryTicketRepository';

// #28 — the #25 filters (assigneeId, from, to) were wired in the route and the
// repo, but ListTickets rebuilt the query field-by-field and DROPPED them, so
// the filter never reached the repository. These tests cover the use-case seam
// (route tests mock the use case; repo tests skip it — nobody covered this).
describe('ListTickets — forwards #25 filters to the repository (#28)', () => {
  it('forwards assigneeId (unassigned tickets must not come back)', async () => {
    const repo = new InMemoryTicketRepository();
    await repo.create({ subject: 'Asignado a Luis', description: 'x', assigneeId: 'luis-id' });
    await repo.create({ subject: 'Sin asignar', description: 'y' });

    const res = await new ListTickets(repo).execute({ assigneeId: 'luis-id' });

    expect(res.total).toBe(1);
    expect(res.data).toHaveLength(1);
    expect(res.data[0]!.assigneeId).toBe('luis-id');
  });

  it('forwards the from/to date range', async () => {
    const repo = new InMemoryTicketRepository();
    const inRange = await repo.create({ subject: 'Hoy', description: 'x' });
    // InMemory stamps createdAt = now; a window around today must include it,
    // and a window fully in the past must exclude it.
    const today = inRange.createdAt.slice(0, 10);

    const inside = await new ListTickets(repo).execute({ from: today, to: today });
    expect(inside.total).toBe(1);

    const past = await new ListTickets(repo).execute({ from: '2000-01-01', to: '2000-12-31' });
    expect(past.total).toBe(0);
  });

  it('still forwards the pre-#25 filters (regression guard)', async () => {
    const repo = new InMemoryTicketRepository();
    await repo.create({ subject: 'Alta', description: 'x', priority: 'high' });
    await repo.create({ subject: 'Media', description: 'y', priority: 'medium' });

    const res = await new ListTickets(repo).execute({ priority: 'high' });

    expect(res.total).toBe(1);
    expect(res.data[0]!.priority).toBe('high');
  });
});
