/**
 * #85 — ArchiveTicket use case.
 * RED: fails until ArchiveTicket is created.
 */
import { describe, it, expect, beforeEach } from '@jest/globals';
import { InMemoryTicketRepository } from '@infrastructure/adapters/in-memory/InMemoryTicketRepository';
import { InMemoryTicketStatusRepository } from '@infrastructure/adapters/in-memory/InMemoryTicketStatusRepository';
import { ArchiveTicket } from '@application/use-cases/ArchiveTicket';
import { TicketNotClosedError } from '@domain/errors/tickets';

async function seedStatuses(statusRepo: InMemoryTicketStatusRepository) {
  await statusRepo.create({ name: 'open', color: '#22c55e', weight: 0 });
  await statusRepo.create({ name: 'pending', color: '#f59e0b', weight: 1 });
  await statusRepo.create({ name: 'closed', color: '#6b7280', weight: 2 });
}

describe('ArchiveTicket use case (#85)', () => {
  let repo: InMemoryTicketRepository;
  let statusRepo: InMemoryTicketStatusRepository;
  let archiveTicket: ArchiveTicket;

  beforeEach(async () => {
    repo = new InMemoryTicketRepository();
    statusRepo = new InMemoryTicketStatusRepository();
    await seedStatuses(statusRepo);
    archiveTicket = new ArchiveTicket(repo, statusRepo);
  });

  it('archives a CLOSED ticket — archivedAt is set', async () => {
    const ticket = await repo.create({ subject: 'T1', description: 'd1' });
    // Close the ticket first
    await repo.close(ticket.id, 'closed');

    const before = new Date().toISOString();
    const archived = await archiveTicket.execute(ticket.id);
    const after = new Date().toISOString();

    expect(archived).not.toBeNull();
    expect(archived!.archivedAt).not.toBeNull();
    const ts = archived!.archivedAt!;
    expect(new Date(ts).getTime()).toBeGreaterThanOrEqual(new Date(before).getTime());
    expect(new Date(ts).getTime()).toBeLessThanOrEqual(new Date(after).getTime());
  });

  it('throws TicketNotClosedError when ticket is OPEN', async () => {
    const ticket = await repo.create({ subject: 'T2', description: 'd2' });
    // ticket is open (default)
    await expect(archiveTicket.execute(ticket.id)).rejects.toThrow(TicketNotClosedError);
  });

  it('returns null for nonexistent ticket id', async () => {
    const result = await archiveTicket.execute('nonexistent');
    expect(result).toBeNull();
  });

  it('archives a ticket closed with "cerrado" (case-insensitive fallback)', async () => {
    const statusRepo2 = new InMemoryTicketStatusRepository();
    await statusRepo2.create({ name: 'Cerrado', color: '#6b7280', weight: 2 });
    const archiveTicket2 = new ArchiveTicket(repo, statusRepo2);

    const ticket = await repo.create({ subject: 'T3', description: 'd3' });
    await repo.close(ticket.id, 'Cerrado');

    const archived = await archiveTicket2.execute(ticket.id);
    expect(archived).not.toBeNull();
    expect(archived!.archivedAt).not.toBeNull();
  });
});
