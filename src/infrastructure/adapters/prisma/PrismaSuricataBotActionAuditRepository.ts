import type { SuricataBotActionAuditRepository } from '@domain/ports/SuricataBotActionAuditRepository';
import type {
  SuricataBotActionRecord,
  SuricataBotActionPayload,
  RecordSuricataBotActionInput,
  MarkSuricataBotActionOutcomeInput,
} from '@domain/entities/suricataBotAction';
import { isSuricataBotActionPayload } from '@domain/entities/suricataBotAction';
import { prisma } from '../../database/prisma';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toIso(value: any): string {
  return value instanceof Date ? value.toISOString() : (value as string);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toIsoOrNull(value: any): string | null {
  if (value === null || value === undefined) return null;
  return toIso(value);
}

function toPayload(value: unknown): SuricataBotActionPayload {
  if (!isSuricataBotActionPayload(value)) {
    throw new Error('SuricataBotActionAudit row carries a payload that is not a known action shape');
  }
  return value;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toDomain(row: any): SuricataBotActionRecord {
  return {
    id: row.id,
    ticketId: row.ticketId,
    actionType: row.actionType,
    payload: toPayload(row.payload),
    actorLogin: row.actorLogin,
    outcome: row.outcome,
    error: row.error ?? null,
    attemptedAt: toIso(row.attemptedAt),
    completedAt: toIsoOrNull(row.completedAt),
  };
}

/**
 * suricata-bot-autonomous-actions (Phase A, task A.11, design D1/D10) —
 * Prisma adapter for `SuricataBotActionAuditRepository`. `record` is a plain
 * INSERT (one row per attempt); `markOutcome` is the only mutation
 * afterward, `tsc`-verified only (no local DB, repo convention).
 */
export class PrismaSuricataBotActionAuditRepository implements SuricataBotActionAuditRepository {
  async record(input: RecordSuricataBotActionInput): Promise<SuricataBotActionRecord> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = await (prisma as any).suricataBotActionAudit.create({
      data: {
        ticketId: input.ticketId,
        actionType: input.payload.actionType,
        payload: input.payload,
        actorLogin: input.actorLogin,
        outcome: 'failed',
      },
    });
    return toDomain(row);
  }

  async markOutcome(id: string, input: MarkSuricataBotActionOutcomeInput): Promise<SuricataBotActionRecord> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = await (prisma as any).suricataBotActionAudit.update({
      where: { id },
      data: {
        outcome: input.outcome,
        completedAt: input.completedAt ?? null,
        error: input.error ?? null,
      },
    });
    return toDomain(row);
  }

  async listByTicket(ticketId: string): Promise<SuricataBotActionRecord[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (prisma as any).suricataBotActionAudit.findMany({
      where: { ticketId },
      orderBy: { attemptedAt: 'asc' },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return rows.map((r: any) => toDomain(r));
  }
}
