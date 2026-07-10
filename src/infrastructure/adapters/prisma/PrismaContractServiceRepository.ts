import { ContractServiceView } from '@domain/entities/contract-service';
import { ContractServiceRepository } from '@domain/ports/ContractServiceRepository';
import { ContractServiceDuplicateError } from '@domain/errors/contractServices';
import { prisma } from '../../database/prisma';

/** Maps a ContractService row (with `serviceCatalog` joined) to the view. */
function toView(row: any): ContractServiceView {
  return {
    id: row.id,
    contractId: row.contractId,
    serviceCatalogId: row.serviceCatalogId,
    name: row.serviceCatalog?.name ?? '',
    label: row.serviceCatalog?.label ?? null,
    status: row.status,
    notes: row.notes ?? null,
    tvLogin: row.tvLogin ?? null,
    tvPassword: row.tvPassword ?? null,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    deactivatedAt: row.deactivatedAt instanceof Date ? row.deactivatedAt.toISOString() : (row.deactivatedAt ?? null),
  };
}

const INCLUDE = { serviceCatalog: true } as const;

export class PrismaContractServiceRepository implements ContractServiceRepository {
  async getById(id: string): Promise<ContractServiceView | null> {
    const row = await (prisma as any).contractService.findUnique({ where: { id }, include: INCLUDE });
    return row ? toView(row) : null;
  }

  async getByPair(contractId: string, serviceCatalogId: string): Promise<ContractServiceView | null> {
    const row = await (prisma as any).contractService.findUnique({
      where: { contractId_serviceCatalogId: { contractId, serviceCatalogId } },
      include: INCLUDE,
    });
    return row ? toView(row) : null;
  }

  async listByContract(contractId: string): Promise<ContractServiceView[]> {
    const rows = await (prisma as any).contractService.findMany({
      where: { contractId },
      include: INCLUDE,
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toView);
  }

  // service-transfer — locate the ACTIVE Gigared-managed TV slot(s) by notes prefix ("CIC {cic}")
  // when the transfer caller did not supply sourceContractId. Fix wave MEDIUM-1: findMany (ALL
  // candidates, oldest-first) — the use case re-validates the exact cic (cicFromNotes) per row
  // (prefix collision "CIC 123" vs "CIC 1234") and inactivates EVERY row recording the cic.
  async findActiveByCatalogAndNotesPrefix(serviceCatalogId: string, notesPrefix: string): Promise<ContractServiceView[]> {
    const rows = await (prisma as any).contractService.findMany({
      where: { serviceCatalogId, status: 'active', notes: { startsWith: notesPrefix } },
      include: INCLUDE,
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toView);
  }

  async add(data: { contractId: string; serviceCatalogId: string; notes?: string | null; tvLogin?: string | null; tvPassword?: string | null }): Promise<ContractServiceView> {
    try {
      const row = await (prisma as any).contractService.create({
        data: {
          contractId: data.contractId,
          serviceCatalogId: data.serviceCatalogId,
          notes: data.notes ?? null,
          ...(data.tvLogin !== undefined ? { tvLogin: data.tvLogin } : {}),
          ...(data.tvPassword !== undefined ? { tvPassword: data.tvPassword } : {}),
        },
        include: INCLUDE,
      });
      return toView(row);
    } catch (err: unknown) {
      // P2002 — unique (contractId, serviceCatalogId) violation (covers the race the
      // use-case pre-check can miss). Map to the domain duplicate error.
      if ((err as { code?: string })?.code === 'P2002') throw new ContractServiceDuplicateError();
      throw err;
    }
  }

  async update(
    id: string,
    data: { status?: string; notes?: string | null; tvLogin?: string | null; tvPassword?: string | null },
  ): Promise<ContractServiceView | null> {
    try {
      // #65 fix wave — forward tvLogin/tvPassword too. The previous signature dropped them, so
      // credentials written via update() (ChangeTvPassword persistence, register on an existing row,
      // M6 cleanup on baja) silently never reached the DB. Spread only the keys that are present so a
      // status/notes-only PATCH never clobbers the credentials.
      // #73 — derive deactivatedAt from status transitions: inactive → set now(), active → null.
      const patch: Record<string, unknown> = {};
      if (data.status !== undefined) {
        patch['status'] = data.status;
        if (data.status === 'inactive') {
          // Read current row to only stamp deactivatedAt when transitioning from active.
          const current = await (prisma as any).contractService.findUnique({ where: { id }, select: { status: true } });
          if (current && current.status !== 'inactive') {
            patch['deactivatedAt'] = new Date();
          }
        } else if (data.status === 'active') {
          patch['deactivatedAt'] = null;
        }
      }
      if (data.notes !== undefined) patch['notes'] = data.notes;
      if (data.tvLogin !== undefined) patch['tvLogin'] = data.tvLogin;
      if (data.tvPassword !== undefined) patch['tvPassword'] = data.tvPassword;
      const row = await (prisma as any).contractService.update({ where: { id }, data: patch, include: INCLUDE });
      return toView(row);
    } catch {
      return null;
    }
  }

  async delete(id: string): Promise<boolean> {
    try {
      await (prisma as any).contractService.delete({ where: { id } });
      return true;
    } catch {
      return false;
    }
  }
}
