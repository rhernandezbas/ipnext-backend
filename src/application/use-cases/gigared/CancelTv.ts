import type { GigaredPort } from '@domain/ports/GigaredPort';
import type { ContractServiceRepository } from '@domain/ports/ContractServiceRepository';
import type { ServiceCatalogRepository } from '@domain/ports/ServiceCatalogRepository';
import type { ClientTvCancellationRepository } from '@domain/ports/ClientTvCancellationRepository';
import type { CancelTvResult } from '@application/dto/gigared.dto';
import { ClientNotFoundError } from '@domain/errors';
import { ContractNotFoundError } from '@domain/errors/contractServices';
import { GigaredNotFoundError, GigaredUnavailableError, TvNotLinkedError } from '@domain/errors/gigared';
import { currentTvInternalId } from '@domain/gigared/tvIdentity';
import type { CustomerLookup, ContractLookup } from './lookups';
import { reconcileTvContractService } from './reconcileTvContractService';

/**
 * #67 — el pack BASE ("Gigared Play Full") es IRREMOVIBLE por política del CUA. Verificado LIVE
 * (2026-06-12, CIC 0006230159): DELETE del pack base → 424 external-service-error con detail
 * "El servicio seleccionado no se puede dar de baja". El adapter lo mapea a
 * GigaredUnavailableError('Gigared external service (CUA) error', detail). Discriminamos por el
 * DETAIL (no por el id, que puede cambiar): esta firma significa "este servicio no se da de baja
 * por DELETE — lo recicla la renovación del CIC". Un GigaredUnavailableError con OTRO detail (CUA
 * caído de verdad) NO matchea y sigue siendo un fallo bloqueante normal.
 *
 * #67 re-review (MEDIUM, hardening de cardinalidad): la firma del detail es NECESARIA pero NO
 * suficiente. Si el CUA usara la misma frase para rechazar un ADD-ON, derivarlo a `unremovable`
 * dejaría ese add-on vivo en el CIC viejo y la baja se reportaría "completa". Por eso esta firma
 * sólo identifica al pack base cuando matchea UN ÚNICO servicio del lote (cardinalidad 1). Si ≥2
 * servicios devuelven la firma, es AMBIGUO (el partner pudo renombrar el base) → NO asumimos cuál
 * es el irremovible: TODOS van a `failed` (conservador; el guard #64 bloquea renew y el retry
 * re-procesa). NO hardcodeamos el nombre "Gigared Play Full" — el partner puede renombrarlo;
 * la cardinalidad 1 es la única señal robusta. Ver la resolución de dos pasos en execute().
 */
function matchesUnremovableSignature(e: unknown): boolean {
  return (
    e instanceof GigaredUnavailableError &&
    typeof e.detail === 'string' &&
    /no se puede dar de baja/i.test(e.detail)
  );
}

