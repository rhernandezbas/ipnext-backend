import { randomUUID } from 'crypto';
import { NocAlert, NocAlertInput, computeNocAlertIngest } from '@domain/entities/nocAlert';
import { NocAlertRepository, NocAlertListFilters } from '@domain/ports/NocAlertRepository';
import { prisma } from '../../database/prisma';

/**
 * toNocAlert — Prisma row → domain entity. Exported (same convention as
 * PrismaTicketRepository.toTicket / PrismaCustomerRepository.toCustomer) so the
 * mapping is unit-testable with a plain fixture, WITHOUT a live DB. Dates → ISO
 * strings; never a raw Prisma row leaves this file.
 */
export function toNocAlert(row: any): NocAlert {
  return {
    id: row.id,
    source: row.source,
    fingerprint: row.fingerprint,
    alertname: row.alertname,
    severity: row.severity,
    status: row.status,
    entityType: row.entityType,
    entityName: row.entityName,
    entityRef: row.entityRef,
    metricName: row.metricName,
    metricValue: row.metricValue,
    metricUnit: row.metricUnit,
    threshold: row.threshold,
    message: row.message,
    explanation: row.explanation,
    link: row.link,
    startsAt: row.startsAt instanceof Date ? row.startsAt.toISOString() : row.startsAt,
    firstSeen: row.firstSeen instanceof Date ? row.firstSeen.toISOString() : row.firstSeen,
    lastSeen: row.lastSeen instanceof Date ? row.lastSeen.toISOString() : row.lastSeen,
    endsAt: row.endsAt instanceof Date ? row.endsAt.toISOString() : row.endsAt,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt,
    acknowledged: row.acknowledged,
    ackBy: row.ackBy,
    ackAt: row.ackAt instanceof Date ? row.ackAt.toISOString() : row.ackAt,
    ackNote: row.ackNote,
    escalationState: row.escalationState,
    telegramChatId: row.telegramChatId,
    telegramMessageId: row.telegramMessageId,
  };
}

/** Flatten a NocAlert (minus id) into the shape Prisma's `create`/`update` expect. */
function toRow(alert: NocAlert): Record<string, unknown> {
  return {
    source: alert.source,
    fingerprint: alert.fingerprint,
    alertname: alert.alertname,
    severity: alert.severity,
    status: alert.status,
    entityType: alert.entityType,
    entityName: alert.entityName,
    entityRef: alert.entityRef,
    metricName: alert.metricName,
    metricValue: alert.metricValue,
    metricUnit: alert.metricUnit,
    threshold: alert.threshold,
    message: alert.message,
    explanation: alert.explanation,
    link: alert.link,
    startsAt: new Date(alert.startsAt),
    firstSeen: new Date(alert.firstSeen),
    lastSeen: new Date(alert.lastSeen),
    endsAt: alert.endsAt ? new Date(alert.endsAt) : null,
    createdAt: new Date(alert.createdAt),
    updatedAt: new Date(alert.updatedAt),
    acknowledged: alert.acknowledged,
    ackBy: alert.ackBy,
    ackAt: alert.ackAt ? new Date(alert.ackAt) : null,
    ackNote: alert.ackNote,
    escalationState: alert.escalationState,
    telegramChatId: alert.telegramChatId,
    telegramMessageId: alert.telegramMessageId,
  };
}

export class PrismaNocAlertRepository implements NocAlertRepository {
  async upsertByFingerprint(input: NocAlertInput): Promise<NocAlert> {
    const existingRow = await (prisma as any).nocAlert.findUnique({
      where: { source_fingerprint: { source: input.source, fingerprint: input.fingerprint } },
    });
    const existing = existingRow ? toNocAlert(existingRow) : null;

    // F6 (fix wave) — same as InMemoryNocAlertRepository: the domain fn stays
    // pure, this adapter logs the A6 warning (resolved ingest, no prior firing).
    if (!existing && input.status === 'resolved') {
      // eslint-disable-next-line no-console
      console.warn(
        `[NocAlert] resolved ingest with no prior firing for (${input.source}, ${input.fingerprint}) — ` +
          'creating a resolved row anyway (startsAt = endsAt). Possible late/out-of-order webhook.',
      );
    }

    const nowIso = new Date().toISOString();
    const next = computeNocAlertIngest(existing, input, nowIso, () => existing?.id ?? randomUUID());

    const row = await (prisma as any).nocAlert.upsert({
      where: { source_fingerprint: { source: input.source, fingerprint: input.fingerprint } },
      create: { id: next.id, ...toRow(next) },
      update: toRow(next),
    });
    return toNocAlert(row);
  }

  async findById(id: string): Promise<NocAlert | null> {
    const row = await (prisma as any).nocAlert.findUnique({ where: { id } });
    return row ? toNocAlert(row) : null;
  }

  async list(filters: NocAlertListFilters): Promise<NocAlert[]> {
    const where: Record<string, unknown> = {};
    if (filters.source) where['source'] = filters.source;
    if (filters.severity) where['severity'] = filters.severity;
    if (filters.status) where['status'] = filters.status;
    if (filters.acknowledged !== undefined) where['acknowledged'] = filters.acknowledged;

    const rows = await (prisma as any).nocAlert.findMany({ where, orderBy: { startsAt: 'desc' } });
    return rows.map(toNocAlert);
  }

  async acknowledge(id: string, by: string, at: string, note?: string): Promise<{ alert: NocAlert; changed: boolean } | null> {
    const existingRow = await (prisma as any).nocAlert.findUnique({ where: { id } });
    if (!existingRow) return null;

    // F4 (fix wave) — ACK is idempotent: MTTA = time to the FIRST ack. Mirrors
    // InMemoryNocAlertRepository.acknowledge — see that file for the rationale.
    if (existingRow.acknowledged) {
      return { alert: toNocAlert(existingRow), changed: false };
    }

    // F-D4 (fix wave) — CONDITIONAL update (`updateMany` scoped to
    // `acknowledged: false`, molde `PrismaContractInventoryRepository.transferToContract`)
    // instead of a bare `update`: two concurrent acks can both pass the
    // `findUnique` check above before either persists — the WHERE clause is
    // what actually decides who wins, not the read. `count === 0` means we
    // lost that race (the other caller's write landed first).
    const result = await (prisma as any).nocAlert.updateMany({
      where: { id, acknowledged: false },
      data: {
        acknowledged: true,
        ackBy: by,
        ackAt: new Date(at),
        ackNote: note ?? existingRow.ackNote,
        updatedAt: new Date(at),
      },
    });

    const row = await (prisma as any).nocAlert.findUnique({ where: { id } });
    return { alert: toNocAlert(row), changed: result.count > 0 };
  }

  async attachTelegramMessage(id: string, chatId: string, messageId: string): Promise<NocAlert | null> {
    const existingRow = await (prisma as any).nocAlert.findUnique({ where: { id } });
    if (!existingRow) return null;
    const row = await (prisma as any).nocAlert.update({
      where: { id },
      data: { telegramChatId: chatId, telegramMessageId: messageId },
    });
    return toNocAlert(row);
  }
}
