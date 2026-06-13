import type { ClientTvActivationRepository } from '@domain/ports/ClientTvActivationRepository';
import { prisma } from '../../database/prisma';

/**
 * Prisma adapter para ClientTvActivationRepository (#81).
 *
 * Persiste el contador de reactivaciones de TV en el campo `Client.tvActivationSeq` (Int, default 0).
 * GR sync NUNCA escribe esta columna (estado local del mirror).
 *
 * `incrementSeq` usa `{ increment: 1 }` de Prisma (atómico a nivel DB) y devuelve el nuevo valor
 * leído de la fila actualizada.
 *
 * Usa `(prisma as any).client` para compilar antes de regenerar el Prisma Client
 * (mirror de PrismaClientTvCancellationRepository).
 */
export class PrismaClientTvActivationRepository implements ClientTvActivationRepository {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private get table(): any {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (prisma as any).client;
  }

  async getSeq(clientId: string): Promise<number> {
    const row: { tvActivationSeq: number | null } | null = await this.table.findUnique({
      where: { id: clientId },
      select: { tvActivationSeq: true },
    });
    if (!row) return 0;
    return row.tvActivationSeq ?? 0;
  }

  async incrementSeq(clientId: string): Promise<number> {
    const row: { tvActivationSeq: number } = await this.table.update({
      where: { id: clientId },
      data: { tvActivationSeq: { increment: 1 } },
      select: { tvActivationSeq: true },
    });
    return row.tvActivationSeq;
  }
}
