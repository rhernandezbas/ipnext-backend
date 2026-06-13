import type { ClientTvCancellationRepository } from '@domain/ports/ClientTvCancellationRepository';
import { prisma } from '../../database/prisma';

/**
 * Prisma adapter para ClientTvCancellationRepository (#72).
 *
 * Persiste el flag TV-dada-de-baja en el campo nullable `Client.tvCancelledAt`.
 * GR sync NUNCA escribe esta columna (es estado local del mirror).
 *
 * Usa `(prisma as any).client` para que el adapter compile antes de que se
 * regenere el Prisma Client (mirror de PrismaGigaredConfigRepository).
 *
 * isCancelled devuelve false cuando la fila no existe (null row).
 */
export class PrismaClientTvCancellationRepository implements ClientTvCancellationRepository {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private get table(): any {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (prisma as any).client;
  }

  async markCancelled(clientId: string): Promise<void> {
    await this.table.update({
      where: { id: clientId },
      data: { tvCancelledAt: new Date() },
    });
  }

  async clearCancelled(clientId: string): Promise<void> {
    await this.table.update({
      where: { id: clientId },
      data: { tvCancelledAt: null },
    });
  }

  async isCancelled(clientId: string): Promise<boolean> {
    const row: { tvCancelledAt: Date | null } | null = await this.table.findUnique({
      where: { id: clientId },
      select: { tvCancelledAt: true },
    });
    if (!row) return false;
    return row.tvCancelledAt !== null;
  }
}
