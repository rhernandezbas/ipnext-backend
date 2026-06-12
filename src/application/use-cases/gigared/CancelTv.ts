import type { GigaredPort } from '@domain/ports/GigaredPort';
import type { ContractServiceRepository } from '@domain/ports/ContractServiceRepository';
import type { ServiceCatalogRepository } from '@domain/ports/ServiceCatalogRepository';
import type { CancelTvResult } from '@application/dto/gigared.dto';
import { ClientNotFoundError } from '@domain/errors';
import { ContractNotFoundError } from '@domain/errors/contractServices';
import { GigaredNotFoundError, GigaredUnavailableError, TvNotLinkedError } from '@domain/errors/gigared';
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
 * es el irremovible: TODOS van a `failed` (conservador; el guard #64 bloquea renew/unlink y el
 * retry re-procesa). NO hardcodeamos el nombre "Gigared Play Full" — el partner puede renombrarlo;
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
 * CancelTv (#47k) — dar de baja TV por completo para un cliente.
 *
 * Guard order (pinned): customer 404 → contract 404 (ANTES de tocar Gigared) →
 *   cuenta del cliente por use_internal_id; un 404 upstream (no vinculada) se mapea a
 *   TvNotLinkedError (router → 404 TV_NOT_LINKED).
 *
 * Luego, por cada servicio de la cuenta: DELETE en Gigared. Cada DELETE es independiente: si uno
 * falla, se registra y se sigue con el resto (nunca aborta el lote). #67 — el pack BASE no se
 * puede dar de baja por DELETE (424 "no se puede dar de baja"): ese fallo CONOCIDO va a
 * `unremovable` (informativo), NO a `failed`, así no bloquea el renew (la renovación del CIC
 * recicla el pack base). Cualquier otro fallo va a `failed` y bloquea renew+unlink (guard #64).
 * Después, OTT disable (idempotente: el adapter ya
 * tolera "ya deshabilitada" como éxito). Por último, reconcile del ContractService TV:
 * relee la cuenta y, si quedó vacía, INACTIVA el ítem local (helper existente, H1).
 *
 * #64 — "RENOVAR CIC": tras los pasos anteriores, renueva el CIC (genera uno nuevo) y
 * desvincula el internal_id del NUEVO CIC, de modo que el cliente quede "como si no tuviera
 * TV" (getAccountByInternalId(customerId) → 404 después → panel NO vinculado). Ambos pasos son
 * best-effort y se ejecutan DESPUÉS de packs+OTT+reconcile, SOLO si renewAttempted && failed.length===0
 * (ver re-review abajo):
 *   - renewCic(customerId) → { oldCic, newCic }. Si falla → renew=null, NO se intenta el unlink
 *     (sin newCic no sabemos qué CIC limpiar).
 *   - setInternalId(newCic, '') desata el vínculo en el partner → unlinked=true. Si el partner
 *     rechaza el internal_id vacío → unlinked=false (renew ya quedó hecho).
 *   NOTA: no existe un dato LOCAL Client↔CIC que limpiar — el vínculo vive sólo en Gigared como
 *   account.internal_id. El ítem TV local se inactiva en el reconcile. Si en el futuro se
 *   re-vincula, el PATCH internal_id (LinkCustomerToCic) pisa el vínculo.
 *
 * #64 H1 — Guard anti re-renew: `renewAttempted` se computa AL INICIO (ANTES del loop) como
 *   (account.services.length > 0) || (account.ott?.status === 'enabled').
 *   Solo se llama a renewCic cuando renewAttempted es true. Un retry sobre una cuenta ya pelada
 *   (servicios vacíos + OTT off) llegaría aquí solo si getAccountByInternalId no lanzó 404;
 *   en ese caso renewAttempted=false → no renueva → la respuesta es 200 en lugar de 207 permanente.
 *   Post-unlink exitoso la cuenta desaparece de Gigared (404), así que el siguiente retry
 *   lanzará TvNotLinkedError ANTES de llegar acá.
 *
 * #64 re-review (BLOQUEANTE) — Guard anti-desmontaje-incompleto: renew+unlink corren SOLO si
 *   failed.length === 0 (todos los removes de packs OK). Con failed > 0 NI renew NI unlink: el
 *   renew movería el internal_id a un CIC nuevo y el unlink lo borraría, dejando la cuenta
 *   IRRESOLUBLE por internal_id (404) mientras packs fallidos siguen activos (cupo consumido) y
 *   el ítem local cuelga inactivo — el retry del 207 daría 404 y enmascararía una baja a medias.
 *   Preservando el vínculo (sin renew/unlink) la cuenta sigue resoluble: el "Reintentar baja"
 *   re-procesa los packs pendientes y, ya sin fallos, recién entonces renueva y desvincula.
 *
 * #67 re-review (LIMITACIÓN CONOCIDA — retry post renew-OK/unlink-FAIL): cuando la cuenta queda con
 *   SÓLO el pack base irremovible y el renew se hace pero el unlink falla (207), un retry NO puede
 *   distinguir de forma robusta "primera baja" de "re-intento": en ambos casos lee una cuenta con
 *   sólo el base (+ OTT off) y `renew` del run previo no es visible (no hay dato LOCAL Client↔CIC).
 *   Decisión del arquitecto: en ese caso RENOVAR IGUAL (la primera baja legítima necesita el renew
 *   para liberar el base; el base no se libera sin renew). Esto acepta que un retry sobre el caso
 *   solo-base+OTT-off pueda acuñar otro CIC — edge acotado porque el usuario controla los clicks y
 *   el 207 muestra qué falló. NO se complica el flujo para cubrirlo; el warn de [gigared] unremovable
 *   deja rastro. Si en el futuro hace falta, la solución correcta es persistir el CIC localmente.
 *
 * Shape: { removed, failed, ottDisabled, local, renew, unlinked, renewAttempted }.
 * El router responde 200 si failed.length===0 && local==='synced' && ottDisabled &&
 * (!renewAttempted || (renew!==null && unlinked)); si no 207. Con failed>0 ya es 207 por el
 * primer criterio, así que el retry queda habilitado.
 */
export class CancelTv {
  constructor(
    private readonly gigared: GigaredPort,
    private readonly csRepo: ContractServiceRepository,
    private readonly catalogRepo: ServiceCatalogRepository,
    private readonly contractLookup: ContractLookup,
    private readonly customerLookup: CustomerLookup,
  ) {}

  async execute(customerId: string, { contractId }: { contractId: string }): Promise<CancelTvResult> {
    const customer = await this.customerLookup.findById(customerId);
    if (!customer) throw new ClientNotFoundError(customerId);

    // #47k HIGH: el contrato debe PERTENECER al customer. Un contractId de otro cliente
    // se trata como inexistente (404) para no filtrar la existencia del contrato ajeno ni
    // permitir un write cross-customer en una acción destructiva.
    const contract = await this.contractLookup.findById(contractId);
    if (!contract || contract.clientId !== customerId) throw new ContractNotFoundError(contractId);

    // Cuenta del cliente — un 404 upstream significa "no vinculada".
    let account;
    try {
      account = await this.gigared.getAccountByInternalId(customerId);
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
    // queda en 0 y el guard #64 deja correr renew+unlink — la renovación del CIC recicla el pack base.
    // Cualquier OTRO fallo (CUA caído, otro error) sí va a `failed` y bloquea el renew (comportamiento #64).
    const removed: string[] = [];
    const failed: { id: string; detail: string }[] = [];
    // #67 re-review (MEDIUM): primero recolectamos los CANDIDATOS a irremovible (DELETEs que
    // matchearon la firma). La clasificación final unremovable-vs-failed depende de la CARDINALIDAD,
    // así que no se puede decidir dentro del loop — se resuelve después.
    const unremovableCandidates: { id: string; detail: string }[] = [];
    for (const service of account.services) {
      try {
        await this.gigared.removeService(customerId, service.id);
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
      await this.gigared.setOtt(customerId, false);
      ottDisabled = true;
    } catch {
      ottDisabled = false;
    }

    // Reconcile local: relee la cuenta; si quedó vacía, inactiva el ítem TV (H1, nunca borra).
    // #67 re-review (CRITICAL): el pack base irremovible SIGUE en la cuenta al releer (su DELETE
    // lanzó), pero NO debe contar como "servicio vivo" para el reconcile — si contara, la rama
    // "services present" reactivaría la fila TV con el CIC viejo + credenciales intactas y el
    // renew+unlink posterior la dejaría irreparable. Excluimos los ids derivados a `unremovable`
    // para que una cuenta con SÓLO el base se reconcilie como "vacía" → inactiva + limpia (#65 M6).
    let local: 'synced' | 'failed' = 'synced';
    try {
      await reconcileTvContractService({
        gigared: this.gigared,
        csRepo: this.csRepo,
        catalogRepo: this.catalogRepo,
        customerId,
        contractId,
        // #65 M6 — la baja LIMPIA las credenciales de la fila al inactivarla (sin zombies).
        clearCredentialsOnInactive: true,
        // #67 re-review — descontar el pack base irremovible de la decisión vacía/no-vacía.
        excludeServiceIds: unremovable.map((u) => u.id),
      });
    } catch {
      local = 'failed';
    }

    // #64 — RENOVAR CIC + desvincular. Best-effort, DESPUÉS de packs/OTT/reconcile.
    // El renew genera un CIC nuevo; el partner reasigna nuestro internal_id a ese CIC, así que
    // sin el unlink el cliente seguiría apareciendo vinculado. Limpiamos el internal_id del
    // nuevo CIC para que getAccountByInternalId(customerId) responda 404 ("como si no tuviera TV").
    //
    // H1 — Guard anti re-renew: solo ejecutar cuando renewAttempted=true. Si la cuenta ya estaba
    // pelada (services:[], ott disabled) al inicio de esta corrida, no hay nada que renovar; no
    // llamar a renewCic evita generar un tercer CIC en un retry sobre una baja parcialmente hecha.
    //
    // #64 re-review (BLOQUEANTE) — Guard anti-desmontaje-incompleto: renew+unlink SOLO si
    // failed.length === 0. Si ALGÚN remove de pack falló, el renew NO debe correr: el renew
    // genera un CIC nuevo, el partner mueve el internal_id a ese CIC y el unlink lo borra,
    // dejando la cuenta IRRESOLUBLE por internal_id (404). Pero los packs fallidos siguen
    // activos consumiendo cupo, y el ítem local ya quedó inactivado/colgado. El retry del 207
    // daría 404 (cuenta desvinculada) enmascarando una baja a medias. Con failed>0 NO renovamos
    // ni desvinculamos: la cuenta sigue resoluble por internal_id, así el "Reintentar baja"
    // re-procesa los packs pendientes y, ya sin fallos, recién entonces renueva y desvincula.
    let renew: { oldCic: string; newCic: string } | null = null;
    let unlinked = false;
    if (renewAttempted && failed.length === 0) {
      try {
        renew = await this.gigared.renewCic(customerId);
      } catch {
        renew = null;
      }
      if (renew) {
        try {
          await this.gigared.setInternalId(renew.newCic, '');
          unlinked = true;
        } catch {
          unlinked = false;
        }
      }
    }

    return { removed, failed, unremovable, ottDisabled, local, renew, unlinked, renewAttempted };
  }
}
