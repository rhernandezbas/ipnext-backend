/**
 * Closure-detected equipment RETURN suggestion (EPIC #38 W4).
 *
 * Staged (read-only) when a completed RETIRO SO closes; an operator later confirms
 * (the ONLY stock mutation) which records a RETURN→DEPOSITO movement. The inverse of
 * #19's TaskInventorySuggestion: it points at an EXISTING installed asset to return,
 * not a new device to create on a contract.
 */

export type ReturnSuggestionStatus = 'pending' | 'needs_review' | 'confirmed' | 'discarded';
export type ReturnResolution = 'return' | 'link' | 'create' | 'discard';

export interface ReturnSuggestion {
  id: string;
  taskId: string;
  serviceOrderId: string; // IClass iclassId (for sourceRef + traceability)
  serialNumber: string | null; // normalized OCR serial
  mac: string | null;
  deviceType: string | null; // hint from the OCR label
  matchedAssetId: string | null; // null until/unless an installed asset matches
  status: ReturnSuggestionStatus;
  resolution: ReturnResolution | null; // set on confirm; null while pending
  confirmedMovementId: string | null; // the real movement.id (uuid) produced on confirm (Fix #5)
  sourceRef: string | null; // L2 natural key `iclass:return:{assetId}` — the findBySourceRef key (Fix #3/#5)
  createdAt: string;
  updatedAt: string;
}

export interface CreateReturnSuggestionInput {
  id: string;
  taskId: string;
  serviceOrderId: string;
  serialNumber?: string | null;
  mac?: string | null;
  deviceType?: string | null;
  matchedAssetId?: string | null;
  /** Defaults to 'pending' when a match exists, otherwise the caller passes 'needs_review'. */
  status?: ReturnSuggestionStatus;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Factory with the staging defaults. `status` defaults to 'pending'; the staging
 * use case passes 'needs_review' explicitly when no installed asset matched.
 */
export function createReturnSuggestion(input: CreateReturnSuggestionInput): ReturnSuggestion {
  const now = new Date().toISOString();
  return {
    id: input.id,
    taskId: input.taskId,
    serviceOrderId: input.serviceOrderId,
    serialNumber: input.serialNumber ?? null,
    mac: input.mac ?? null,
    deviceType: input.deviceType ?? null,
    matchedAssetId: input.matchedAssetId ?? null,
    status: input.status ?? 'pending',
    resolution: null,
    confirmedMovementId: null,
    sourceRef: null,
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
  };
}

/**
 * Normaliza un serial/MAC para el match contra InventoryAsset, sobreviviendo el
 * drift IClass/OCR (#36 `normalizeResultCode` análogo): trim, uppercase, y strip de
 * todo lo que no sea alfanumérico (guiones, dos puntos, espacios internos). Un input
 * vacío o nulo → null (no hay con qué matchear). Determinístico — mismo origen para
 * el `sourceRef`, así un re-confirm computa exactamente la misma natural key.
 */
export function normalizeSerial(s: string | null | undefined): string | null {
  if (s == null) return null;
  const normalized = s.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  return normalized === '' ? null : normalized;
}
