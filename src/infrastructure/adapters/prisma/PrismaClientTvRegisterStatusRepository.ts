import type { ClientTvRegisterStatusRepository, TvRegisterStatusRow, TvRegisterStatusValue } from '@domain/ports/ClientTvRegisterStatusRepository';
import { prisma } from '../../database/prisma';

/**
 * Adapter Prisma de ClientTvRegisterStatusRepository (gigared-alta-asincrona W1.2).
 *
 * Persiste el estado del job de ALTA asíncrona en tres columnas nullable de Client:
 *   tvRegisterStatus    — TEXT?      ('pending'|'running'|'done'|'failed')
 *   tvRegisterResult    — JSONB?     (TvRegisterJobResult en done; {error} en failed)
 *   tvRegisterStartedAt — TIMESTAMP? (encolado, re-sellado al pasar a 'running')
 *
 * Usa `(prisma as any).client` para compilar antes de regenerar el cliente Prisma
 * (mismo patrón que PrismaClientTvCancelStatusRepository).
 *
 * El sync de GR NUNCA escribe estas columnas — son mirror-only.
 */
export class PrismaClientTvRegisterStatusRepository implements ClientTvRegisterStatusRepository {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private get table(): any {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (prisma as any).client;
  }

  async getStatus(clientId: string): Promise<TvRegisterStatusRow | null> {
    const row: {
      tvRegisterStatus: string | null;
      tvRegisterResult: unknown;
      tvRegisterStartedAt: Date | null;
    } | null = await this.table.findUnique({
      where: { id: clientId },
      select: { tvRegisterStatus: true, tvRegisterResult: true, tvRegisterStartedAt: true },
    });
    if (!row || row.tvRegisterStatus === null) return null;
    return {
      status: row.tvRegisterStatus as TvRegisterStatusValue,
      result: row.tvRegisterResult as TvRegisterStatusRow['result'] ?? undefined,
      startedAt: row.tvRegisterStartedAt ?? undefined,
    };
  }

  async setStatus(clientId: string, statusRow: TvRegisterStatusRow): Promise<void> {
    await this.table.update({
      where: { id: clientId },
      data: {
        tvRegisterStatus: statusRow.status,
        tvRegisterResult: statusRow.result !== undefined ? (statusRow.result as object) : null,
        tvRegisterStartedAt: statusRow.startedAt ?? null,
      },
    });
  }
}
