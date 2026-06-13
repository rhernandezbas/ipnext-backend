/**
 * #84 — close() must stamp resolvedAt and create() must start with resolvedAt: null.
 * RED: these tests fail until InMemoryTicketRepository.close() is updated.
 */
import { describe, it, expect, beforeEach } from '@jest/globals';
import { InMemoryTicketRepository } from '@infrastructure/adapters/in-memory/InMemoryTicketRepository';

describe('InMemoryTicketRepository — resolvedAt (#84)', () => {
  let repo: InMemoryTicketRepository;

  beforeEach(() => {
    repo = new InMemoryTicketRepository();
  });

  it('create() sets resolvedAt: null', async () => {
    const ticket = await repo.create({ subject: 'T1', description: 'd1' });
    expect(ticket.resolvedAt).toBeNull();
  });

  it('close() stamps resolvedAt to a non-null ISO string', async () => {
    const ticket = await repo.create({ subject: 'T2', description: 'd2' });
    const before = new Date().toISOString();
    const closed = await repo.close(ticket.id, 'Cerrado');
    const after = new Date().toISOString();

    expect(closed).not.toBeNull();
    expect(closed!.resolvedAt).not.toBeNull();
    const ts = closed!.resolvedAt!;
    // Must be a valid ISO date between before and after
    expect(new Date(ts).getTime()).toBeGreaterThanOrEqual(new Date(before).getTime());
    expect(new Date(ts).getTime()).toBeLessThanOrEqual(new Date(after).getTime());
  });

  it('close() sets status to the given statusName', async () => {
    const ticket = await repo.create({ subject: 'T3', description: 'd3' });
    const closed = await repo.close(ticket.id, 'Cerrado');
    expect(closed!.status).toBe('Cerrado');
  });

  it('a ticket that was never closed has resolvedAt: null', async () => {
    const ticket = await repo.create({ subject: 'T4', description: 'd4' });
    expect(ticket.resolvedAt).toBeNull();
    // update() without close should not set resolvedAt
    const updated = await repo.update(ticket.id, { subject: 'Updated' });
    expect(updated!.resolvedAt).toBeNull();
  });

  it('close() on non-existent id returns null', async () => {
    const result = await repo.close('non-existent', 'Cerrado');
    expect(result).toBeNull();
  });
});
