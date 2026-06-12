import type { GigaredPort } from '@domain/ports/GigaredPort';
import type { ContractServiceRepository } from '@domain/ports/ContractServiceRepository';
import type { ServiceCatalogRepository } from '@domain/ports/ServiceCatalogRepository';
import type { CancelTvResult } from '@application/dto/gigared.dto';
import { ClientNotFoundError } from '@domain/errors';
import { ContractNotFoundError } from '@domain/errors/contractServices';
import { GigaredNotFoundError, TvNotLinkedError } from '@domain/errors/gigared';
import type { CustomerLookup, ContractLookup } from './lookups';
import { reconcileTvContractService } from './reconcileTvContractService';

/**
 * CancelTv (#47k) — dar de baja TV por completo para un cliente.
 *
 * Guard order (pinned): customer 404 → contract 404 (ANTES de tocar Gigared) →
 *   cuenta del cliente por use_internal_id; un 404 upstream (no vinculada) se mapea a
 *   TvNotLinkedError (router → 404 TV_NOT_LINKED).
 *
 * Luego, por cada servicio de la cuenta: DELETE en Gigared (incluido el base — libera
 * cupo). Cada DELETE es independiente: si uno falla, se registra en `failed` y se sigue
 * con el resto (nunca aborta el lote). Después, OTT disable (idempotente: el adapter ya
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

    // DELETE por servicio (base incluido — libera cupo). Cada uno es independiente.
    const removed: string[] = [];
    const failed: { id: string; detail: string }[] = [];
    for (const service of account.services) {
      try {
        await this.gigared.removeService(customerId, service.id);
        removed.push(service.id);
      } catch (e) {
        failed.push({ id: service.id, detail: (e as Error).message });
      }
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

    return { removed, failed, ottDisabled, local, renew, unlinked, renewAttempted };
  }
}
