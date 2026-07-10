import { PairingContract, TITULARITY_MOTIVO } from '@domain/entities/ownershipCase';
import {
  ContractPairingReader,
  FindPairingCandidatesInput,
  FindTitularityBajasInput,
  FindRecentBajasInput,
  FindRecentBajasResult,
} from '@domain/ports/ContractPairingReader';
import { prisma } from '../../database/prisma';

// ─── Row mapper ──────────────────────────────────────────────────────────────

const PAIRING_SELECT = {
  id: true,
  clientId: true,
  address: true,
  startDate: true,
  motivoBaja: true,
  status: true,
} as const;

type PairingRow = {
  id: string;
  clientId: string;
  address: string | null;
  startDate: Date;
  motivoBaja: string | null;
  status: string;
};

function toPairingContract(row: PairingRow): PairingContract {
  return {
    id: row.id,
    clientId: row.clientId,
    address: row.address ?? null,
    startDate: row.startDate.toISOString(),
    motivoBaja: row.motivoBaja ?? null,
    status: row.status,
  };
}

// ─── Reader ──────────────────────────────────────────────────────────────────

/**
 * Thin pairing reads over the Contract mirror (actions-worklist DET-1).
 * Status matches are case-insensitive so legacy raw "Baja"/"Vigente" mirror rows
 * (pre-canonicalization) behave like their canonical counterparts.
 */
export class PrismaContractPairingReader implements ContractPairingReader {
  /**
   * M2/B1 + fix wave 2 — SIN ventana temporal (Contract no tiene updatedAt ni
   * persiste raw.baja, ver doc del port): cap `take: limit` que DRENA por
   * exclusión explícita de las bajas ya caseadas (`id NOT IN
   * excludeContractIds`; con lista vacía el notIn se omite). Sin la exclusión
   * el batch quedaba ocupado para siempre por las mismas filas: el WHERE las
   * matchea permanente y createdAt es la fecha de creación de la fila del
   * mirror, NO la fecha de baja. El orden estable (createdAt DESC + id ASC) es
   * un detalle determinístico, no el mecanismo de drenaje.
   */
  async findTitularityBajas(input: FindTitularityBajasInput): Promise<PairingContract[]> {
    const rows = await prisma.contract.findMany({
      where: {
        status: { equals: 'baja', mode: 'insensitive' },
        motivoBaja: { contains: TITULARITY_MOTIVO, mode: 'insensitive' },
        ...(input.excludeContractIds.length > 0 && {
          id: { notIn: input.excludeContractIds },
        }),
      },
      select: PAIRING_SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: input.limit,
    });
    return rows.map(toPairingContract);
  }

  /** H1 — lectura puntual por id (re-pareo de prístinos + validación set-target). */
  async getContract(id: string): Promise<PairingContract | null> {
    const row = await prisma.contract.findUnique({
      where: { id },
      select: PAIRING_SELECT,
    });
    return row ? toPairingContract(row) : null;
  }

  async findActivePairingCandidates(input: FindPairingCandidatesInput): Promise<PairingContract[]> {
    const rows = await prisma.contract.findMany({
      where: {
        NOT: { status: { equals: 'baja', mode: 'insensitive' } },
        startDate: new Date(input.startDate),
        address: input.address,
        clientId: { not: input.excludeClientId },
      },
      select: PAIRING_SELECT,
    });
    return rows.map(toPairingContract);
  }

  /**
   * actions-worklist W2 (BAJA-1) + M3 — "reciente" honesto: motivoBaja IS NOT
   * NULL es el proxy forward-only (el campo solo se estampa desde 2026-07-10;
   * las bajas históricas del backfill tienen NULL y quedan FUERA). Un `days=`
   * real NO es implementable sin updatedAt/fecha de baja persistida (ver port).
   * Orden estable createdAt DESC + id ASC.
   *
   * El filtro NOT-NULL además destraba el excludeTitularity: como NULL ya no
   * entra, el `NOT { contains }` (que en SQL es NULL para motivo NULL) se
   * aplica solo sobre filas con motivo — sin el viejo OR de NULL-handling.
   */
  async findRecentBajas(input: FindRecentBajasInput): Promise<FindRecentBajasResult> {
    const where = {
      status: { equals: 'baja', mode: 'insensitive' as const },
      motivoBaja: { not: null },
      ...(input.excludeTitularity && {
        NOT: { motivoBaja: { contains: TITULARITY_MOTIVO, mode: 'insensitive' as const } },
      }),
    };

    const [rows, total] = await Promise.all([
      prisma.contract.findMany({
        where,
        select: PAIRING_SELECT,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: (input.page - 1) * input.pageSize,
        take: input.pageSize,
      }),
      prisma.contract.count({ where }),
    ]);

    return { items: rows.map(toPairingContract), total };
  }
}
