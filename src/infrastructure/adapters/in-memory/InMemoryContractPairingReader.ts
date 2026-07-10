import { PairingContract, TITULARITY_MOTIVO } from '@domain/entities/ownershipCase';
import {
  ContractPairingReader,
  FindPairingCandidatesInput,
  FindTitularityBajasInput,
  FindRecentBajasInput,
  FindRecentBajasResult,
} from '@domain/ports/ContractPairingReader';

/** Case-insensitive 'baja' — covers canonical 'baja' AND legacy raw "Baja" mirror rows. */
function isBaja(status: string): boolean {
  return status.toLowerCase() === 'baja';
}

export class InMemoryContractPairingReader implements ContractPairingReader {
  /**
   * `seededAt` mimics the mirror-row creation time the Prisma adapter orders by
   * (createdAt) — it is adapter-internal, NOT part of the PairingContract
   * domain projection.
   */
  private rows: Array<{ contract: PairingContract; seededAt: Date }> = [];

  // ─── Test helpers ────────────────────────────────────────────────────────────

  seed(contract: PairingContract, seededAt: Date = new Date()): void {
    this.rows.push({ contract, seededAt });
  }

  reset(): void {
    this.rows = [];
  }

  // ─── Port implementations ────────────────────────────────────────────────────

  /**
   * M2/B1 + fix wave 2 — cap sin ventana QUE DRENA: excluye los ids ya caseados
   * (excludeContractIds) ANTES del cap, espejo del `id NOT IN` del adapter
   * Prisma. El orden estable (seed-time DESC + id ASC, espejo del createdAt
   * DESC) es un detalle determinístico, no el mecanismo de drenaje. Ver port.
   */
  async findTitularityBajas(input: FindTitularityBajasInput): Promise<PairingContract[]> {
    const marker = TITULARITY_MOTIVO.toUpperCase();
    const excluded = new Set(input.excludeContractIds);

    return this.rows
      .filter(({ contract }) =>
        isBaja(contract.status) &&
        contract.motivoBaja !== null &&
        contract.motivoBaja.toUpperCase().includes(marker) &&
        !excluded.has(contract.id),
      )
      .sort((a, b) =>
        b.seededAt.getTime() - a.seededAt.getTime() ||
        a.contract.id.localeCompare(b.contract.id),
      )
      .slice(0, input.limit)
      .map(({ contract }) => contract);
  }

  async getContract(id: string): Promise<PairingContract | null> {
    return this.rows.find(({ contract }) => contract.id === id)?.contract ?? null;
  }

  async findActivePairingCandidates(input: FindPairingCandidatesInput): Promise<PairingContract[]> {
    return this.rows
      .filter(({ contract }) =>
        !isBaja(contract.status) &&
        contract.clientId !== input.excludeClientId &&
        contract.address !== null &&
        contract.address === input.address &&
        contract.startDate === input.startDate,
      )
      .map(({ contract }) => contract);
  }

  /**
   * actions-worklist W2 (BAJA-1) + M3: solo bajas con motivoBaja NOT NULL
   * (proxy forward-only de "reciente" — el backfill histórico tiene NULL).
   * Orden estable seed-time DESC + id ASC — espejo del createdAt DESC del
   * adapter Prisma (ver doc del port).
   */
  async findRecentBajas(input: FindRecentBajasInput): Promise<FindRecentBajasResult> {
    const marker = TITULARITY_MOTIVO.toUpperCase();

    const matches = this.rows
      .filter(({ contract }) => {
        if (!isBaja(contract.status)) return false;
        // M3 — "reciente" honesto: motivo NULL = baja histórica del backfill, fuera.
        if (contract.motivoBaja === null) return false;
        if (input.excludeTitularity) {
          return !contract.motivoBaja.toUpperCase().includes(marker);
        }
        return true;
      })
      .sort((a, b) =>
        b.seededAt.getTime() - a.seededAt.getTime() ||
        a.contract.id.localeCompare(b.contract.id),
      )
      .map(({ contract }) => contract);

    const total = matches.length;
    const start = (input.page - 1) * input.pageSize;
    return { items: matches.slice(start, start + input.pageSize), total };
  }
}
