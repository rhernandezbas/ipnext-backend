import { ReplyToSuricataTicket } from '@application/use-cases/suricata/ReplyToSuricataTicket';
import { InMemorySuricataTicketRepository } from '@infrastructure/adapters/in-memory/InMemorySuricataTicketRepository';
import { InMemorySuricataReplyAuditRepository } from '@infrastructure/adapters/in-memory/InMemorySuricataReplyAuditRepository';
import { computeSuricataReplyConfirmation } from '@domain/entities/suricataReplyConfirmation';
import {
  SuricataReplyConfirmationMismatchError,
  SuricataTicketNotFoundError,
  SuricataSessionBusyError,
  SuricataReplySendFailedError,
} from '@domain/errors/suricata';
import type { SuricataReplyPort } from '@domain/ports/SuricataReplyPort';
import type { SuricataReplyAuditRepository } from '@domain/ports/SuricataReplyAuditRepository';

/**
 * suricata-tickets-mirror (Phase E, task E.2, spec suricata-ticket-reply
 * REPLY-1..6, design D10) — `ReplyToSuricataTicket` tested exclusively
 * against InMemory ports + a spy `SuricataReplyPort` (repo convention: never
 * mock Prisma in a use-case test).
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

function makeHarness(replyPort: SuricataReplyPort) {
  const tickets = new InMemorySuricataTicketRepository();
  const audits = new InMemorySuricataReplyAuditRepository();
  const useCase = new ReplyToSuricataTicket(tickets, audits, replyPort);
  return { tickets, audits, useCase };
}

function spyPort(impl: (externalId: string, body: string) => Promise<void>): SuricataReplyPort & { calls: Array<[string, string]> } {
  const calls: Array<[string, string]> = [];
  return {
    calls,
    sendReply: async (externalId: string, body: string) => {
      calls.push([externalId, body]);
      return impl(externalId, body);
    },
  };
}

describe('ReplyToSuricataTicket', () => {
  describe('REPLY-2 — explicit double confirmation required', () => {
    it('confirm mismatch -> SuricataReplyConfirmationMismatchError, port never invoked, no audit row', async () => {
      const port = spyPort(async () => {});
      const { tickets, audits, useCase } = makeHarness(port);
      const ticket = await seedTicket(tickets);

      await expect(
        useCase.execute({ ticketId: ticket.id, actorId: 'user-1', body: 'Ya revisamos tu reclamo', confirm: 'not-the-real-hash' }),
      ).rejects.toThrow(SuricataReplyConfirmationMismatchError);

      expect(port.calls).toHaveLength(0);
      expect(await audits.listByTicket(ticket.id)).toHaveLength(0);
    });

    it('matching confirm -> send proceeds', async () => {
      const port = spyPort(async () => {});
      const { tickets, useCase } = makeHarness(port);
      const ticket = await seedTicket(tickets);
      const body = 'Ya revisamos tu reclamo';

      await useCase.execute({ ticketId: ticket.id, actorId: 'user-1', body, confirm: computeSuricataReplyConfirmation(body) });

      expect(port.calls).toEqual([[ticket.externalId, body]]);
    });
  });

  describe('REPLY-3 — unknown ticket', () => {
    it('unknown ticketId -> SuricataTicketNotFoundError, port never invoked', async () => {
      const port = spyPort(async () => {});
      const { useCase } = makeHarness(port);
      const body = 'hola';

      await expect(
        useCase.execute({ ticketId: 'ghost', actorId: 'user-1', body, confirm: computeSuricataReplyConfirmation(body) }),
      ).rejects.toThrow(SuricataTicketNotFoundError);
      expect(port.calls).toHaveLength(0);
    });
  });

  describe('REPLY-4 — full audit trail on every attempt', () => {
    it('successful send: audit row exists with actor/ticket/text/timestamp and outcome sent', async () => {
      const port = spyPort(async () => {});
      const { tickets, audits, useCase } = makeHarness(port);
      const ticket = await seedTicket(tickets);
      const body = 'Ya revisamos tu reclamo';

      const result = await useCase.execute({ ticketId: ticket.id, actorId: 'user-1', body, confirm: computeSuricataReplyConfirmation(body) });

      const rows = await audits.listByTicket(ticket.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: result.replyAuditId, ticketId: ticket.id, actorId: 'user-1', body, outcome: 'sent' });
      expect(rows[0]?.sentAt).not.toBeNull();
      expect(rows[0]?.attemptedAt).toEqual(expect.any(String));
    });

    it('failed send: audit row exists with outcome error, error propagates as SuricataReplySendFailedError', async () => {
      const port = spyPort(async () => {
        throw new SuricataSessionBusyError();
      });
      const { tickets, audits, useCase } = makeHarness(port);
      const ticket = await seedTicket(tickets);
      const body = 'Ya revisamos tu reclamo';

      let thrown: unknown;
      try {
        await useCase.execute({ ticketId: ticket.id, actorId: 'user-1', body, confirm: computeSuricataReplyConfirmation(body) });
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(SuricataReplySendFailedError);
      expect((thrown as SuricataReplySendFailedError).code).toBe('SURICATA_SESSION_BUSY');

      const rows = await audits.listByTicket(ticket.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.outcome).toBe('failed');
      expect(rows[0]?.error).toContain('busy');
      expect((thrown as SuricataReplySendFailedError).replyAuditId).toBe(rows[0]?.id);
    });

    it('the audit row is written BEFORE the port is ever invoked (D10 — audits the ATTEMPT, not success)', async () => {
      const order: string[] = [];
      const tickets = new InMemorySuricataTicketRepository();
      const ticket = await seedTicket(tickets);
      const realAudits = new InMemorySuricataReplyAuditRepository();
      const audits: SuricataReplyAuditRepository = {
        record: async (input) => {
          order.push('audit-recorded');
          return realAudits.record(input);
        },
        markOutcome: (id, input) => realAudits.markOutcome(id, input),
      };
      const port = spyPort(async () => {
        order.push('port-invoked');
      });
      const useCase = new ReplyToSuricataTicket(tickets, audits, port);
      const body = 'hola';

      await useCase.execute({ ticketId: ticket.id, actorId: 'user-1', body, confirm: computeSuricataReplyConfirmation(body) });

      expect(order).toEqual(['audit-recorded', 'port-invoked']);
    });
  });

  describe('REPLY-6 — scoped to reply only', () => {
    it('only sends the message: no other ticket field mutated by this use case', async () => {
      const port = spyPort(async () => {});
      const { tickets, useCase } = makeHarness(port);
      const ticket = await seedTicket(tickets);
      const body = 'Ya revisamos tu reclamo';

      await useCase.execute({ ticketId: ticket.id, actorId: 'user-1', body, confirm: computeSuricataReplyConfirmation(body) });

      const after = await tickets.findById(ticket.id);
      expect(after).toEqual(ticket);
    });
  });
});
