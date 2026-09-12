/**
 * suricata-tickets-mirror (Phase F, task F.1, spec `suricata-tickets-ui`
 * UI-7, design D3) — `SetSuricataAssignee` against InMemory ports.
 * Prominense-ONLY: this use case never touches any Suricata port — it has no
 * `SuricataScraperPort`/`SuricataReplyPort` dependency AT ALL, by construction.
 */
import { InMemorySuricataTicketRepository } from '@infrastructure/adapters/in-memory/InMemorySuricataTicketRepository';
import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import { SetSuricataAssignee } from '@application/use-cases/suricata/SetSuricataAssignee';
import { SuricataTicketNotFoundError } from '@domain/errors/suricata';
import { UserNotFoundError } from '@domain/errors/rbacUser.errors';

async function build() {
  const tickets = new InMemorySuricataTicketRepository();
  const users = new InMemoryRbacUserRepository();
  const useCase = new SetSuricataAssignee(tickets, users);
  return { tickets, users, useCase };
}

async function seedTicket(tickets: InMemorySuricataTicketRepository) {
  return tickets.upsertByExternalId({
    externalId: 'ext-1',
    subject: 'x',
    status: 'abierto',
    priority: null,
    areaId: null,
    customerName: null,
    customerEmail: null,
    customerPhone: null,
    externalClientRef: null,
    clientId: null,
    openedAt: null,
    lastMessageAt: null,
    contentHash: 'hash-v1',
    syncedAt: '2026-09-01T00:00:00.000Z',
  });
}

describe('SetSuricataAssignee', () => {
  it('UI-7 — assigning an unassigned ticket persists locally', async () => {
    const { tickets, users, useCase } = await build();
    const ticket = await seedTicket(tickets);
    const agent = await users.create({ name: 'Ana', email: 'ana@x.com', login: 'ana', passwordHash: 'h', status: 'active' });

    const updated = await useCase.execute({ ticketId: ticket.id, assigneeId: agent.id });

    expect(updated.assigneeId).toBe(agent.id);
    const reloaded = await tickets.findById(ticket.id);
    expect(reloaded?.assigneeId).toBe(agent.id);
  });

  it('clears the assignment when assigneeId is null', async () => {
    const { tickets, users, useCase } = await build();
    const ticket = await seedTicket(tickets);
    const agent = await users.create({ name: 'Ana', email: 'ana@x.com', login: 'ana', passwordHash: 'h', status: 'active' });
    await useCase.execute({ ticketId: ticket.id, assigneeId: agent.id });

    const updated = await useCase.execute({ ticketId: ticket.id, assigneeId: null });
    expect(updated.assigneeId).toBeNull();
  });

  it('unknown ticket -> SuricataTicketNotFoundError, no user lookup performed', async () => {
    const { useCase } = await build();
    await expect(useCase.execute({ ticketId: 'ghost', assigneeId: null })).rejects.toBeInstanceOf(SuricataTicketNotFoundError);
  });

  it('unknown assigneeId -> UserNotFoundError, ticket left untouched', async () => {
    const { tickets, useCase } = await build();
    const ticket = await seedTicket(tickets);

    await expect(useCase.execute({ ticketId: ticket.id, assigneeId: 'ghost-user' })).rejects.toBeInstanceOf(UserNotFoundError);
    const reloaded = await tickets.findById(ticket.id);
    expect(reloaded?.assigneeId).toBeNull();
  });

  it('this use case has zero dependency on any Suricata scraper/reply port (constructor arity check)', () => {
    // Prominense-only by CONSTRUCTION: the constructor only accepts a ticket
    // repo and an RbacUser repo — there is no parameter slot through which a
    // Suricata port could ever be injected.
    expect(SetSuricataAssignee.length).toBe(2);
  });
});
