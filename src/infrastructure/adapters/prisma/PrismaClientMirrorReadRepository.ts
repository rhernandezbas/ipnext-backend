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

  /** finance-growth Fase 3 — batch local Client.id -> Client.grClienteId (see port docblock). */
  async getGrClienteIdsByClientIds(clientIds: string[]): Promise<Map<string, string>> {
    if (clientIds.length === 0) return new Map();
    const rows = await prisma.client.findMany({
      where: { id: { in: clientIds }, grClienteId: { not: null } },
      select: { id: true, grClienteId: true },
    });
    const result = new Map<string, string>();
    for (const r of rows) {
      if (r.grClienteId) result.set(r.id, r.grClienteId);
    }
    return result;
  }
}
