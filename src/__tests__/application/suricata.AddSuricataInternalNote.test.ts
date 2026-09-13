import { AddSuricataInternalNote } from '@application/use-cases/suricata/AddSuricataInternalNote';
import { InMemorySuricataTicketRepository } from '@infrastructure/adapters/in-memory/InMemorySuricataTicketRepository';
import { InMemorySuricataBotActionAuditRepository } from '@infrastructure/adapters/in-memory/InMemorySuricataBotActionAuditRepository';
import { SuricataTicketNotFoundError, SuricataBotActionFailedError, SuricataActionNotAppliedError } from '@domain/errors/suricata';
import { DomainError } from '@domain/errors';
import { API_SURICATA_USER_LOGIN } from '@domain/constants/machineUsers';
import type { SuricataInternalNotePort } from '@domain/ports/SuricataInternalNotePort';
import type { SuricataBotActionAuditRepository } from '@domain/ports/SuricataBotActionAuditRepository';

/**
 * suricata-bot-autonomous-actions (Phase D, task D.2, spec suricata-internal-note
 * NOTE-1..7, design D4/D5) — `AddSuricataInternalNote` tested exclusively
 * against InMemory ports + a spy `SuricataInternalNotePort` (repo convention:
 * never mock Prisma in a use-case test). Molde
 * `suricata.ReplyToSuricataTicket.test.ts`, generalized to the unified
 * `SuricataBotActionAuditRepository` (D1) and the audit-BEFORE-port ordering.
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

function makeHarness(notePort: SuricataInternalNotePort) {
  const tickets = new InMemorySuricataTicketRepository();
  const audits = new InMemorySuricataBotActionAuditRepository();
  const useCase = new AddSuricataInternalNote(tickets, audits, notePort);
  return { tickets, audits, useCase };
}

function spyPort(impl: (externalId: string, note: string) => Promise<void>): SuricataInternalNotePort & { calls: Array<[string, string]> } {
  const calls: Array<[string, string]> = [];
  return {
    calls,
    addNote: async (externalId: string, note: string) => {
      calls.push([externalId, note]);
      return impl(externalId, note);
    },
  };
}

describe('AddSuricataInternalNote', () => {
  describe('NOTE-2 — non-empty note text required', () => {
    it('empty text -> VALIDATION_ERROR, port never invoked, no audit row', async () => {
      const port = spyPort(async () => {});
      const { tickets, audits, useCase } = makeHarness(port);
      const ticket = await seedTicket(tickets);

      await expect(useCase.execute({ ticketExternalId: ticket.externalId, note: '' })).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
      });

      expect(port.calls).toHaveLength(0);
      expect(await audits.listByTicket(ticket.id)).toHaveLength(0);
    });

    it('whitespace-only text -> VALIDATION_ERROR, no side effect', async () => {
      const port = spyPort(async () => {});
      const { tickets, useCase } = makeHarness(port);
      const ticket = await seedTicket(tickets);

      await expect(useCase.execute({ ticketExternalId: ticket.externalId, note: '   ' })).rejects.toBeInstanceOf(DomainError);
      expect(port.calls).toHaveLength(0);
    });
  });

  describe('NOTE-3 — ticket must exist in the mirror', () => {
    it('unknown externalId -> SuricataTicketNotFoundError, BEFORE any audit row exists', async () => {
      const port = spyPort(async () => {});
      const { audits, useCase } = makeHarness(port);

      await expect(useCase.execute({ ticketExternalId: 'ghost', note: 'Escalado a NOC' })).rejects.toThrow(
        SuricataTicketNotFoundError,
      );
      expect(port.calls).toHaveLength(0);
      expect(await audits.listByTicket('ghost')).toHaveLength(0);
    });
  });

  describe('NOTE-4/NOTE-6 — successful note reaches real Suricata and is audited', () => {
    it('valid note -> port invoked with exact text, audit row outcome applied', async () => {
      const port = spyPort(async () => {});
      const { tickets, audits, useCase } = makeHarness(port);
      const ticket = await seedTicket(tickets);

      const result = await useCase.execute({ ticketExternalId: ticket.externalId, note: 'Escalado a NOC' });

      expect(port.calls).toEqual([[ticket.externalId, 'Escalado a NOC']]);
      const rows = await audits.listByTicket(ticket.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: result.auditId,
        ticketId: ticket.id,
        actionType: 'note',
        actorLogin: API_SURICATA_USER_LOGIN,
        outcome: 'applied',
        payload: { actionType: 'note', text: 'Escalado a NOC' },
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
      const useCase = new AddSuricataInternalNote(tickets, audits, port);

      await useCase.execute({ ticketExternalId: ticket.externalId, note: 'hola' });

      expect(order).toEqual(['audit-recorded', 'port-invoked']);
    });
  });

  describe('failed note posting is still audited', () => {
    it('port throws -> audit row stays failed with error, SuricataBotActionFailedError carries auditId', async () => {
      const port = spyPort(async () => {
        throw new SuricataActionNotAppliedError();
      });
      const { tickets, audits, useCase } = makeHarness(port);
      const ticket = await seedTicket(tickets);

      let thrown: unknown;
      try {
        await useCase.execute({ ticketExternalId: ticket.externalId, note: 'Escalado a NOC' });
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(SuricataBotActionFailedError);
      expect((thrown as SuricataBotActionFailedError).code).toBe('SURICATA_ACTION_NOT_APPLIED');

      const rows = await audits.listByTicket(ticket.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.outcome).toBe('failed');
      expect(rows[0]?.error).toContain('post-condition marker');
      expect((thrown as SuricataBotActionFailedError).auditId).toBe(rows[0]?.id);
    });
  });

  describe('NOTE-5 — scoped to internal note only', () => {
    it('only posts the note: no other ticket field mutated by this use case', async () => {
      const port = spyPort(async () => {});
      const { tickets, useCase } = makeHarness(port);
      const ticket = await seedTicket(tickets);

      await useCase.execute({ ticketExternalId: ticket.externalId, note: 'Escalado a NOC' });

      const after = await tickets.findById(ticket.id);
      expect(after).toEqual(ticket);
    });
  });
});
