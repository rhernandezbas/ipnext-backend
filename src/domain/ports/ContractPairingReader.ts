import { PairingContract } from '../entities/ownershipCase';

export interface FindPairingCandidatesInput {
  /** Exact startDate of the baja contract (ISO 8601) — F0-verified pairing key. */
  startDate: string;
  /** Exact address of the baja contract — F0-verified pairing key (string-exact). */
  address: string;
  /** The baja's own client — a contract of the SAME client is never a titularity candidate. */
  excludeClientId: string;
}

export interface FindTitularityBajasInput {
  /**
   * Cap per detector tick (M2/B1). There is NO time window: the Contract mirror
   * has no updatedAt and does not persist the raw baja date, so a `sinceDays`
   * filter cannot be expressed honestly. The scan stays bounded anyway:
   * `motivoBaja` is forward-only (only stamped on rows synced post 2026-07-10),
   * the result is capped at `limit`, and already-cased rows are excluded via
   * `excludeContractIds` so the cap DRAINS across ticks (fix wave 2).
   */
  limit: number;
  /**
   * Contract ids that already have an OwnershipTransferCase — EXCLUDED from the
   * scan (fix wave 2). Without this the capped batch is occupied forever by the
   * same already-cased rows: the WHERE matches them permanently and `createdAt`
   * is the mirror-row creation time, NOT the baja time, so a "newest-first
   * drains" assumption is false. Empty array = no exclusion.
   */
  excludeContractIds: string[];
}

export interface FindRecentBajasInput {
  /**
   * When true (the worklist default) bajas whose motivoBaja contains
   * CAMBIO DE TITULARIDAD (case-insensitive substring) are EXCLUDED — they live
   * in the titularity tab.
   */
  excludeTitularity: boolean;
  page: number;
  pageSize: number;
}

export interface FindRecentBajasResult {
  items: PairingContract[];
  /** Count over the SAME filter (without pagination) — for the FE paginator. */
  total: number;
}

/**
 * Thin read port over the GR contract mirror for titularity pairing.
 * NOT the full ClientMirrorRepository — the detector only needs these reads.
 */
export interface ContractPairingReader {
  /**
   * Contracts in `baja` (case-insensitive — covers legacy raw "Baja" rows) whose
   * motivoBaja contains CAMBIO DE TITULARIDAD (case-insensitive substring),
   * EXCLUDING `excludeContractIds` (already-cased rows — the cap drains, fix
   * wave 2), capped at `limit` rows per call. The stable order (createdAt DESC +
   * id ASC in Prisma) is a determinism detail, NOT the draining mechanism. See
   * FindTitularityBajasInput for why there is no time window.
   */
  findTitularityBajas(input: FindTitularityBajasInput): Promise<PairingContract[]>;

  /**
   * Single contract by id (pairing projection) — null when not in the mirror.
   * Used by the detector to re-pair pristine cases (H1a) and by the set-target
   * validation of UpdateOwnershipCase (H1b, via the structural
   * ContractOwnershipLookup slice in application lookups).
   */
  getContract(id: string): Promise<PairingContract | null>;

  /**
   * Active (non-baja) contracts of OTHER clients matching the exact pairing keys
   * (same startDate + same address, clientId distinct). Contracts without address
   * never match.
   */
  findActivePairingCandidates(input: FindPairingCandidatesInput): Promise<PairingContract[]>;

  /**
   * actions-worklist W2 (BAJA-1) — contracts in `baja` (case-insensitive),
   * paginated, optionally excluding titularity bajas.
   *
   * "Reciente" (M3): Contract has NO updatedAt and does not persist the raw baja
   * date, so a `days=` window is NOT implementable. The honest proxy is
   * `motivoBaja IS NOT NULL` — the field is forward-only (stamped from
   * 2026-07-10 on), so historical backfill bajas (motivo NULL) are excluded and
   * everything listed post-dates the rollout. Stable order newest-first
   * (createdAt DESC in Prisma, seed-time DESC in the in-memory) with id ASC
   * tiebreak. Revisit if Contract ever gains an updatedAt or a persisted baja date.
   */
  findRecentBajas(input: FindRecentBajasInput): Promise<FindRecentBajasResult>;
}
