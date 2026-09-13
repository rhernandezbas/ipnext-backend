import { CloseSuricataTicket } from '@application/use-cases/suricata/CloseSuricataTicket';
import { InMemorySuricataTicketRepository } from '@infrastructure/adapters/in-memory/InMemorySuricataTicketRepository';
import { InMemorySuricataBotActionAuditRepository } from '@infrastructure/adapters/in-memory/InMemorySuricataBotActionAuditRepository';
import { SuricataTicketNotFoundError, SuricataBotActionFailedError, SuricataActionNotAppliedError } from '@domain/errors/suricata';
import { DomainError } from '@domain/errors';
import { API_SURICATA_USER_LOGIN } from '@domain/constants/machineUsers';
import type { SuricataTicketClosePort } from '@domain/ports/SuricataTicketClosePort';
import type { SuricataBotActionAuditRepository } from '@domain/ports/SuricataBotActionAuditRepository';

/**
 * suricata-bot-autonomous-actions (Phase F, task F.2, spec suricata-ticket-close
 * CLOSE-1..7, design D4/D5/D5.a corrected) — `CloseSuricataTicket` tested
 * exclusively against InMemory ports + a spy `SuricataTicketClosePort` (repo
 * convention: never mock Prisma in a use-case test). Molde
 * `suricata.AddSuricataInternalNote.test.ts` — close does NOT touch the
 * mirror at all (D5.a's correction: there is no closed-status value to
 * write), so the ordering here is the SAME two-step shape as note
 * (audit -> port), unlike status's three-step shape.
 */
async function seedTicket(tickets: InMemorySuricataTicketRepository, externalId = 'ext-1') {
  return tickets.upsertByExternalId({
    externalId,
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
    contentHash: 'hash-v1',
    syncedAt: '2026-09-01T09:00:00.000Z',
  });
}

function makeHarness(closePort: SuricataTicketClosePort) {
  const tickets = new InMemorySuricataTicketRepository();
  const audits = new InMemorySuricataBotActionAuditRepository();
  const useCase = new CloseSuricataTicket(tickets, audits, closePort);
  return { tickets, audits, useCase };
}

function spyPort(
  impl: (externalId: string, reason: string) => Promise<void>,
): SuricataTicketClosePort & { calls: Array<[string, string]> } {
  const calls: Array<[string, string]> = [];
  return {
    calls,
    close: async (externalId: string, reason: string) => {
      calls.push([externalId, reason]);
      return impl(externalId, reason);
    },
  };
}

describe('CloseSuricataTicket', () => {
  describe('CLOSE-2 — non-empty close reason required', () => {
    it('empty reason -> VALIDATION_ERROR, port never invoked, no audit row', async () => {
      const port = spyPort(async () => {});
      const { tickets, audits, useCase } = makeHarness(port);
      const ticket = await seedTicket(tickets);

      await expect(useCase.execute({ ticketExternalId: ticket.externalId, reason: '' })).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
      });

      expect(port.calls).toHaveLength(0);
      expect(await audits.listByTicket(ticket.id)).toHaveLength(0);
    });

    it('whitespace-only reason -> VALIDATION_ERROR, no side effect', async () => {
      const port = spyPort(async () => {});
      const { tickets, useCase } = makeHarness(port);
      const ticket = await seedTicket(tickets);

      await expect(useCase.execute({ ticketExternalId: ticket.externalId, reason: '   ' })).rejects.toBeInstanceOf(
        DomainError,
      );
      expect(port.calls).toHaveLength(0);
    });
  });

  describe('CLOSE-3 — ticket must exist in the mirror', () => {
    it('unknown externalId -> SuricataTicketNotFoundError, BEFORE any audit row exists', async () => {
      const port = spyPort(async () => {});
      const { audits, useCase } = makeHarness(port);

      await expect(useCase.execute({ ticketExternalId: 'ghost', reason: 'Reclamo resuelto' })).rejects.toThrow(
        SuricataTicketNotFoundError,
      );
      expect(port.calls).toHaveLength(0);
      expect(await audits.listByTicket('ghost')).toHaveLength(0);
    });
  });

  describe('CLOSE-4/CLOSE-6 — successful close reaches real Suricata and is audited', () => {
    it('valid reason -> port invoked with exact value, audit row outcome applied', async () => {
      const port = spyPort(async () => {});
      const { tickets, audits, useCase } = makeHarness(port);
      const ticket = await seedTicket(tickets);

      const result = await useCase.execute({ ticketExternalId: ticket.externalId, reason: 'Reclamo resuelto' });

      expect(port.calls).toEqual([[ticket.externalId, 'Reclamo resuelto']]);
      const rows = await audits.listByTicket(ticket.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: result.auditId,
        ticketId: ticket.id,
        actionType: 'close',
        actorLogin: API_SURICATA_USER_LOGIN,
        outcome: 'applied',
        payload: { actionType: 'close', reason: 'Reclamo resuelto' },
      });
      expect(rows[0]?.completedAt).not.toBeNull();
      expect(rows[0]?.attemptedAt).toEqual(expect.any(String));
      expect(result.applied).toBe(true);
      expect(result.auditPersisted).toBe(true);
    });

    it('the audit row is written BEFORE the port is ever invoked (D5 — audits the ATTEMPT, not success)', async () => {
      const order: string[] = [];
      const tickets = new InMemorySuricataTicketRepository();
      const ticket = await seedTicket(tickets);
      const realAudits = new InMemorySuricataBotActionAuditRepository();
      const audits: SuricataBotActionAuditRepository = {
        record: async (input) => {
          order.push('audit-recorded');
          return realAudits.record(input);
        },
        markOutcome: (id, input) => realAudits.markOutcome(id, input),
        listByTicket: (ticketId) => realAudits.listByTicket(ticketId),
      };
      const port = spyPort(async () => {
        order.push('port-invoked');
      });
      const useCase = new CloseSuricataTicket(tickets, audits, port);

      await useCase.execute({ ticketExternalId: ticket.externalId, reason: 'Reclamo resuelto' });

      expect(order).toEqual(['audit-recorded', 'port-invoked']);
    });
  });

  describe('failed close is still audited', () => {
    it('port throws -> audit row stays failed with error, SuricataBotActionFailedError carries auditId', async () => {
      const port = spyPort(async () => {
        throw new SuricataActionNotAppliedError();
      });
      const { tickets, audits, useCase } = makeHarness(port);
      const ticket = await seedTicket(tickets);

      let thrown: unknown;
      try {
        await useCase.execute({ ticketExternalId: ticket.externalId, reason: 'Reclamo resuelto' });
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(SuricataBotActionFailedError);
      expect((thrown as SuricataBotActionFailedError).code).toBe('SURICATA_ACTION_NOT_APPLIED');

      const rows = await audits.listByTicket(ticket.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.outcome).toBe('failed');
      expect((thrown as SuricataBotActionFailedError).auditId).toBe(rows[0]?.id);
    });
  });

  describe('CLOSE-5 (corrected D5.a) — close never writes the mirror ticket', () => {
    it('successful close does not mutate any ticket field locally (no setStatus, no other write)', async () => {
      const port = spyPort(async () => {});
      const { tickets, useCase } = makeHarness(port);
      const ticket = await seedTicket(tickets);

      await useCase.execute({ ticketExternalId: ticket.externalId, reason: 'Reclamo resuelto' });

      const after = await tickets.findById(ticket.id);
      expect(after).toEqual(ticket);
    });
  });
});
