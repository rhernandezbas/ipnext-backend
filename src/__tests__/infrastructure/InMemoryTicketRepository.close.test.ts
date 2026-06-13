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

  // #84 re-review — reopening via update(status) must CLEAR resolvedAt.
  it('update() to a NON-closed status clears resolvedAt (reopen)', async () => {
    const ticket = await repo.create({ subject: 'T5', description: 'd5' });
    const closed = await repo.close(ticket.id, 'Cerrado');
    expect(closed!.resolvedAt).not.toBeNull();

    // Reopen via PATCH status path → update({ status })
    const reopened = await repo.update(ticket.id, { status: 'open' });
    expect(reopened!.resolvedAt).toBeNull();
  });

  it('update() to a NON-closed status (case-insensitive) clears resolvedAt', async () => {
    const ticket = await repo.create({ subject: 'T6', description: 'd6' });
    await repo.close(ticket.id, 'CLOSED');
    const reopened = await repo.update(ticket.id, { status: 'Open' });
    expect(reopened!.resolvedAt).toBeNull();
  });

  it('update() to a closed status (case-insensitive) stamps resolvedAt', async () => {
    const ticket = await repo.create({ subject: 'T7', description: 'd7' });
    expect(ticket.resolvedAt).toBeNull();
    const before = new Date().toISOString();
    const closed = await repo.update(ticket.id, { status: 'Cerrado' });
    const after = new Date().toISOString();
    expect(closed!.resolvedAt).not.toBeNull();
    const ts = closed!.resolvedAt!;
    expect(new Date(ts).getTime()).toBeGreaterThanOrEqual(new Date(before).getTime());
    expect(new Date(ts).getTime()).toBeLessThanOrEqual(new Date(after).getTime());
  });

  it('close → reopen → re-close yields a FRESH resolvedAt', async () => {
    const ticket = await repo.create({ subject: 'T8', description: 'd8' });
    const closed1 = await repo.close(ticket.id, 'Cerrado');
    const firstResolvedAt = closed1!.resolvedAt;
    expect(firstResolvedAt).not.toBeNull();

    const reopened = await repo.update(ticket.id, { status: 'open' });
    expect(reopened!.resolvedAt).toBeNull();

    const closed2 = await repo.update(ticket.id, { status: 'closed' });
    expect(closed2!.resolvedAt).not.toBeNull();
    // It is a fresh stamp (>= the first; never the stale one re-used after a null gap)
    expect(new Date(closed2!.resolvedAt!).getTime()).toBeGreaterThanOrEqual(
      new Date(firstResolvedAt!).getTime(),
    );
  });

  it('update() that does NOT touch status leaves resolvedAt untouched', async () => {
    const ticket = await repo.create({ subject: 'T9', description: 'd9' });
    const closed = await repo.close(ticket.id, 'closed');
    const stamped = closed!.resolvedAt;
    expect(stamped).not.toBeNull();
    // Editing subject only — resolvedAt must survive
    const edited = await repo.update(ticket.id, { subject: 'edited' });
    expect(edited!.resolvedAt).toBe(stamped);
  });
});
