import { PppoeService, EnforcedState } from '@domain/entities/pppoeService';
import { PppoeServiceRepository, PppoeServiceUpsert } from '@domain/ports/PppoeServiceRepository';
import { prisma } from '../../database/prisma';

/**
 * PrismaPppoeServiceRepository — adapter de persistencia (pppoe-foundation + Fase C).
 * Usa el singleton `prisma` (patrón del proyecto, igual que PrismaNasRepository).
 * `(prisma as any).pppoeService`: el client local no está regenerado (el Dockerfile corre
 * `prisma generate` en build → en prod tipa bien). Gotcha documentado en WORKFLOW-MULTI-REPO.
 */
function model() {
  return (prisma as any).pppoeService;
}

export class PrismaPppoeServiceRepository implements PppoeServiceRepository {
  async upsertByUsername(data: PppoeServiceUpsert): Promise<PppoeService> {
    const fields: Record<string, unknown> = {
      password: data.password,
      profile: data.profile ?? null,
      remoteAddress: data.remoteAddress ?? null,
      status: data.status ?? 'enabled',
      nasId: data.nasId,
      contractId: data.contractId ?? null,
    };
    // enforcedState: solo se escribe si viene (en create cae al default 'active' del schema).
    if (data.enforcedState !== undefined) fields['enforcedState'] = data.enforcedState;
    const row = await model().upsert({
      where: { username: data.username },
      create: { username: data.username, enforcedState: data.enforcedState ?? 'active', ...fields },
      update: fields,
    });
    return toEntity(row);
  }

  async list(): Promise<PppoeService[]> {
    const rows = await model().findMany();
    return rows.map(toEntity);
  }

  async findById(id: string): Promise<PppoeService | null> {
    const row = await model().findUnique({ where: { id } });
    return row ? toEntity(row) : null;
  }

  async findByUsername(username: string): Promise<PppoeService | null> {
    const row = await model().findUnique({ where: { username } });
    return row ? toEntity(row) : null;
  }

  async findByContract(contractId: string): Promise<PppoeService[]> {
    const rows = await model().findMany({ where: { contractId } });
    return rows.map(toEntity);
  }

  async findUnassigned(): Promise<PppoeService[]> {
    const rows = await model().findMany({ where: { contractId: null } });
    return rows.map(toEntity);
  }

  async setContractId(id: string, contractId: string): Promise<PppoeService | null> {
    try {
      const row = await model().update({ where: { id }, data: { contractId } });
      return toEntity(row);
    } catch (err: any) {
      if (err?.code === 'P2025') return null; // fila inexistente → null; el resto PROPAGA
      throw err;
    }
  }

  async setEnforcedState(id: string, state: EnforcedState): Promise<PppoeService | null> {
    try {
      const row = await model().update({ where: { id }, data: { enforcedState: state } });
      return toEntity(row);
    } catch (err: any) {
      // SOLO la fila inexistente se traga como null. Un error de infra (conexión caída, etc.)
      // debe PROPAGARSE: tras cortar en el router, mentir "confirmado" sería peor que fallar.
      if (err?.code === 'P2025') return null;
      throw err;
    }
  }

  async listByClientStatus(status: string): Promise<PppoeService[]> {
    // JOIN pppoe → contract → client; el status del cliente determina el deudor (sin RADIUS).
    const rows = await model().findMany({
      where: { contract: { client: { status } } },
    });
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
    enforcedState: (row.enforcedState ?? 'active') as EnforcedState,
    nasId: row.nasId,
    contractId: row.contractId ?? null,
    createdAt: new Date(row.createdAt).toISOString(),
  };
}
