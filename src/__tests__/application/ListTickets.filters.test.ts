import { describe, it, expect } from '@jest/globals';
import { ListTickets } from '@application/use-cases/ListTickets';
import { InMemoryTicketRepository } from '@infrastructure/adapters/in-memory/InMemoryTicketRepository';
import { TicketListFilterConflictError } from '@domain/errors/tickets';

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

  // states-be (F1.5 spec #2) — closedOnly is a NEW field on ListTicketsQuery
  // (mirrors openOnly, fix-be #2). Locks the seam so it never suffers the same
  // #28 drop bug (ListTickets rebuilds the query field-by-field; a forgotten key
  // here silently discards the filter before it reaches the repository).
  it('forwards closedOnly to the repository (states-be — same seam #28 already bit openOnly-adjacent filters)', async () => {
    const repo = new InMemoryTicketRepository();
    const closed = await repo.create({ subject: 'Cerrado', description: 'x' });
    await repo.close(closed.id, 'closed');
    await repo.create({ subject: 'Abierto', description: 'y' });

    const res = await new ListTickets(repo).execute({ closedOnly: true });

    expect(res.total).toBe(1);
    expect(res.data[0]!.id).toBe(closed.id);
  });

  // adversarial review (F1.5 spec #2, LOW finding) — openOnly + closedOnly both
  // true diverge between adapters (Prisma: last-write-wins → closed; InMemory:
  // sequential narrowing → always empty). Unreachable today, but fail-fast in
  // the use case closes the seam for any future caller.
  it('rejects openOnly + closedOnly together (fail-fast, mutually exclusive)', async () => {
    const repo = new InMemoryTicketRepository();

    await expect(
      new ListTickets(repo).execute({ openOnly: true, closedOnly: true }),
    ).rejects.toThrow(TicketListFilterConflictError);
  });
});

// #63 — búsqueda LIKE: subject + customer.name + sequenceNumber exacto
describe('ListTickets — search LIKE: subject + customer.name + sequenceNumber (#63)', () => {
  function setup() {
    const repo = new InMemoryTicketRepository();
    repo.seedCustomers([
      { id: 'c1', name: 'Alice García' },
      { id: 'c2', name: 'Bob Martínez' },
    ]);
    return repo;
  }

  it('#63-search-subject: matches by subject (LIKE, case-insensitive)', async () => {
    const repo = setup();
    await repo.create({ subject: 'Sin señal en domicilio', description: 'D', customerId: 'c1' });
    await repo.create({ subject: 'Problema de facturación', description: 'D', customerId: 'c2' });

    const res = await new ListTickets(repo).execute({ search: 'señal' });

    expect(res.total).toBe(1);
    expect(res.data[0]!.subject).toBe('Sin señal en domicilio');
  });

  it('#63-search-customer-name: matches by customer name (LIKE, case-insensitive)', async () => {
    const repo = setup();
    // Subjects are neutral — match must come from customerName, not subject
    await repo.create({ subject: 'Ticket 1', description: 'D', customerId: 'c1' });
    await repo.create({ subject: 'Ticket 2', description: 'D', customerId: 'c2' });

    const res = await new ListTickets(repo).execute({ search: 'alice' });

    expect(res.total).toBe(1);
    expect(res.data[0]!.customerName).toBe('Alice García');
  });

  it('#63-search-customer-name-partial: partial customer name match (case-insensitive)', async () => {
    const repo = setup();
    await repo.create({ subject: 'T1', description: 'D', customerId: 'c2' });
    await repo.create({ subject: 'T2', description: 'D', customerId: 'c1' });

    // 'martínez' should match Bob Martínez
    const res = await new ListTickets(repo).execute({ search: 'mart' });

    expect(res.total).toBe(1);
    expect(res.data[0]!.customerName).toBe('Bob Martínez');
  });

  it('#63-search-sequence-number: exact match by sequenceNumber (numeric term)', async () => {
    const repo = setup();
    const t1 = await repo.create({ subject: 'Primer ticket', description: 'D' });
    await repo.create({ subject: 'Segundo ticket', description: 'D' });

    // Search by the exact sequenceNumber of the first ticket
    const res = await new ListTickets(repo).execute({ search: String(t1.sequenceNumber) });

    expect(res.total).toBe(1);
    expect(res.data[0]!.sequenceNumber).toBe(t1.sequenceNumber);
  });

  it('#63-search-no-description: description-only text does NOT match (dropped)', async () => {
    const repo = setup();
    await repo.create({ subject: 'Asunto genérico', description: 'texto_unico_en_desc' });

    // Search a term that only appears in description — must return 0 results
    const res = await new ListTickets(repo).execute({ search: 'texto_unico_en_desc' });

    expect(res.total).toBe(0);
  });
});
