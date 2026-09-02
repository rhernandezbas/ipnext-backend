import type { ExternalBulkPreview } from '@domain/entities/externalBulkPreview';
import type {
  ExternalBulkPreviewRepository,
  ExternalBulkPreviewCreateData,
} from '@domain/ports/ExternalBulkPreviewRepository';
import { prisma } from '../../database/prisma';

interface ExternalBulkPreviewRow {
  id: string;
  payloadHash: string;
  templateRef: string;
  templateName: string;
  variables: unknown;
  chatwootLabel: string | null;
  recipients: unknown;
  invalid: unknown;
  validCount: number;
  invalidCount: number;
  expiresAt: Date;
  consumedAt: Date | null;
  campaignId: string | null;
  createdAt: Date;
}

function toEntity(row: ExternalBulkPreviewRow): ExternalBulkPreview {
  return {
    id: row.id,
    payloadHash: row.payloadHash,
    templateRef: row.templateRef,
    templateName: row.templateName,
    variables: (row.variables as Record<string, string>) ?? {},
    chatwootLabel: row.chatwootLabel ?? null,
    recipients: (row.recipients as ExternalBulkPreview['recipients']) ?? [],
    invalid: (row.invalid as ExternalBulkPreview['invalid']) ?? [],
    validCount: row.validCount,
    invalidCount: row.invalidCount,
    expiresAt: row.expiresAt.toISOString(),
    consumedAt: row.consumedAt ? row.consumedAt.toISOString() : null,
    campaignId: row.campaignId ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * external-bulk-messaging (1.6) — implementación Prisma real de
 * `ExternalBulkPreviewRepository` contra el modelo `ExternalBulkPreview`
 * (1.1/1.2). Molde `PrismaCampaignRepository` (mappers puros exportados,
 * Date→ISO string). Sin test contra Prisma real (no hay DB local, regla
 * CLAUDE.md) — cubierto por tests con Prisma MOCKEADO (pin del WHERE/data
 * shape, molde `PrismaClosedServiceOrderRepository.pendingWhere.test.ts`).
 */
export class PrismaExternalBulkPreviewRepository implements ExternalBulkPreviewRepository {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private get table(): any {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (prisma as any).externalBulkPreview;
  }

  async create(data: ExternalBulkPreviewCreateData): Promise<ExternalBulkPreview> {
    const row: ExternalBulkPreviewRow = await this.table.create({
      data: {
        payloadHash: data.payloadHash,
        templateRef: data.templateRef,
        templateName: data.templateName,
        variables: data.variables,
        chatwootLabel: data.chatwootLabel ?? null,
        recipients: data.recipients,
        invalid: data.invalid,
        validCount: data.validCount,
        invalidCount: data.invalidCount,
        expiresAt: new Date(data.expiresAt),
      },
    });
    return toEntity(row);
  }

  async findById(id: string): Promise<ExternalBulkPreview | null> {
    const row: ExternalBulkPreviewRow | null = await this.table.findUnique({ where: { id } });
    return row ? toEntity(row) : null;
  }

  /**
   * D3.b/D8 — el mecanismo EXACTO de la carrera: `updateMany` con
   * `where:{id, consumedAt:null}` solo afecta la fila si NADIE la consumió
   * todavía. `count===1` ⇒ esta llamada ganó; `count===0` ⇒ perdió (otra
   * llamada la consumió primero, o el id no existe).
   */
  async markConsumed(id: string, campaignId: string): Promise<boolean> {
    const result: { count: number } = await this.table.updateMany({
      where: { id, consumedAt: null },
      data: { consumedAt: new Date(), campaignId },
    });
    return result.count === 1;
  }

  /**
   * D9 — purga oportunista acotada. `deleteMany` no soporta `take`, así que
   * primero se resuelven hasta `limit` ids vencidos (apoyado en
   * `@@index([expiresAt])`) y luego se borran por id — dos queries baratas,
   * nunca un `DELETE ... LIMIT` no-estándar.
   */
  async deleteExpiredBefore(before: Date, limit: number): Promise<number> {
    const expired: { id: string }[] = await this.table.findMany({
      where: { expiresAt: { lt: before } },
      select: { id: true },
      take: limit,
    });
    if (expired.length === 0) return 0;
    const ids = expired.map((r) => r.id);
    const result: { count: number } = await this.table.deleteMany({ where: { id: { in: ids } } });
    return result.count;
  }
}
