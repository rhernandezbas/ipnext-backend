/**
 * suricata-bot-autonomous-actions (Phase A, task A.12, spec
 * suricata-bot-action-audit EXTAUDIT-1..7) — TDD RED for
 * `SuricataBotActionAuditRepository` (A.9), run against BOTH adapters: the
 * InMemory one (always) and the Prisma one (skip-gated on
 * `DATABASE_URL_TEST`, molde `PrismaRbacPermissionRepository.test.ts` — this
 * repo's "no local DB" convention, tasks.md A.11/A.12).
 */
import type {
  SuricataBotActionAuditRepository,
} from '@domain/ports/SuricataBotActionAuditRepository';
import type { RecordSuricataBotActionInput } from '@domain/entities/suricataBotAction';

const baseInput: RecordSuricataBotActionInput = {
  ticketId: 'ticket-1',
  actorLogin: 'api-suricata',
  payload: { actionType: 'reply', body: 'Hola, gracias por tu paciencia' },
};

function runSuricataBotActionAuditContractTests(
  makeRepo: () => Promise<SuricataBotActionAuditRepository>,
): void {
  describe('record', () => {
    it('EXTAUDIT-1/EXTAUDIT-3 — always inserts a NEW row, provisionally outcome:"failed"', async () => {
      const repo = await makeRepo();
      const row = await repo.record(baseInput);

      expect(typeof row.id).toBe('string');
      expect(row.id.length).toBeGreaterThan(0);
      expect(row.outcome).toBe('failed');
      expect(row.completedAt).toBeNull();
      expect(row.error).toBeNull();
      expect(typeof row.attemptedAt).toBe('string');
    });

    it('EXTAUDIT-2 — carries the exact content for each of the 4 action types, one per record', async () => {
      const repo = await makeRepo();

      const reply = await repo.record({ ...baseInput, payload: { actionType: 'reply', body: 'cuerpo' } });
      const close = await repo.record({ ...baseInput, payload: { actionType: 'close', reason: 'Reclamo resuelto' } });
      const status = await repo.record({ ...baseInput, payload: { actionType: 'status', status: 'en_progreso' } });
      const note = await repo.record({ ...baseInput, payload: { actionType: 'note', text: 'nota interna' } });

      expect(reply.actionType).toBe('reply');
      expect(reply.payload).toEqual({ actionType: 'reply', body: 'cuerpo' });
      expect(close.actionType).toBe('close');
      expect(close.payload).toEqual({ actionType: 'close', reason: 'Reclamo resuelto' });
      expect(status.actionType).toBe('status');
      expect(status.payload).toEqual({ actionType: 'status', status: 'en_progreso' });
      expect(note.actionType).toBe('note');
      expect(note.payload).toEqual({ actionType: 'note', text: 'nota interna' });
    });

    it('EXTAUDIT-4 — carries the actor identity literal, never anonymous', async () => {
      const repo = await makeRepo();
      const row = await repo.record({ ...baseInput, actorLogin: 'api-suricata' });
      expect(row.actorLogin).toBe('api-suricata');
    });

    it('EXTAUDIT-6 — a second `record` call for a different attempt never mutates the first (append-only)', async () => {
      const repo = await makeRepo();
      const first = await repo.record(baseInput);
      const second = await repo.record({ ...baseInput, payload: { actionType: 'reply', body: 'otro intento' } });

      expect(second.id).not.toBe(first.id);

      const rows = await repo.listByTicket(baseInput.ticketId);
      const stillThere = rows.find((r) => r.id === first.id);
      expect(stillThere).toBeDefined();
      expect(stillThere?.payload).toEqual(baseInput.payload);
      expect(stillThere?.outcome).toBe('failed');
    });
  });

  describe('markOutcome', () => {
    it('EXTAUDIT-5 — flips only outcome/completedAt/error, preserving actionType/payload/actorLogin/attemptedAt', async () => {
      const repo = await makeRepo();
      const created = await repo.record(baseInput);

      const updated = await repo.markOutcome(created.id, { outcome: 'applied', completedAt: '2026-09-13T00:00:00.000Z' });

      expect(updated.outcome).toBe('applied');
      expect(updated.completedAt).toBe('2026-09-13T00:00:00.000Z');
      expect(updated.error).toBeNull();
      // Never mutated by markOutcome:
      expect(updated.actionType).toBe(created.actionType);
      expect(updated.payload).toEqual(created.payload);
      expect(updated.actorLogin).toBe(created.actorLogin);
      expect(updated.attemptedAt).toBe(created.attemptedAt);
    });

    it('EXTAUDIT-5 — a failed attempt carries the concrete error', async () => {
      const repo = await makeRepo();
      const created = await repo.record(baseInput);

      const updated = await repo.markOutcome(created.id, { outcome: 'failed', error: 'SURICATA_SESSION_BUSY' });

      expect(updated.outcome).toBe('failed');
      expect(updated.error).toBe('SURICATA_SESSION_BUSY');
    });
  });

  describe('listByTicket', () => {
    it('EXTAUDIT-7 — returns mixed action types for one ticket in a single call', async () => {
      const repo = await makeRepo();
      await repo.record({ ...baseInput, payload: { actionType: 'reply', body: 'r' } });
      await repo.record({ ...baseInput, payload: { actionType: 'close', reason: 'c' } });
      await repo.record({ ...baseInput, payload: { actionType: 'note', text: 'n' } });

      const rows = await repo.listByTicket(baseInput.ticketId);

      expect(rows).toHaveLength(3);
      expect(rows.map((r) => r.actionType).sort()).toEqual(['close', 'note', 'reply']);
    });

    it('EXTAUDIT-1 — every one of the 4 action types produces exactly one record per attempt', async () => {
      const repo = await makeRepo();
      await repo.record({ ...baseInput, payload: { actionType: 'reply', body: 'r' } });
      await repo.record({ ...baseInput, payload: { actionType: 'close', reason: 'c' } });
      await repo.record({ ...baseInput, payload: { actionType: 'status', status: 's' } });
      await repo.record({ ...baseInput, payload: { actionType: 'note', text: 'n' } });

      const rows = await repo.listByTicket(baseInput.ticketId);
      expect(rows).toHaveLength(4);
    });
  });
}

describe('InMemorySuricataBotActionAuditRepository', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { InMemorySuricataBotActionAuditRepository } = require('@infrastructure/adapters/in-memory/InMemorySuricataBotActionAuditRepository') as {
    InMemorySuricataBotActionAuditRepository: new () => SuricataBotActionAuditRepository;
  };

  runSuricataBotActionAuditContractTests(async () => new InMemorySuricataBotActionAuditRepository());
});

const SKIP = !process.env['DATABASE_URL_TEST'];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const maybeSkip = (SKIP ? describe.skip : describe) as any;

maybeSkip('PrismaSuricataBotActionAuditRepository [requires DATABASE_URL_TEST]', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { PrismaSuricataBotActionAuditRepository } = require('@infrastructure/adapters/prisma/PrismaSuricataBotActionAuditRepository') as {
    PrismaSuricataBotActionAuditRepository: new () => SuricataBotActionAuditRepository;
  };
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { prisma } = require('@infrastructure/database/prisma') as {
    prisma: import('@prisma/client').PrismaClient;
  };

  afterAll(async () => {
    await prisma.$disconnect();
  });

  runSuricataBotActionAuditContractTests(async () => new PrismaSuricataBotActionAuditRepository());
});
