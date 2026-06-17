import { PrismaClient } from '@prisma/client';
import { PppoeService } from '@domain/entities/pppoeService';
import { PppoeServiceRepository, PppoeServiceUpsert } from '@domain/ports/PppoeServiceRepository';

/**
 * PrismaPppoeServiceRepository — adapter de persistencia (pppoe-foundation).
 * `(prisma as any).pppoeService`: el client local no está regenerado (el Dockerfile corre
 * `prisma generate` en build → en prod tipa bien). Gotcha documentado en WORKFLOW-MULTI-REPO.
 */
export class PrismaPppoeServiceRepository implements PppoeServiceRepository {
  constructor(private readonly prisma: PrismaClient) {}

  private get model() {
    return (this.prisma as any).pppoeService;
  }

  async upsertByUsername(data: PppoeServiceUpsert): Promise<PppoeService> {
    const fields = {
      password: data.password,
      profile: data.profile ?? null,
      remoteAddress: data.remoteAddress ?? null,
      status: data.status ?? 'enabled',
      nasId: data.nasId,
      contractId: data.contractId ?? null,
    };
    const row = await this.model.upsert({
      where: { username: data.username },
      create: { username: data.username, ...fields },
      update: fields,
    });
    return toEntity(row);
  }

  async list(): Promise<PppoeService[]> {
    const rows = await this.model.findMany();
    return rows.map(toEntity);
  }

  async findById(id: string): Promise<PppoeService | null> {
    const row = await this.model.findUnique({ where: { id } });
    return row ? toEntity(row) : null;
  }

  async findByUsername(username: string): Promise<PppoeService | null> {
    const row = await this.model.findUnique({ where: { username } });
    return row ? toEntity(row) : null;
  }

  async findByContract(contractId: string): Promise<PppoeService[]> {
    const rows = await this.model.findMany({ where: { contractId } });
    return rows.map(toEntity);
  }
}

function toEntity(row: any): PppoeService {
  return {
    id: row.id,
    username: row.username,
    password: row.password,
    profile: row.profile ?? null,
    remoteAddress: row.remoteAddress ?? null,
    status: row.status,
    nasId: row.nasId,
    contractId: row.contractId ?? null,
    createdAt: new Date(row.createdAt).toISOString(),
  };
}
