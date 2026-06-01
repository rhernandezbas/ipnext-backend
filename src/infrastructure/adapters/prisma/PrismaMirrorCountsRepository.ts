import { MirrorCountsRepository } from '@domain/ports/MirrorCountsRepository';
import { prisma } from '../../database/prisma';

export class PrismaMirrorCountsRepository implements MirrorCountsRepository {
  async clientCount(): Promise<number> {
    return prisma.client.count({ where: { grClienteId: { not: null } } });
  }

  async contractCount(): Promise<number> {
    return prisma.contract.count({ where: { grContratoId: { not: null } } });
  }
}
