import {
  FinanceInvoiceTypeBucket,
  FinanceInvoiceTypeClassification,
  FinanceInvoiceTypeClassificationRepository,
} from '@domain/ports/FinanceInvoiceTypeClassificationRepository';
import { prisma } from '../../database/prisma';

interface ClassificationRow {
  grType: string;
  bucket: string;
  label: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function toEntity(row: ClassificationRow): FinanceInvoiceTypeClassification {
  return {
    grType: row.grType,
    bucket: row.bucket as FinanceInvoiceTypeBucket,
    label: row.label,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * finance-growth Fase 1 — Prisma adapter for the `grType` classification
 * catalog (design.md Decision 2). Uses the `(prisma as any)` accessor (molde
 * `PrismaNocAlertThresholdsConfigRepository`) so it compiles ahead of a
 * client regen for the new table.
 */
export class PrismaFinanceInvoiceTypeClassificationRepository implements FinanceInvoiceTypeClassificationRepository {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private get table(): any {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (prisma as any).financeInvoiceTypeClassification;
  }

  async get(grType: string): Promise<FinanceInvoiceTypeClassification | null> {
    const row: ClassificationRow | null = await this.table.findUnique({ where: { grType } });
    return row ? toEntity(row) : null;
  }

  /**
   * Auto-alta atomic-enough for this batch job's concurrency (single scheduler
   * tick, guarded by the `finance-receipts-ingest` distributed lock): checks
   * first, and on a race (P2002 from a concurrent creator) falls back to
   * re-reading rather than throwing — NEVER overwrites an existing classification.
   */
  async upsertIfAbsent(grType: string): Promise<FinanceInvoiceTypeClassification> {
    const existing = await this.get(grType);
    if (existing) return existing;
    try {
      const created: ClassificationRow = await this.table.create({ data: { grType, bucket: 'unclassified' } });
      return toEntity(created);
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      if (code === 'P2002') {
        const row = await this.get(grType);
        if (row) return row;
      }
      throw err;
    }
  }

  async list(): Promise<FinanceInvoiceTypeClassification[]> {
    const rows: ClassificationRow[] = await this.table.findMany({ orderBy: { grType: 'asc' } });
    return rows.map(toEntity);
  }

  async updateBucket(grType: string, bucket: FinanceInvoiceTypeBucket, label: string | null = null): Promise<FinanceInvoiceTypeClassification> {
    const row: ClassificationRow = await this.table.upsert({
      where: { grType },
      create: { grType, bucket, label },
      update: { bucket, label },
    });
    return toEntity(row);
  }
}
