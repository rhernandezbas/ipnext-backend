import { ChangeSuricataTicketStatus } from '@application/use-cases/suricata/ChangeSuricataTicketStatus';
import { InMemorySuricataTicketRepository } from '@infrastructure/adapters/in-memory/InMemorySuricataTicketRepository';
import { InMemorySuricataBotActionAuditRepository } from '@infrastructure/adapters/in-memory/InMemorySuricataBotActionAuditRepository';
import { SuricataTicketNotFoundError, SuricataBotActionFailedError, SuricataActionNotAppliedError } from '@domain/errors/suricata';
import { DomainError } from '@domain/errors';
import { API_SURICATA_USER_LOGIN } from '@domain/constants/machineUsers';
import type { SuricataTicketStatusPort } from '@domain/ports/SuricataTicketStatusPort';
import type { SuricataTicketRepository } from '@domain/ports/SuricataTicketRepository';
import type { SuricataBotActionAuditRepository } from '@domain/ports/SuricataBotActionAuditRepository';

/**
 * suricata-bot-autonomous-actions (Phase E, task E.4, spec suricata-ticket-status
 * STATUS-1..7, design D4/D5.a) — `ChangeSuricataTicketStatus` tested exclusively
 * against InMemory ports + a spy `SuricataTicketStatusPort` (repo convention:
 * never mock Prisma in a use-case test). Molde `suricata.AddSuricataInternalNote.test.ts`,
 * extended with the STATUS-5 ordering guarantee this action adds on top of
 * note's (a THIRD step, `ticketRepo.setStatus`, that must never run before a
 * successful port call).
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

function makeHarness(statusPort: SuricataTicketStatusPort) {
  const tickets = new InMemorySuricataTicketRepository();
  const audits = new InMemorySuricataBotActionAuditRepository();
  const useCase = new ChangeSuricataTicketStatus(tickets, audits, statusPort);
  return { tickets, audits, useCase };
}

function spyPort(
  impl: (externalId: string, status: string) => Promise<void>,
): SuricataTicketStatusPort & { calls: Array<[string, string]> } {
  const calls: Array<[string, string]> = [];
  return {
    calls,
    changeStatus: async (externalId: string, status: string) => {
      calls.push([externalId, status]);
      return impl(externalId, status);
    },
  };
}

function wrapTicketsWithSetStatusSpy(
  tickets: InMemorySuricataTicketRepository,
  onSetStatus: () => void,
): SuricataTicketRepository {
  return {
    upsertByExternalId: (input) => tickets.upsertByExternalId(input),
    findByExternalId: (externalId) => tickets.findByExternalId(externalId),
    findById: (id) => tickets.findById(id),
    list: (filters) => tickets.list(filters),
    setAssignee: (id, assigneeId) => tickets.setAssignee(id, assigneeId),
    setStatus: async (id, status) => {
      onSetStatus();
      return tickets.setStatus(id, status);
    },
  };
}

describe('ChangeSuricataTicketStatus', () => {
  describe('STATUS-2 — status must be in the captured allowlist', () => {
    it('unknown status value -> VALIDATION_ERROR, port never invoked, no audit row', async () => {
      const port = spyPort(async () => {});
      const { tickets, audits, useCase } = makeHarness(port);
      const ticket = await seedTicket(tickets);

      await expect(useCase.execute({ ticketExternalId: ticket.externalId, status: 'Cerrado' })).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
      });
      expect(port.calls).toHaveLength(0);
      expect(await audits.listByTicket(ticket.id)).toHaveLength(0);
    });

    it('empty status -> VALIDATION_ERROR, no side effect', async () => {
      const port = spyPort(async () => {});
      const { tickets, useCase } = makeHarness(port);
      const ticket = await seedTicket(tickets);

      await expect(useCase.execute({ ticketExternalId: ticket.externalId, status: '' })).rejects.toBeInstanceOf(DomainError);
      expect(port.calls).toHaveLength(0);
    });

    it('a selector-injection-shaped status is rejected the same way as any other unknown value, driver never invoked', async () => {
      const port = spyPort(async () => {});
      const { useCase } = makeHarness(port);

      await expect(
        useCase.execute({ ticketExternalId: 'ext-1', status: '"] ; DROP TABLE tickets; --' }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(port.calls).toHaveLength(0);
    });
  });

  describe('STATUS-3 — ticket must exist in the mirror', () => {
    it('unknown externalId -> SuricataTicketNotFoundError, BEFORE any audit row exists', async () => {
      const port = spyPort(async () => {});
      const { audits, useCase } = makeHarness(port);

      await expect(useCase.execute({ ticketExternalId: 'ghost', status: 'Open' })).rejects.toThrow(SuricataTicketNotFoundError);
      expect(port.calls).toHaveLength(0);
      expect(await audits.listByTicket('ghost')).toHaveLength(0);
    });
  });

  describe('STATUS-4/STATUS-6 — successful status change reaches real Suricata and is audited', () => {
    it('valid status -> port invoked with exact value, audit row outcome applied, mirror updated', async () => {
      const port = spyPort(async () => {});
      const { tickets, audits, useCase } = makeHarness(port);
      const ticket = await seedTicket(tickets);

      const result = await useCase.execute({ ticketExternalId: ticket.externalId, status: 'Progreso' });

      expect(port.calls).toEqual([[ticket.externalId, 'Progreso']]);
      const rows = await audits.listByTicket(ticket.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: result.auditId,
        ticketId: ticket.id,
        actionType: 'status',
        actorLogin: API_SURICATA_USER_LOGIN,
        outcome: 'applied',
        payload: { actionType: 'status', status: 'Progreso' },
      });
      expect(rows[0]?.completedAt).not.toBeNull();
      expect(rows[0]?.attemptedAt).toEqual(expect.any(String));
      expect(result.applied).toBe(true);
      expect(result.auditPersisted).toBe(true);

      const after = await tickets.findById(ticket.id);
      expect(after?.status).toBe('Progreso');
    });
  });

  describe('STATUS-5 — ordering: audit -> port -> setStatus; a port failure never touches the mirror', () => {
    it('records the audit BEFORE invoking the port, and calls setStatus only AFTER the port resolves', async () => {
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
      const trackedTickets = wrapTicketsWithSetStatusSpy(tickets, () => order.push('mirror-set-status'));
      const port = spyPort(async () => {
        order.push('port-invoked');
      });
      const useCase = new ChangeSuricataTicketStatus(trackedTickets, audits, port);

      await useCase.execute({ ticketExternalId: ticket.externalId, status: 'Nuevo' });

      expect(order).toEqual(['audit-recorded', 'port-invoked', 'mirror-set-status']);
    });

    it('port failure -> mirror status is NOT updated, setStatus never called', async () => {
      const tickets = new InMemorySuricataTicketRepository();
      const ticket = await seedTicket(tickets);
      const audits = new InMemorySuricataBotActionAuditRepository();
      let setStatusCalls = 0;
      const trackedTickets = wrapTicketsWithSetStatusSpy(tickets, () => {
        setStatusCalls += 1;
      });
      const port = spyPort(async () => {
        throw new SuricataActionNotAppliedError();
      });
      const useCase = new ChangeSuricataTicketStatus(trackedTickets, audits, port);

      await expect(useCase.execute({ ticketExternalId: ticket.externalId, status: 'Nuevo' })).rejects.toBeInstanceOf(
        SuricataBotActionFailedError,
      );

      expect(setStatusCalls).toBe(0);
      const after = await tickets.findById(ticket.id);
      expect(after?.status).toBe('abierto');
    });
  });

  describe('failed status change is still audited', () => {
    it('port throws -> audit row stays failed with error, SuricataBotActionFailedError carries auditId', async () => {
      const port = spyPort(async () => {
        throw new SuricataActionNotAppliedError();
      });
      const { tickets, audits, useCase } = makeHarness(port);
      const ticket = await seedTicket(tickets);

      let thrown: unknown;
      try {
        await useCase.execute({ ticketExternalId: ticket.externalId, status: 'Nuevo' });
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
});
