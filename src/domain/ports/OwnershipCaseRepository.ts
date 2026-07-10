import {
  OwnershipTransferCase,
  OwnershipCaseStatus,
  OwnershipCaseCandidate,
} from '../entities/ownershipCase';

// ─── Mutation inputs ──────────────────────────────────────────────────────────

export interface CreateOwnershipCaseInput {
  sourceContractId: string;
  sourceClientId: string;
  motivoBaja: string;
  bajaDate?: string | null;
  targetContractId?: string | null;
  targetClientId?: string | null;
  candidates?: OwnershipCaseCandidate[] | null;
  status: OwnershipCaseStatus;
}

/** Partial patch — only the provided (non-undefined) fields are applied. */
export interface OwnershipCasePatch {
  targetContractId?: string | null;
  targetClientId?: string | null;
  candidates?: OwnershipCaseCandidate[] | null;
  status?: OwnershipCaseStatus;
  dismissReason?: string | null;
  equipmentReviewed?: boolean;
  equipmentReviewedById?: string | null;
  equipmentReviewedAt?: string | null; // ISO 8601
}

// ─── Query shapes ─────────────────────────────────────────────────────────────

export interface OwnershipCaseListFilter {
  status?: OwnershipCaseStatus;
  page: number;
  pageSize: number;
}

export interface OwnershipCaseListResult {
  items: OwnershipTransferCase[];
  total: number;
}

// ─── Port interface ───────────────────────────────────────────────────────────

export interface OwnershipCaseRepository {
  /** True when a case already exists for this source (baja) contract — idempotency guard. */
  existsBySourceContract(contractId: string): Promise<boolean>;

  /**
   * Create a new case. `sourceContractId` is unique — creating a duplicate throws
   * (DB unique index); the detector guards with existsBySourceContract first.
   */
  create(input: CreateOwnershipCaseInput): Promise<OwnershipTransferCase>;

  /** Get a case by id. Returns null if not found. */
  getById(id: string): Promise<OwnershipTransferCase | null>;

  /**
   * List cases, optionally filtered by status, paginated.
   * Stable order: detectedAt DESC, id ASC (both adapters — L7).
   */
  list(filter: OwnershipCaseListFilter): Promise<OwnershipCaseListResult>;

  /**
   * Pristine unpaired cases the detector may re-pair (H1a): status `pending`,
   * no target, no candidates and NO manual review — nothing human happened yet.
   * Capped at `limit`, oldest-first (detectedAt ASC + id ASC) so the backlog
   * drains FIFO.
   */
  listPristineUnpaired(limit: number): Promise<OwnershipTransferCase[]>;

  /**
   * All sourceContractIds that already have a case, ANY status (fix wave 2).
   * The detector feeds them to `findTitularityBajas.excludeContractIds` so the
   * capped scan DRAINS instead of re-reading the same already-cased rows forever.
   * Bounded: one id per real titularity baja — the set stays small.
   */
  listAllSourceContractIds(): Promise<string[]>;

  /** Patch a case. Returns the updated case, or null if it does not exist. */
  update(id: string, patch: OwnershipCasePatch): Promise<OwnershipTransferCase | null>;

  /**
   * Fix wave 2 — CAS re-pair: applies the patch ONLY IF the case is still
   * PRISTINE (`pending`, no target, candidates null, no manual review) — the
   * exact same shape listPristineUnpaired selects. Conditional updateMany in
   * Prisma; returns true when the patch landed, false when the case moved in
   * between (operator dismissed it or set a target between the pristine listing
   * and this write). On false the caller MUST skip: never resurrect a dismissed
   * case, never overwrite an operator's target.
   */
  updateIfPristine(id: string, patch: OwnershipCasePatch): Promise<boolean>;

  /**
   * M1 — CAS flip to `done`: atomically sets status='done' ONLY IF the case is
   * still `pending` with equipmentReviewed=true (conditional updateMany in
   * Prisma). Returns true when the flip happened; false when the precondition
   * no longer holds (e.g. a concurrent dismiss) — the caller must NOT present
   * the case as done in that path.
   */
  flipToDone(id: string): Promise<boolean>;
}
