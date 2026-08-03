import type { GetPortalTvStatus } from '@application/use-cases/portal/GetPortalTvStatus';
import type { ChangeTvPassword } from '@application/use-cases/gigared/ChangeTvPassword';
import { TvNotLinkedError } from '@domain/errors/gigared';

/**
 * EPIC v3 fix wave W2 — `PUT /api/portal/tv/:contractId/password`.
 *
 * `ChangeTvPassword` (#65) es la superficie de STAFF: su guard order solo exige
 * ownership del contrato, porque el operador puede tocar la cuenta TV del
 * cliente desde cualquiera de sus contratos. En el PORTAL eso era un hueco: la
 * cuenta Gigared es per-customer, así que con un contrato PROPIO pero SIN TV el
 * PATCH salía igual — y el snapshot local del contrato que SÍ tiene TV quedaba
 * stale en silencio (M5 persiste sobre el `contractId` del request, no sobre el
 * del slot real).
 *
 * Este wrapper existe porque ahora hay LÓGICA portal propia (ya no es
 * delegación pura, el motivo por el que antes la ruta llamaba a
 * `ChangeTvPassword` directo): exige el slot TV ACTIVO del CONTRATO del param
 * ANTES de tocar Gigared, reusando el MISMO resolver del GET
 * (`GetPortalTvStatus`) — una sola fuente de verdad de `hasTv`, jamás una
 * segunda implementación del concepto.
 *
 * Guard order del portal:
 *   1. ownership + slot TV activo (GetPortalTvStatus) →
 *      ContractNotFoundError (404 indistinguible) / TvNotLinkedError (404
 *      TV_NOT_LINKED, consistente con el GET) — Gigared JAMÁS tocado.
 *   2. delega en ChangeTvPassword (guard order #65 pineado: policy CUA,
 *      re-check ownership, anti-IDOR H1, PATCH, persistencia M5 best-effort).
 *
 * El resultado del delegate ({password, persisted}) NO se re-expone: la app
 * solo necesita saber que se aplicó (superficie staff, lección leak #65/H3).
 */
export class ChangePortalTvPassword {
  constructor(
    private readonly getPortalTvStatus: Pick<GetPortalTvStatus, 'execute'>,
    private readonly changeTvPassword: Pick<ChangeTvPassword, 'execute'>,
  ) {}

  async execute(clientId: string, input: { contractId: string; password: string }): Promise<void> {
    // Ownership (ContractNotFoundError) + hasTv del CONTRATO del param — el
    // mismo camino que ve el cliente en el GET.
    const status = await this.getPortalTvStatus.execute(clientId, input.contractId);
    if (!status.hasTv) throw new TvNotLinkedError(clientId);

    await this.changeTvPassword.execute(clientId, input);
  }
}
