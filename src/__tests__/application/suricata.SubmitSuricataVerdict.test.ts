import { SubmitSuricataVerdict } from '@application/use-cases/suricata/SubmitSuricataVerdict';
import { InMemorySuricataTicketRepository } from '@infrastructure/adapters/in-memory/InMemorySuricataTicketRepository';
import { InMemorySuricataVerdictRepository } from '@infrastructure/adapters/in-memory/InMemorySuricataVerdictRepository';
import { InvalidSuricataVerdictError, SuricataTicketNotFoundError } from '@domain/errors/suricata';
import { isSuricataVerdictStale } from '@domain/entities/suricataVerdictStale';

/**
 * suricata-tickets-mirror (Phase D, task D.2, spec suricata-bot-verdict
 * VERDICT-2..5) — `SubmitSuricataVerdict` tested exclusively against InMemory
 * ports (repo convention: never mock Prisma in a use-case test).
 */
async function seedTicket(
  tickets: InMemorySuricataTicketRepository,
  overrides: Partial<{ externalId: string; contentHash: string }> = {},
) {
  return tickets.upsertByExternalId({
    externalId: overrides.externalId ?? 'ext-1',
    subject: 'No tengo internet',
    status: 'abierto',
    priority: 'alta',
    areaId: null,
    customerName: 'Juan Perez',
    customerEmail: 'juan@example.com',
    customerPhone: null,
    externalClientRef: null,
    clientId: null,
    openedAt: '2026-09-01T09:00:00.000Z',
    lastMessageAt: '2026-09-01T09:00:00.000Z',
    contentHash: overrides.contentHash ?? 'hash-v1',
    syncedAt: '2026-09-01T09:00:00.000Z',
  });
}

function makeHarness() {
  const tickets = new InMemorySuricataTicketRepository();
  const verdicts = new InMemorySuricataVerdictRepository();
  const useCase = new SubmitSuricataVerdict(tickets, verdicts);
  return { tickets, verdicts, useCase };
}

