import { SendAutonomousSuricataReply } from '@application/use-cases/suricata/SendAutonomousSuricataReply';
import { InMemorySuricataTicketRepository } from '@infrastructure/adapters/in-memory/InMemorySuricataTicketRepository';
import { InMemorySuricataBotActionAuditRepository } from '@infrastructure/adapters/in-memory/InMemorySuricataBotActionAuditRepository';
import { SuricataTicketNotFoundError, SuricataBotActionFailedError, SuricataActionNotAppliedError } from '@domain/errors/suricata';
import { DomainError } from '@domain/errors';
import { API_SURICATA_USER_LOGIN } from '@domain/constants/machineUsers';
import type { BotpressReplyPort } from '@domain/ports/BotpressReplyPort';
import type { SuricataBotActionAuditRepository } from '@domain/ports/SuricataBotActionAuditRepository';

/**
 * suricata-bot-autonomous-actions (Phase G, task G.4, spec EXTREPLY-1..5,
 * design D4.a CORRECTED 2026-09-13) — `SendAutonomousSuricataReply` tested
 * exclusively against InMemory ports + a spy/fake `BotpressReplyPort` (repo
 * convention: never mock Prisma, never make a real network call in tests —
 * the live verification already happened manually, this suite fixes the
 * CONTRACT). Molde `suricata.CloseSuricataTicket.test.ts` for the
 * audit-ordering assertions specifically (EXTREPLY-5) — a NEW use case,
 * distinct from `ReplyToSuricataTicket`: no `confirm`, no `actorId`,
 * addressed by `externalId`.
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

function makeHarness(replyPort: BotpressReplyPort) {
  const tickets = new InMemorySuricataTicketRepository();
  const audits = new InMemorySuricataBotActionAuditRepository();
  const useCase = new SendAutonomousSuricataReply(tickets, audits, replyPort);
  return { tickets, audits, useCase };
}

function spyPort(opts: {
  conversationId?: string | null;
  send?: (conversationId: string, body: string) => Promise<{ whatsappId?: string }>;
}): BotpressReplyPort & { getConversationIdCalls: string[]; sendReplyCalls: Array<[string, string]> } {
  const getConversationIdCalls: string[] = [];
  const sendReplyCalls: Array<[string, string]> = [];
  const conversationId = opts.conversationId === undefined ? 'conv_1' : opts.conversationId;
  const send = opts.send ?? (async () => ({ whatsappId: 'wamid.default' }));
  return {
    getConversationIdCalls,
    sendReplyCalls,
    getConversationId: async (ticketExternalId: string) => {
      getConversationIdCalls.push(ticketExternalId);
      return conversationId;
    },
    sendReply: async (convId: string, body: string) => {
      sendReplyCalls.push([convId, body]);
      return send(convId, body);
    },
  };
}

describe('SendAutonomousSuricataReply', () => {
  describe('EXTREPLY-3 — non-empty reply body required', () => {
    it('empty body -> VALIDATION_ERROR, port never invoked, no audit row', async () => {
      const port = spyPort({});
      const { tickets, audits, useCase } = makeHarness(port);
      const ticket = await seedTicket(tickets);

      await expect(useCase.execute({ ticketExternalId: ticket.externalId, body: '' })).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
      });

      expect(port.getConversationIdCalls).toHaveLength(0);
      expect(port.sendReplyCalls).toHaveLength(0);
      expect(await audits.listByTicket(ticket.id)).toHaveLength(0);
    });

    it('whitespace-only body -> VALIDATION_ERROR, no side effect', async () => {
      const port = spyPort({});
      const { tickets, useCase } = makeHarness(port);
      const ticket = await seedTicket(tickets);

      await expect(useCase.execute({ ticketExternalId: ticket.externalId, body: '   ' })).rejects.toBeInstanceOf(
        DomainError,
      );
      expect(port.sendReplyCalls).toHaveLength(0);
    });
  });

  describe('ticket must exist in the mirror', () => {
    it('unknown externalId -> SuricataTicketNotFoundError, BEFORE any audit row exists', async () => {
      const port = spyPort({});
      const { audits, useCase } = makeHarness(port);

      await expect(useCase.execute({ ticketExternalId: 'ghost', body: 'Hola' })).rejects.toThrow(
        SuricataTicketNotFoundError,
      );
      expect(port.sendReplyCalls).toHaveLength(0);
      expect(await audits.listByTicket('ghost')).toHaveLength(0);
    });
  });

  describe('successful send reaches Botpress and is audited', () => {
    it('valid body -> conversationId resolved then port invoked with the exact body, audit row outcome applied', async () => {
      const port = spyPort({ conversationId: 'conv_42', send: async () => ({ whatsappId: 'wamid.abc' }) });
      const { tickets, audits, useCase } = makeHarness(port);
      const ticket = await seedTicket(tickets);

      const result = await useCase.execute({ ticketExternalId: ticket.externalId, body: 'Ya reactivamos tu servicio' });

      expect(port.getConversationIdCalls).toEqual([ticket.externalId]);
      expect(port.sendReplyCalls).toEqual([['conv_42', 'Ya reactivamos tu servicio']]);
      const rows = await audits.listByTicket(ticket.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: result.auditId,
        ticketId: ticket.id,
        actionType: 'reply',
        actorLogin: API_SURICATA_USER_LOGIN,
        outcome: 'applied',
        payload: { actionType: 'reply', body: 'Ya reactivamos tu servicio' },
      });
      expect(rows[0]?.completedAt).not.toBeNull();
      expect(result.applied).toBe(true);
      expect(result.auditPersisted).toBe(true);
      expect(result.whatsappId).toBe('wamid.abc');
    });

    it('EXTREPLY-5 — the audit row is written BEFORE the port is ever invoked (D5 — audits the ATTEMPT, not success)', async () => {
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
      const port: BotpressReplyPort = {
        getConversationId: async () => {
          order.push('conversation-resolved');
          return 'conv_1';
        },
        sendReply: async () => {
          order.push('port-invoked');
          return {};
        },
      };
      const useCase = new SendAutonomousSuricataReply(tickets, audits, port);

      await useCase.execute({ ticketExternalId: ticket.externalId, body: 'Hola' });

      expect(order).toEqual(['audit-recorded', 'conversation-resolved', 'port-invoked']);
    });
  });

  describe('a ticket with no linked Botpress conversation is a DISTINCT failure', () => {
    it('getConversationId resolves null -> SuricataBotActionFailedError wrapping SuricataActionNotAppliedError, audit row failed', async () => {
      const port = spyPort({ conversationId: null });
      const { tickets, audits, useCase } = makeHarness(port);
      const ticket = await seedTicket(tickets);

      let thrown: unknown;
      try {
        await useCase.execute({ ticketExternalId: ticket.externalId, body: 'Hola' });
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(SuricataBotActionFailedError);
      expect((thrown as SuricataBotActionFailedError).code).toBe('SURICATA_ACTION_NOT_APPLIED');
      expect(port.sendReplyCalls).toHaveLength(0); // never reaches sendReply without a conversationId

      const rows = await audits.listByTicket(ticket.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.outcome).toBe('failed');
      expect((thrown as SuricataBotActionFailedError).auditId).toBe(rows[0]?.id);
    });
  });

  describe('send failure is still audited', () => {
    it('sendReply throws -> audit row stays failed with error, SuricataBotActionFailedError carries auditId', async () => {
      const port = spyPort({
        conversationId: 'conv_1',
        send: async () => {
          throw new SuricataActionNotAppliedError();
        },
      });
      const { tickets, audits, useCase } = makeHarness(port);
      const ticket = await seedTicket(tickets);

      let thrown: unknown;
      try {
        await useCase.execute({ ticketExternalId: ticket.externalId, body: 'Hola' });
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

  describe('no confirm/actorId in the input contract (D4.a)', () => {
    it('execute() input has no confirm/actorId fields — TypeScript-enforced, runtime double-check via extra keys being ignored', async () => {
      const port = spyPort({ conversationId: 'conv_1' });
      const { tickets, useCase } = makeHarness(port);
      const ticket = await seedTicket(tickets);

      // Runtime double-check: even if a caller attaches extra fields, the use
      // case never reads them — no branch in the implementation references
      // `confirm`/`actorId` at all (EXTREPLY-3's independence).
      const inputWithExtras = { ticketExternalId: ticket.externalId, body: 'Hola', confirm: 'whatever', actorId: 'someone' };
      const result = await useCase.execute(inputWithExtras as unknown as { ticketExternalId: string; body: string });

      expect(result.applied).toBe(true);
    });
  });
});