/**
 * CancelTv (#47k / #72) — dar de baja TV por completo para un cliente.
 *
 * Guard order (pinned): customer 404 → anti-coining guard (tvCancelledAt ya seteado → TvNotLinkedError)
 *   → contract 404 (ANTES de tocar Gigared) → cuenta del cliente por use_internal_id; un 404 upstream
 *   (no vinculada) se mapea a TvNotLinkedError (router → 404 TV_NOT_LINKED).
 *
 * Luego, por cada servicio de la cuenta: DELETE en Gigared. Cada DELETE es independiente: si uno
 * falla, se registra y se sigue con el resto (nunca aborta el lote). #67 — el pack BASE no se
 * puede dar de baja por DELETE (el CUA responde 424 "no se puede dar de baja"): ese fallo CONOCIDO
 * va a `unremovable` (informativo), NO a `failed`: así failed.length queda en 0 y el guard #64 deja
 * correr renew — la renovación del CIC recicla el pack base. Cualquier otro fallo va a `failed` y
 * bloquea el renew (comportamiento #64).
 * Después, OTT disable (idempotente: el adapter ya tolera "ya deshabilitada" como éxito).
 * Por último, reconcile del ContractService TV: relee la cuenta y, si quedó vacía, INACTIVA el ítem
 * local (helper existente, H1).
 *
 * #64 — "RENOVAR CIC": tras los pasos anteriores, renueva el CIC (genera uno nuevo) SOLO si
 * renewAttempted && failed.length === 0 (ver re-review abajo). Best-effort para reciclar el cupo
 * del pack base (renew es lo que libera el pack base en el partner). Si falla → renew=null.
 * Ya NO se llama setInternalId(newCic, '') — el partner rechaza siempre el internal_id vacío (#72).
 * El estado "sin TV" se persiste LOCALMENTE (Client.tvCancelledAt). Cuando el teardown es exitoso
 * (failed.length === 0), se llama tvCancellation.markCancelled(customerId) → localCancelled = true.
 * Esto hace que el panel muestre "no vinculado" y bloquea el próximo retry (anti-coining).
 *
 * #72 — Guard anti-coining: si tvCancellation.isCancelled(customerId) es true AL INICIO de
 * execute(), se lanza TvNotLinkedError INMEDIATAMENTE, sin llamar al partner. El flag localCancelled
 * del run anterior garantiza que un retry no acuñe otro CIC.
 *
 * #64 H1 — Guard anti re-renew: `renewAttempted` se computa AL INICIO (ANTES del loop) como
 *   (account.services.length > 0) || (account.ott?.status === 'enabled').
 *   Solo se llama a renewCic cuando renewAttempted es true. Un retry sobre una cuenta ya pelada
 *   (servicios vacíos + OTT off) llegaría aquí sólo si getAccountByInternalId no lanzó 404;
 *   en ese caso renewAttempted=false → no renueva → la respuesta es 200 en lugar de 207 permanente.
 *
 * #64 re-review (BLOQUEANTE) — Guard anti-desmontaje-incompleto: renew corre SOLO si
 *   failed.length === 0 (todos los removes de packs OK). Con failed > 0 NO se renueva: el renew
 *   generaría un CIC nuevo, lo que dificultaría resolver la cuenta en un retry. Preservando el
 *   vínculo (sin renew) la cuenta sigue resoluble: el "Reintentar baja" re-procesa los packs
 *   pendientes y, ya sin fallos, recién entonces renueva.
 *
 * Shape: { removed, failed, unremovable, ottDisabled, local, renew, localCancelled, renewAttempted }.
 * #74 — El router responde 207 si failed.length>0 || local==='failed' ||
 * (renewAttempted && renew===null) || (!ottDisabled && !renewSucceeded), donde
 * renewSucceeded = renewAttempted && renew!==null; si no 200. El OTT (paso pre-renew sobre el CIC
 * viejo) NO cuenta para el veredicto cuando el renew tuvo éxito: el renew resetea la cuenta y deja
 * el CIC viejo inaccesible, así que un ottDisabled=false es stale. Con failed>0 ya es 207.
 */
export class CancelTv {
  constructor(
    private readonly gigared: GigaredPort,
    private readonly csRepo: ContractServiceRepository,
    private readonly catalogRepo: ServiceCatalogRepository,
    private readonly contractLookup: ContractLookup,
    private readonly customerLookup: CustomerLookup,
    private readonly tvCancellation?: ClientTvCancellationRepository,
  ) {}

