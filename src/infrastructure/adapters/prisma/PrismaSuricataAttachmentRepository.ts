import type {
  SuricataAttachmentRepository,
  ListRetriableSuricataAttachmentsOptions,
} from '@domain/ports/SuricataAttachmentRepository';
import type {
  SuricataAttachmentRecord,
  UpsertSuricataAttachmentInput,
  MarkSuricataAttachmentStoredInput,
  MarkSuricataAttachmentFailedInput,
} from '@domain/entities/suricata';
import { SuricataAttachmentNotFoundError } from '@domain/errors/suricata';
import { prisma } from '../../database/prisma';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toDomain(row: any): SuricataAttachmentRecord {
  return {
    id: row.id,
    ticketId: row.ticketId,
    messageId: row.messageId ?? null,
    externalRef: row.externalRef,
    fileName: row.fileName,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes ?? null,
    sha256: row.sha256 ?? null,
    storageKey: row.storageKey ?? null,
    status: row.status,
    attempts: row.attempts,
    lastError: row.lastError ?? null,
  };
}

/**
 * suricata-tickets-mirror (Phase C, task C.5, D7) — Prisma adapter for
 * `SuricataAttachmentRepository`. Dedup key is `(ticketId, externalRef)`
 * (schema `@@unique`); the sha256/storageKey pair is written by `markStored`
 * once the binary is actually saved to `FileStorage` (D7.b).
 */
export class PrismaSuricataAttachmentRepository implements SuricataAttachmentRepository {
  async upsertByExternalRef(input: UpsertSuricataAttachmentInput): Promise<SuricataAttachmentRecord> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = await (prisma as any).suricataAttachment.upsert({
      where: { ticketId_externalRef: { ticketId: input.ticketId, externalRef: input.externalRef } },
      create: {
        ticketId: input.ticketId,
        messageId: input.messageId,
        externalRef: input.externalRef,
        fileName: input.fileName,
        mimeType: input.mimeType ?? 'application/octet-stream',
        sizeBytes: input.sizeBytes ?? null,
      },
      update: {
        messageId: input.messageId,
        fileName: input.fileName,
        ...(input.mimeType !== undefined ? { mimeType: input.mimeType } : {}),
        ...(input.sizeBytes !== undefined ? { sizeBytes: input.sizeBytes } : {}),
      },
    });
    return toDomain(row);
  }

  async listRetriable(options: ListRetriableSuricataAttachmentsOptions): Promise<SuricataAttachmentRecord[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (prisma as any).suricataAttachment.findMany({
      where: { status: { not: 'stored' }, attempts: { lt: options.maxAttempts } },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return rows.map((r: any) => toDomain(r));
  }

  async markStored(id: string, input: MarkSuricataAttachmentStoredInput): Promise<SuricataAttachmentRecord> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const row = await (prisma as any).suricataAttachment.update({
        where: { id },
        data: {
          status: 'stored',
          sha256: input.sha256,
          storageKey: input.storageKey,
          sizeBytes: input.sizeBytes,
          lastError: null,
        },
      });
      return toDomain(row);
    } catch (e) {
      if ((e as { code?: string } | null)?.code === 'P2025') throw new SuricataAttachmentNotFoundError(id);
      throw e;
    }
  }

  async markFailed(id: string, input: MarkSuricataAttachmentFailedInput): Promise<SuricataAttachmentRecord> {
    // Never revert an already-`stored` row (molde ChatMessageAttachment fix-be #2).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (prisma as any).suricataAttachment.updateMany({
      where: { id, status: { not: 'stored' } },
      data: { status: 'failed', attempts: { increment: 1 }, lastError: input.error },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = await (prisma as any).suricataAttachment.findUnique({ where: { id } });
    if (!row) throw new SuricataAttachmentNotFoundError(id);
    return toDomain(row);
  }

  async findById(id: string): Promise<SuricataAttachmentRecord | null> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = await (prisma as any).suricataAttachment.findUnique({ where: { id } });
    return row ? toDomain(row) : null;
  }

  async listByTicketId(ticketId: string): Promise<SuricataAttachmentRecord[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (prisma as any).suricataAttachment.findMany({ where: { ticketId } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return rows.map((r: any) => toDomain(r));
  }
}
