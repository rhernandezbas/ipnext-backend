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
 * #47k / #64 / #72 — result of CancelTv (dar de baja TV completa).
 *   - `removed`: serviceIds successfully DELETEd in Gigared (add-ons con cupo liberable)
 *   - `failed`: serviceIds whose DELETE threw con un error BLOQUEANTE, con el upstream detail (retry idempotente)
 *   - `unremovable`: #67 — serviceIds que el CUA rechaza con 424 external-service-error
 *              "no se puede dar de baja" (el pack BASE "Gigared Play Full", verificado live 2026-06-12).
 *              Es un fallo CONOCIDO y NO bloqueante: el pack base no se libera por DELETE, lo recicla
 *              la renovación del CIC. NO cuenta para el 207 — el flujo sigue a renew. Informativo
 *              para el modal ("el pack base lo libera la renovación del CIC").
 *   - `ottDisabled`: whether the OTT disable succeeded (idempotent: "ya deshabilitada" = true)
 *   - `local`: 'synced' if the local TV ContractService reconcile succeeded, else 'failed'
 *   - `renew`: #64 — { oldCic, newCic } when the CIC renew succeeded, else null (best-effort).
 *              Renovar genera un CIC nuevo; la renovación recicla el cupo del pack base.
 *              Best-effort: un fallo de renew NO impide que el flag local se setee.
 *   - `localCancelled`: #72 — true si el flag local Client.tvCancelledAt fue seteado en esta corrida
 *                       (failed.length === 0 → teardown completo → el panel mostrará "no vinculado"
 *                       aunque el partner siga resolviendo por internal_id). false si failed.length > 0.
 *
 * Router maps (#74 — el OTT no cuenta cuando el renew tuvo éxito):
 *   renewSucceeded = renewAttempted && renew !== null
 *   207 when failed.length > 0 || local === 'failed' || (renewAttempted && renew === null)
 *               || (!ottDisabled && !renewSucceeded)
 *   200 otherwise.
 *   #74 — el renew ES la baja efectiva: resetea la cuenta y deja el CIC viejo inaccesible. Cuando
 *   renewSucceeded, un ottDisabled=false (paso OTT pre-renew sobre el CIC viejo) es un dato STALE
 *   y NO marca parcial. El !ottDisabled sólo cuenta cuando el renew no reseteó la cuenta.
 *
 * `renewAttempted` guards the anti-re-renew logic (#64 H1): it is true only when there was
 * something to tear down at the START of this run (services.length > 0 OR ott was 'enabled').
 * When false (account already peeled), renewCic is NOT called and the 207 criterion skips
 * renew checks to avoid a permanent 207 on an already-complete account.
 *
 * Anti-coining guard (#72): if the client already has tvCancelledAt set (localCancelled from a
 * previous run) the use case throws TvNotLinkedError immediately, WITHOUT calling the partner,
 * to prevent re-renewing/re-coining a CIC on retry.
 */
export interface CancelTvResult {
  removed: string[];
  failed: { id: string; detail: string }[];
  /** #67 — packs irremovibles por política del CUA (pack base). Informativo, NO bloquea el 207. */
  unremovable: { id: string; detail: string }[];
  ottDisabled: boolean;
  local: 'synced' | 'failed';
  renew: { oldCic: string; newCic: string } | null;
  /** #72 — true if the local TV-cancel flag (Client.tvCancelledAt) was set in this run. */
  localCancelled: boolean;
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
