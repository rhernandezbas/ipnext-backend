import { ClientMirrorReadRepository } from '@domain/ports/ClientMirrorReadRepository';
import { prisma } from '../../database/prisma';

/**
 * Prisma-backed read-only enumeration of the local client mirror.
 * Returns the distinct set of non-null grClienteId values.
 */
export class PrismaClientMirrorReadRepository implements ClientMirrorReadRepository {
  async listGrClienteIds(): Promise<string[]> {
    const rows = await prisma.client.findMany({
      where: { grClienteId: { not: null } },
      select: { grClienteId: true },
      distinct: ['grClienteId'],
    });
    return rows
      .map(r => r.grClienteId)
      .filter((id): id is string => id !== null);
  }
}
