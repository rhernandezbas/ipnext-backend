// Domain types for the actions-worklist ownership-transfer cases (EPIC titularidad F2).
// String unions (not Prisma enums) — domain layer has zero external dependencies.

export type OwnershipCaseStatus = 'pending' | 'ambiguous' | 'done' | 'dismissed';

/**
 * The GR `motivo_baja` marker that identifies a titularity change.
 * Matching is ALWAYS case-insensitive substring (GR free-text variants like
 * "Baja por Cambio de Titularidad (venta)" must match too).
 */
export const TITULARITY_MOTIVO = 'CAMBIO DE TITULARIDAD';

/** A pairing candidate on an ambiguous case — persisted as JSON on the case. */
export interface OwnershipCaseCandidate {
  contractId: string;
  clientId: string;
}

export interface OwnershipTransferCase {
  id: string;
  /** Contract in `baja` that triggered the case — one case per contract (unique). */
  sourceContractId: string;
  sourceClientId: string;
  /** Snapshot of the GR motivo that triggered detection. */
  motivoBaja: string;
  /** GR `baja` date (dd-mm-yyyy) when available in raw — null otherwise. */
  bajaDate: string | null;
  /** Destination contract/client — null while unpaired or ambiguous until the pick. */
  targetContractId: string | null;
  targetClientId: string | null;
  /** Pairing candidates when >=2 matched — null otherwise. */
  candidates: OwnershipCaseCandidate[] | null;
  status: OwnershipCaseStatus;
  dismissReason: string | null;
  /** Manual physical-world check — with actor/date trail. */
  equipmentReviewed: boolean;
  equipmentReviewedById: string | null;
  equipmentReviewedAt: string | null; // ISO 8601
  detectedAt: string; // ISO 8601
  updatedAt: string;  // ISO 8601
}

/**
 * Minimal contract projection the pairing detector needs — a thin slice of the
 * GR mirror, NOT the full Contract entity.
 */
export interface PairingContract {
  id: string;
  clientId: string;
  address: string | null;
  startDate: string; // ISO 8601
  motivoBaja: string | null;
  status: string;
}