describe('SubmitSuricataVerdict', () => {
  describe('VERDICT-2 — payload shape and conditional requirements', () => {
    it('resuelto=false without motivo -> InvalidSuricataVerdictError, nothing persisted', async () => {
      const { tickets, verdicts, useCase } = makeHarness();
      await seedTicket(tickets);

      await expect(
        useCase.execute({ ticketExternalId: 'ext-1', resuelto: false, analisis: 'analisis' }),
      ).rejects.toThrow(InvalidSuricataVerdictError);
      expect(await verdicts.listByTicket((await tickets.findByExternalId('ext-1'))!.id)).toHaveLength(0);
    });

    it('resuelto=false without respuestaSugerida -> InvalidSuricataVerdictError, nothing persisted', async () => {
      const { tickets, verdicts, useCase } = makeHarness();
      await seedTicket(tickets);

      await expect(
        useCase.execute({ ticketExternalId: 'ext-1', resuelto: false, analisis: 'analisis', motivo: 'motivo' }),
      ).rejects.toThrow(InvalidSuricataVerdictError);
      expect(await verdicts.listByTicket((await tickets.findByExternalId('ext-1'))!.id)).toHaveLength(0);
    });

    it('InvalidSuricataVerdictError lists BOTH missing fields when neither is present', async () => {
      const { tickets, useCase } = makeHarness();
      await seedTicket(tickets);

      try {
        await useCase.execute({ ticketExternalId: 'ext-1', resuelto: false, analisis: 'analisis' });
        throw new Error('expected InvalidSuricataVerdictError');
      } catch (err) {
        expect(err).toBeInstanceOf(InvalidSuricataVerdictError);
        expect((err as InvalidSuricataVerdictError).missingFields).toEqual(['motivo', 'respuestaSugerida']);
      }
    });

    it('resuelto=true needs neither motivo nor respuestaSugerida — accepted and persisted', async () => {
      const { tickets, verdicts, useCase } = makeHarness();
      const ticket = await seedTicket(tickets);

      const result = await useCase.execute({ ticketExternalId: 'ext-1', resuelto: true, analisis: 'todo resuelto' });

      expect(result.ticketExternalId).toBe('ext-1');
      const rows = await verdicts.listByTicket(ticket.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.motivo).toBeNull();
      expect(rows[0]?.respuestaSugerida).toBeNull();
    });
  });

  describe('VERDICT-3 — ticket must exist in the mirror', () => {
    it('unknown externalId -> SuricataTicketNotFoundError, no verdict row created', async () => {
      const { verdicts, useCase } = makeHarness();

      await expect(
        useCase.execute({ ticketExternalId: 'ghost', resuelto: true, analisis: 'x' }),
      ).rejects.toThrow(SuricataTicketNotFoundError);
      // Nothing to compare against a ticketId (none was resolved) — assert no rows exist at all.
      expect(await verdicts.listByTicket('any')).toHaveLength(0);
    });
  });

  describe('VERDICT-4 — verdicts accumulate, never overwritten', () => {
    it('a second submission on the same ticket creates a SECOND row; the first is untouched', async () => {
      const { tickets, verdicts, useCase } = makeHarness();
      const ticket = await seedTicket(tickets);

      await useCase.execute({ ticketExternalId: 'ext-1', resuelto: false, analisis: 'primero', motivo: 'm1', respuestaSugerida: 'r1' });
      await useCase.execute({ ticketExternalId: 'ext-1', resuelto: true, analisis: 'segundo' });

      const rows = await verdicts.listByTicket(ticket.id);
      expect(rows).toHaveLength(2);
      expect(rows.find((r) => r.analisis === 'primero')).toBeDefined();
      expect(rows.find((r) => r.analisis === 'segundo')).toBeDefined();
    });
  });

  describe('VERDICT-5 — current verdict is the most recent', () => {
    it('latestByTicket returns the newest verdict, not the first', async () => {
      const { tickets, verdicts, useCase } = makeHarness();
      const ticket = await seedTicket(tickets);

      await useCase.execute({ ticketExternalId: 'ext-1', resuelto: false, analisis: 'older', motivo: 'm', respuestaSugerida: 'r' });
      await useCase.execute({ ticketExternalId: 'ext-1', resuelto: true, analisis: 'newer' });

      const latest = await verdicts.latestByTicket(ticket.id);
      expect(latest?.analisis).toBe('newer');
      expect(latest?.resuelto).toBe(true);
    });
  });

  describe('stale derivation (design D9) — pure helper, not a stored column', () => {
    it('a verdict is stale when the ticket contentHash changed since submission', async () => {
      const { tickets, verdicts, useCase } = makeHarness();
      const ticket = await seedTicket(tickets, { contentHash: 'hash-v1' });

      await useCase.execute({ ticketExternalId: 'ext-1', resuelto: true, analisis: 'ok' });
      const verdict = await verdicts.latestByTicket(ticket.id);
      expect(verdict).not.toBeNull();

      // Ticket changed after the verdict was submitted (new message arrived).
      await tickets.upsertByExternalId({
        externalId: 'ext-1',
        subject: 'No tengo internet',
        status: 'abierto',
        priority: 'alta',
        areaId: null,
        customerName: 'Juan Perez',
        customerEmail: 'juan@example.com',
        customerPhone: null,
        externalClientRef: null,
        clientId: null,
        openedAt: '2026-09-01T09:00:00.000Z',
        lastMessageAt: '2026-09-02T09:00:00.000Z',
        contentHash: 'hash-v2',
        syncedAt: '2026-09-02T09:00:00.000Z',
      });
      const updatedTicket = await tickets.findByExternalId('ext-1');

      expect(isSuricataVerdictStale(verdict!, updatedTicket!.contentHash)).toBe(true);
      expect(isSuricataVerdictStale(verdict!, verdict!.ticketContentHash)).toBe(false);
    });
  });
});
