import type { ClientTvCancelStatusRepository, TvCancelStatusRow, TvCancelStatusValue } from '@domain/ports/ClientTvCancelStatusRepository';
import { prisma } from '../../database/prisma';

/**
 * Prisma adapter for ClientTvCancelStatusRepository (#10/#11).
 *
 * Persists the async TV-cancel job state in three nullable columns on Client:
 *   tvCancelStatus    — TEXT? ('pending'|'running'|'done'|'failed')
 *   tvCancelResult    — JSONB? (CancelTvResult or {error})
 *   tvCancelStartedAt — TIMESTAMP? (when runner set status to 'running')
 *
 * Uses `(prisma as any).client` to compile before Prisma Client regeneration
 * (mirrors the pattern of PrismaClientTvCancellationRepository).
 *
 * GR sync NEVER writes these columns — they are mirror-only.
 */
export class PrismaClientTvCancelStatusRepository implements ClientTvCancelStatusRepository {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private get table(): any {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (prisma as any).client;
  }

  async getStatus(clientId: string): Promise<TvCancelStatusRow | null> {
    const row: {
      tvCancelStatus: string | null;
      tvCancelResult: unknown;
      tvCancelStartedAt: Date | null;
    } | null = await this.table.findUnique({
      where: { id: clientId },
      select: { tvCancelStatus: true, tvCancelResult: true, tvCancelStartedAt: true },
    });
    if (!row || row.tvCancelStatus === null) return null;
    return {
      status: row.tvCancelStatus as TvCancelStatusValue,
      result: row.tvCancelResult as TvCancelStatusRow['result'] ?? undefined,
      startedAt: row.tvCancelStartedAt ?? undefined,
    };
  }

  async setStatus(clientId: string, statusRow: TvCancelStatusRow): Promise<void> {
    await this.table.update({
      where: { id: clientId },
      data: {
        tvCancelStatus: statusRow.status,
        tvCancelResult: statusRow.result !== undefined ? (statusRow.result as object) : null,
        tvCancelStartedAt: statusRow.startedAt ?? null,
      },
    });
  }
}
