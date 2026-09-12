import type { SuricataReplyAuditRepository } from '@domain/ports/SuricataReplyAuditRepository';
import type {
  SuricataReplyAuditRecord,
  RecordSuricataReplyAttemptInput,
  MarkSuricataReplyOutcomeInput,
} from '@domain/entities/suricata';
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toDomain(row: any): SuricataReplyAuditRecord {
  return {
    id: row.id,
    ticketId: row.ticketId,
    actorId: row.actorId,
    body: row.body,
    outcome: row.outcome,
    error: row.error ?? null,
    attemptedAt: toIso(row.attemptedAt),
    sentAt: toIsoOrNull(row.sentAt),
  };
}

/**
 * suricata-tickets-mirror (Phase E, task E.1, design D10) — Prisma adapter for
 * `SuricataReplyAuditRepository`. `record` is a plain INSERT (one row per
 * attempt); `markOutcome` is the only mutation afterward, `tsc`-verified only
 * (no local DB, repo convention).
 */
export class PrismaSuricataReplyAuditRepository implements SuricataReplyAuditRepository {
  async record(input: RecordSuricataReplyAttemptInput): Promise<SuricataReplyAuditRecord> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = await (prisma as any).suricataReplyAudit.create({
      data: {
        ticketId: input.ticketId,
        actorId: input.actorId,
        body: input.body,
        outcome: 'failed',
      },
    });
    return toDomain(row);
  }

  async markOutcome(id: string, input: MarkSuricataReplyOutcomeInput): Promise<SuricataReplyAuditRecord> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = await (prisma as any).suricataReplyAudit.update({
      where: { id },
      data: {
        outcome: input.outcome,
        sentAt: input.sentAt ?? null,
        error: input.error ?? null,
      },
    });
    return toDomain(row);
  }
}
