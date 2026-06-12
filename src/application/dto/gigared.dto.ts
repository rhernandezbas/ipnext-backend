import { z } from 'zod';

/**
 * Gigared TV DTOs (#47).
 *
 * The full apiKey JAMÁS sale en respuestas — GigaredConfigDTO exposes only `configured`
 * + `apiKeyLast4`. The masking is done in GetGigaredConfig/UpdateGigaredConfig use cases.
 */

export interface GigaredConfigDTO {
  configured: boolean;
  apiKeyLast4: string | null;
  baseUrl: string;
  enabled: boolean;
  updatedAt: string | null;
}

/**
 * Result of AddTvService / RemoveTvService.
 * `gigared: 'ok'` always (the upstream call succeeded before we touch local state).
 * `local: 'failed'` → router responds 207 TV_LOCAL_SYNC_FAILED (retry = re-POST, idempotent).
 */
export interface AddTvServiceResult {
  gigared: 'ok';
  local: 'ok' | 'failed';
  contractServiceId?: string;
  localError?: string;
}

export type RemoveTvServiceResult = AddTvServiceResult;

/**
 * #47k / #64 — result of CancelTv (dar de baja TV completa, "RENOVAR CIC").
 *   - `removed`: serviceIds successfully DELETEd in Gigared (base incluido — libera cupo)
 *   - `failed`: serviceIds whose DELETE threw, with the upstream detail (retry idempotente)
 *   - `ottDisabled`: whether the OTT disable succeeded (idempotent: "ya deshabilitada" = true)
 *   - `local`: 'synced' if the local TV ContractService reconcile succeeded, else 'failed'
 *   - `renew`: #64 — { oldCic, newCic } when the CIC renew succeeded, else null (best-effort).
 *              Renovar genera un CIC nuevo; el internal_id se reasigna a ese CIC en el partner.
 *   - `unlinked`: #64 — true if internal_id was cleared on the NEW cic (setInternalId(newCic, '')),
 *                 dejando al cliente "como si no tuviera TV" (getAccountByInternalId 404 después).
 *                 false si el renew falló (no hay newCic) o si el partner rechazó el internal_id vacío.
 *
 * Router maps:
 *   200 when failed.length === 0 && local === 'synced' && ottDisabled && (!renewAttempted || (renew !== null && unlinked))
 *   207 otherwise (parcial, retry idempotente).
 *
 * `renewAttempted` guards the anti-re-renew logic (#64 H1): it is true only when there was
 * something to tear down at the START of this run (services.length > 0 OR ott was 'enabled').
 * When false (account already peeled), renewCic is NOT called and the 207 criterion skips
 * renew/unlink checks to avoid a permanent 207 on an already-complete account.
 */
export interface CancelTvResult {
  removed: string[];
  failed: { id: string; detail: string }[];
  ottDisabled: boolean;
  local: 'synced' | 'failed';
  renew: { oldCic: string; newCic: string } | null;
  unlinked: boolean;
  /** #64 H1 — true if this run had something to tear down at start; false on a peeled-account no-op. */
  renewAttempted: boolean;
}

/**
 * PUT /api/gigared/config body. Every field optional:
 *   - apiKey omitted = no change; '' = clear the key (unconfigured)
 *   - baseUrl must be a valid URL when present
 *   - enabled toggles the `gigared-integration` feature flag
 */
export const updateGigaredConfigSchema = z.object({
  apiKey: z.string().optional(),
  baseUrl: z.string().url().optional(),
  enabled: z.boolean().optional(),
});

export type UpdateGigaredConfigBody = z.infer<typeof updateGigaredConfigSchema>;
