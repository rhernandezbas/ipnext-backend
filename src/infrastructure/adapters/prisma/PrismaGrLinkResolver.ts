import { GrLinkResolverPort } from '@domain/ports/GrLinkResolverPort';
import { prisma } from '../../database/prisma';

/**
 * Prisma read side of GR FK resolution. Looks up the already-mirrored local
 * Client by `grClienteId` and Service by `grContratoId` (both unique columns
 * populated by the GR mirror write side). Returns `null` when the upstream
 * entity was never mirrored, so the ingest skips+counts it rather than throwing.
 */
export class PrismaGrLinkResolver implements GrLinkResolverPort {
  async findClientByGrId(grClienteId: string): Promise<{ id: string; name: string } | null> {
    const client = await prisma.client.findUnique({
      where: { grClienteId },
      select: { id: true, name: true },
    });
    return client ? { id: client.id, name: client.name } : null;
  }

  async findServiceByGrContratoId(
    grContratoId: string,
  ): Promise<{ id: string; plan: string | null } | null> {
    const service = await prisma.service.findUnique({
      where: { grContratoId },
      select: { id: true, plan: true },
    });
    return service ? { id: service.id, plan: service.plan } : null;
  }
}