  async execute(customerId: string, { contractId }: { contractId: string }): Promise<CancelTvResult> {
    const customer = await this.customerLookup.findById(customerId);
    if (!customer) throw new ClientNotFoundError(customerId);

    // #72 — Guard anti-coining: si la TV ya fue dada de baja localmente, el flag tvCancelledAt
    // está seteado → lanzamos TvNotLinkedError inmediatamente SIN llamar al partner.
    // Esto evita acuñar otro CIC en un retry (re-coining). El flag es el guard honesto.
    if (this.tvCancellation && await this.tvCancellation.isCancelled(customerId)) {
      throw new TvNotLinkedError(customerId);
    }

    // #47k HIGH: el contrato debe PERTENECER al customer. Un contractId de otro cliente
    // se trata como inexistente (404) para no filtrar la existencia del contrato ajeno ni
    // permitir un write cross-customer en una acción destructiva.
    const contract = await this.contractLookup.findById(contractId);
    if (!contract || contract.clientId !== customerId) throw new ContractNotFoundError(contractId);

    // #81 — internal_id VIGENTE de la cuenta de TV del cliente (seq=0 → id pelado, back-compat).
    // La baja opera SIEMPRE sobre la cuenta vigente, no sobre los internal_ids viejos (quemados).
    const internalId = currentTvInternalId(customerId, customer.tvActivationSeq ?? 0);

    // Cuenta del cliente — un 404 upstream significa "no vinculada".
    let account;
    try {
      account = await this.gigared.getAccountByInternalId(internalId);
    } catch (e) {
      if (e instanceof GigaredNotFoundError) throw new TvNotLinkedError(customerId);
      throw e;
    }

    // #64 H1 — Guard anti re-renew: capturar ANTES de mutar la cuenta.
    // Solo hay algo que renovar si había servicios o el OTT estaba habilitado al inicio de esta corrida.
    const renewAttempted = account.services.length > 0 || account.ott?.status === 'enabled';

    // DELETE por servicio. Cada uno es independiente: un fallo nunca aborta el lote.
    // #67 — el pack BASE no se puede dar de baja por DELETE (el CUA responde 424 "no se puede dar
    // de baja"). Ese fallo CONOCIDO va a `unremovable` (informativo), NO a `failed`: así failed.length
    // queda en 0 y el guard #64 deja correr renew — la renovación del CIC recicla el pack base.
    // Cualquier OTRO fallo (CUA caído, otro error) sí va a `failed` y bloquea el renew (comportamiento #64).
    const removed: string[] = [];
    const failed: { id: string; detail: string }[] = [];
    // #67 re-review (MEDIUM): primero recolectamos los CANDIDATOS a irremovible (DELETEs que
    // matchearon la firma). La clasificación final unremovable-vs-failed depende de la CARDINALIDAD,
    // así que no se puede decidir dentro del loop — se resuelve después.
    const unremovableCandidates: { id: string; detail: string }[] = [];
    for (const service of account.services) {
      try {
        await this.gigared.removeService(internalId, service.id);
        removed.push(service.id);
      } catch (e) {
        const detail = e instanceof GigaredUnavailableError && e.detail ? e.detail : (e as Error).message;
        if (matchesUnremovableSignature(e)) {
          unremovableCandidates.push({ id: service.id, detail });
        } else {
          failed.push({ id: service.id, detail });
        }
      }
    }

    // #67 re-review (MEDIUM): resolver la firma "no se puede dar de baja" por CARDINALIDAD.
    //   - exactamente 1 candidato → es el pack BASE irremovible → `unremovable` (no bloquea el renew).
    //   - ≥2 candidatos → AMBIGUO (no sabemos cuál es el base) → todos a `failed`, conservador.
    // El warn deja rastro para revisar si el CUA cambió de comportamiento (nombre del base, etc.).
    const unremovable: { id: string; detail: string }[] = [];
    if (unremovableCandidates.length === 1) {
      const c = unremovableCandidates[0]!;
      console.warn('[gigared] unremovable inesperado', { customerId, serviceId: c.id, detail: c.detail });
      unremovable.push(c);
    } else if (unremovableCandidates.length > 1) {
      console.warn('[gigared] unremovable inesperado', {
        customerId,
        candidates: unremovableCandidates.map((c) => c.id),
        detail: 'cardinalidad >1: la firma matcheó múltiples servicios → todos a failed (conservador)',
      });
      failed.push(...unremovableCandidates);
    }

    // OTT disable — idempotente (el adapter tolera "ya deshabilitada"). Se intenta SIEMPRE,
    // aun con fallos parciales en los DELETE. Un fallo acá no rompe la baja: ottDisabled=false.
    let ottDisabled = false;
    try {
      await this.gigared.setOtt(internalId, false);
      ottDisabled = true;
    } catch {
      ottDisabled = false;
    }

    // Reconcile local: relee la cuenta; si quedó vacía, inactiva el ítem TV (H1, nunca borra).
    // #67 re-review (CRITICAL): el pack base irremovible SIGUE en la cuenta al releer (su DELETE
    // lanzó), pero NO debe contar como "servicio vivo" para el reconcile — si contara, la rama
    // "services present" reactivaría la fila TV con el CIC viejo + credenciales intactas y el
    // renew posterior la dejaría irreparable. Excluimos los ids derivados a `unremovable`
    // para que una cuenta con SÓLO el base se reconcilie como "vacía" → inactiva + limpia (#65 M6).
    let local: 'synced' | 'failed' = 'synced';
    try {
      await reconcileTvContractService({
        gigared: this.gigared,
        csRepo: this.csRepo,
        catalogRepo: this.catalogRepo,
        customerId,
        contractId,
        internalId,
        // #65 M6 — la baja LIMPIA las credenciales de la fila al inactivarla (sin zombies).
        clearCredentialsOnInactive: true,
        // #67 re-review — descontar el pack base irremovible de la decisión vacía/no-vacía.
        excludeServiceIds: unremovable.map((u) => u.id),
      });
    } catch {
      local = 'failed';
    }

    // #64 — RENOVAR CIC. Best-effort, DESPUÉS de packs/OTT/reconcile.
    // El renew genera un CIC nuevo; el partner reasigna el pack base al CIC nuevo, reciclando el cupo.
    // Ya NO se llama setInternalId(newCic,'') — el partner siempre lo rechaza (HTTP 400, #72).
    // El estado "sin TV" se persiste LOCALMENTE con tvCancellation.markCancelled() (ver abajo).
    //
    // H1 — Guard anti re-renew: solo ejecutar cuando renewAttempted=true. Si la cuenta ya estaba
    // pelada (services:[], ott disabled) al inicio de esta corrida, no hay nada que renovar; no
    // llamar a renewCic evita generar un tercer CIC en un retry sobre una baja parcialmente hecha.
    //
    // #64 re-review (BLOQUEANTE) — Guard anti-desmontaje-incompleto: renew SOLO si
    // failed.length === 0. Si ALGÚN remove de pack falló, el renew NO debe correr: el renew
    // genera un CIC nuevo y el retry del 207 daría 404 (partner resuelve por CIC nuevo que
    // tal vez tenga un internal_id diferente). Con failed>0 NO renovamos: la cuenta sigue
    // resoluble por internal_id, así el "Reintentar baja" re-procesa los packs pendientes.
    let renew: { oldCic: string; newCic: string } | null = null;
    if (renewAttempted && failed.length === 0) {
      try {
        renew = await this.gigared.renewCic(internalId);
      } catch {
        renew = null;
      }
    }

    // #72 — Flag local: si el teardown fue exitoso (failed.length === 0), marcar el cliente como
    // "TV dada de baja localmente". Esto hace que el panel muestre "no vinculado" y que el próximo
    // retry lance TvNotLinkedError (anti-coining guard). Best-effort en relación al renew: aunque
    // el renew falle (quota recycling), el estado honesto de la baja es que los packs se quitaron,
    // así que el flag se setea igual.
    let localCancelled = false;
    if (failed.length === 0 && this.tvCancellation) {
      await this.tvCancellation.markCancelled(customerId);
      localCancelled = true;
    }

    // #5B — cic of the account at the time of this baja (captured before any mutation).
    // Forwarded by CancelTvJobRunner to the baja TvActivationEvent record.
    const cic = account.cic;

    return { removed, failed, unremovable, ottDisabled, local, renew, localCancelled, renewAttempted, cic };
  }
}
