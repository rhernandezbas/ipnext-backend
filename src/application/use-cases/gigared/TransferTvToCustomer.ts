import type { GigaredPort, GigaredAccount } from '@domain/ports/GigaredPort';
import type { ContractServiceRepository } from '@domain/ports/ContractServiceRepository';
import type { ContractServiceView } from '@domain/entities/contract-service';
import type { ServiceCatalogRepository } from '@domain/ports/ServiceCatalogRepository';
import type { ClientTvCancellationRepository } from '@domain/ports/ClientTvCancellationRepository';
import type { ContractServiceEventRepository } from '@domain/ports/ContractServiceEventRepository';
import type { TvActivationEventRepository } from '@domain/ports/TvActivationEventRepository';
import { ClientNotFoundError } from '@domain/errors';
import { ContractNotFoundError } from '@domain/errors/contractServices';
import {
  GigaredNotFoundError,
  GigaredRejectedError,
  TvAlreadyLinkedError,
  TvCatalogMissingError,
  TvNotLinkedError,
} from '@domain/errors/gigared';
import { currentTvInternalId } from '@domain/gigared/tvIdentity';
import type { CustomerLookup, ContractLookup } from './lookups';
import {
  reconcileTvContractService,
  GIGARED_NOTES_PREFIX,
  isGigaredManaged,
  cicFromNotes,
} from './reconcileTvContractService';

export interface TransferTvInput {
  targetCustomerId: string;
  targetContractId: string;
  /**
   * Contrato origen del slot TV. Opcional: si falta, el slot se resuelve por el CIC grabado en
   * las notes de la fila managed ("CIC {cic} · …") vía findActiveByCatalogAndNotesPrefix.
   * Fix wave MEDIUM-3: si viene, se VALIDA (existe y pertenece al cliente ORIGEN — espejo del
   * guard 3; si no → ContractNotFoundError 404 sin leak, ANTES de tocar Gigared).
   */
  sourceContractId?: string;
  actorId?: string | null;
  actorName?: string;
}

export interface TransferTvResult {
  /** CIC de la cuenta transferida (capturado del origen ANTES de mutar nada). */
  cic: string;
  /** Severing local del origen (tvCancelledAt). false → retry direccionado (207). */
  severed: boolean;
  /**
   * Fix wave MEDIUM-2 — clearCancelled(destino): false = el flag de baja local del destino no se
   * pudo limpiar (el destino seguiría mostrándose "sin TV"). Suma a la condición de 207.
   */
  targetCleared: boolean;
  /** Slot TV local del contrato origen: inactivado + credenciales limpias. */
  localSource: 'synced' | 'failed';
  /** Slot TV local del contrato destino: reconciliado con la cuenta del partner. */
  localTarget: 'synced' | 'failed';
}

/**
 * TransferTvToCustomer (service-transfer, EPIC Titularidad F1) — transfiere la cuenta de TV (CIC)
 * del cliente origen al destino SIN baja y SIN perder la identidad del servicio (caso Martino).
 *
 * Hechos F0 verificados EN VIVO (2026-07-10) que gobiernan este flujo:
 *  - El CUA NO pisa el internal_id: setInternalId(cic, nuevoId) devuelve 200 pero AGREGA UN ALIAS
 *    (append-only): ambos ids resuelven al CIC y el campo internal_id del payload muestra el
 *    PRIMERO para siempre. Por eso el alias se VERIFICA re-leyendo por el internal_id destino y
 *    chequeando account.cic === cic; si no tomó → GigaredRejectedError SIN tocar estado local.
 *  - El severing del origen es LOCAL: tvCancellation.markCancelled(source). JAMÁS se llama
 *    CancelTv/removeService/setOtt/renewCic en este flujo (TV-2): ese teardown destruiría la
 *    cuenta que ahora usa el destino.
 *  - El slot TV local del ORIGEN se inactiva DIRECTO vía csRepo (misma mecánica que la rama
 *    "cuenta vacía" de reconcileTvContractService: inactivar + limpiar credenciales, H1/M6,
 *    solo filas managed H2). El reconcile account-driven NO sirve para el origen: su internal_id
 *    sigue resolviendo por el alias, así que la cuenta nunca se ve "vacía".
 *
 * Guard order (fix wave HIGH-1 — RESUME de parciales; el alias append-only obliga a resolver
 * AMBOS lados en el partner ANTES de decidir bloqueo-vs-resume):
 *   1. source customer existe                      → ClientNotFoundError
 *   2. target customer existe                      → ClientNotFoundError
 *   2b. target ≠ source (fix wave 2 FIX-2)         → TvAlreadyLinkedError (409). A→A no es una
 *       transferencia: el destino YA es el dueño. Espejo del guard 3 de TransferPppoe (destino
 *       == contrato actual → 409 conflicto, PppoeAlreadyAssociatedError) — se eligió 409 y no
 *       400 por consistencia con ese precedente. Corre ANTES de cualquier llamada al partner
 *       (cic aún desconocido → TvAlreadyLinkedError con cic ''). Sin este guard, A→A resolvía
 *       ambos lados al MISMO cic y entraba en modo resume (mark+clear del flag propio).
 *   3. targetContract existe Y pertenece al target → ContractNotFoundError (404 sin leak,
 *      ANTES de tocar Gigared — #47k)
 *   3b. sourceContractId (si vino) existe Y pertenece al ORIGEN → ContractNotFoundError
 *       (MEDIUM-3, espejo del guard 3 — también ANTES de tocar Gigared)
 *   4. la cuenta ORIGEN resuelve por currentTvInternalId(source, seq). 404 upstream →
 *      TvNotLinkedError SIEMPRE (el alias es append-only: un transfer previo jamás des-resuelve
 *      el origen, así que "no resuelve" = nunca hubo TV acá). Captura el cic.
 *   5. se resuelve el DESTINO por su internal_id vigente:
 *      - 404 → destino libre: transferencia NUEVA.
 *      - resuelve al MISMO cic → candidato a **MODO RESUME**, sujeto al guard 5b. Aceptado, se
 *        saltean el PATCH y el verify y se RE-EJECUTAN los pasos 3-7 (idempotentes).
 *      - resuelve a OTRO cic → TvAlreadyLinkedError (409): doble vínculo irreversible.
 *   5b. cross-check LOCAL de ownership, INCONDICIONAL (fix wave 3; nació como fix wave 2 FIX-1
 *       solo para el resume) — **el ownership local manda sobre el estado upstream (F0)**: el
 *       alias del CUA es append-only PARA SIEMPRE, así que "el destino resuelve al mismo cic"
 *       puede ser el residuo de un parcial VIEJO aunque la cuenta se haya movido a un TERCERO
 *       después (A→B parcial 207 → A→C completa → replay del POST A→B); y un destino FRESCO
 *       (404 upstream) tampoco prueba nada — tras un A→C parcial con severed:false, el POST A→B
 *       robaba la fila ACTIVA de C por el camino no-resume. La verdad de ownership son las filas
 *       ContractService managed ACTIVAS (+ flags tvCancelledAt), jamás el estado upstream. Si
 *       alguna fila managed ACTIVA con este cic EXACTO pertenece a un cliente que NO es ni el
 *       origen ni el destino → TvAlreadyLinkedError (409) con el customerId del dueño local
 *       vigente, CERO mutaciones — corre en AMBOS caminos, ANTES de setInternalId. Solo un
 *       estado local consistente con "transferencia origen→destino" habilita seguir.
 *   6. isCancelled(origen) solo bloquea (TvNotLinkedError) cuando NO estamos en modo resume:
 *      en un retry post-parcial el severing del intento anterior pudo haber corrido y el retry
 *      no debe morirse en 404.
 *
 * Pasos (partner primero, local después; la op partner NUNCA se revierte — espejo D7):
 *   1. setInternalId(cic, targetInternalId)  — crea el alias. (Salteado en resume.)
 *   2. VERIFY del alias (releer por targetInternalId; 404 o cic distinto → GigaredRejectedError,
 *      CERO efectos locales). (Salteado en resume: el guard 5 ya verificó cic === cic.)
 *   3. markCancelled(source) — severing local (fallo → severed:false, sigue).
 *   4. clearCancelled(target) — best-effort VISIBLE (MEDIUM-2: fallo → targetCleared:false, 207).
 *   5. RESOLUCIÓN del slot origen + CAPTURA de credenciales, SIN inactivar todavía (fix wave 2
 *      FIX-3 / HIGH-2 completado): TODAS las filas managed activas que registran el cic EXACTO
 *      (MEDIUM-1 — mata colisiones de prefijo y residuos de parciales), EXCLUYENDO la fila del
 *      contrato destino (en resume ya puede existir y es del destino, no del origen — la
 *      exclusión también evita capturarle/wipearle las credenciales). Fallo → localSource:'failed'.
 *   6. Slot DESTINO PRIMERO: reconcileTvContractService + carry de credenciales capturadas a la
 *      fila destino (HIGH-2; sin credenciales capturadas NO se escribe nada — en resume no se
 *      pisan las que el destino ya tiene). Fallo → localTarget:'failed' y el paso 6b NO corre.
 *   6b. Slot(s) ORIGEN DESPUÉS, SOLO con el write del destino OK (FIX-3): inactivación DIRECTA +
 *      clear de credenciales. Con el destino fallado, el origen queda deliberadamente ACTIVO y
 *      CON credenciales (localSource:'failed' → 207) para que el retry resume las encuentre
 *      (findActive… filtra active). El orden viejo (origen primero) dejaba las credenciales en
 *      NINGUNA fila si el destino fallaba — pérdida definitiva, la password TV no es re-derivable.
 *      El resume con destino ya OK completa acá la inactivación pendiente del origen.
 *   7. Eventos transfer-out y transfer-in (contrato destino). El contrato del transfer-out sale
 *      de la fila REALMENTE inactivada cuando 6b inactivó alguna (resolved manda sobre el input,
 *      MEDIUM-3b); si NADA se inactivó (p.ej. destino fallado → 6b no corre), cae al fallback
 *      input.sourceContractId (validado por 3b) — el evento a nivel negocio se graba igual
 *      porque el partner YA transfirió, y el retry (resume) lo re-graba. Sin resolved ni input,
 *      se omite con warn.
 *      Best-effort, patrón UpdatePppoeService:172-219: eventType 'modified' + changeKind +
 *      oldValue/newValue = nombres snapshot; notes legibles "CIC {cic} — de {origen} a {destino}"
 *      (MEDIUM-5). En resume los eventos se re-graban (rastro del retry — append-only asumido).
 */
export class TransferTvToCustomer {
  constructor(
    private readonly gigared: GigaredPort,
    private readonly customerLookup: CustomerLookup,
    private readonly contractLookup: ContractLookup,
    private readonly csRepo: ContractServiceRepository,
    private readonly catalogRepo: ServiceCatalogRepository,
    private readonly tvCancellation: ClientTvCancellationRepository,
    private readonly eventRepo?: ContractServiceEventRepository,
    /**
     * service-transfer (TV-3, D7) — dependencia OPCIONAL, DISTINTA de `eventRepo` (el log
     * por-contrato). Cuando está presente, graba DOS eventos `transferencia` en el Historial TV
     * GLOBAL (best-effort, nunca aborta la transferencia). Ver Paso 7b.
     */
    private readonly activationEventRepo?: TvActivationEventRepository,
  ) {}

  async execute(sourceCustomerId: string, input: TransferTvInput): Promise<TransferTvResult> {
    // 1. Source customer existe.
    const source = await this.customerLookup.findById(sourceCustomerId);
    if (!source) throw new ClientNotFoundError(sourceCustomerId);

    // 2. Target customer existe.
    const target = await this.customerLookup.findById(input.targetCustomerId);
    if (!target) throw new ClientNotFoundError(input.targetCustomerId);

    // 2b. FIX-2 (fix wave 2) — A→A: transferirse a sí mismo no es una transferencia; el destino
    //     YA es el dueño. Espejo del guard 3 de TransferPppoe (destino == actual → 409). ANTES de
    //     cualquier llamada al partner, así que el cic aún no se conoce (→ cic ''). Sin este
    //     guard, ambos lados resolvían al MISMO cic y A→A entraba en modo resume.
    if (input.targetCustomerId === sourceCustomerId) {
      throw new TvAlreadyLinkedError(input.targetCustomerId, '');
    }

    // 3. #47k — el contrato destino debe PERTENECER al target (contrato ajeno → 404 sin leak),
    //    ANTES de cualquier llamada a Gigared.
    const contract = await this.contractLookup.findById(input.targetContractId);
    if (!contract || contract.clientId !== input.targetCustomerId) {
      throw new ContractNotFoundError(input.targetContractId);
    }

    // 3b. MEDIUM-3 — sourceContractId explícito: existe y pertenece al cliente ORIGEN (espejo
    //     del guard 3). Un id basura/ajeno no puede viajar en silencio al evento transfer-out.
    if (input.sourceContractId !== undefined) {
      const srcContract = await this.contractLookup.findById(input.sourceContractId);
      if (!srcContract || srcContract.clientId !== sourceCustomerId) {
        throw new ContractNotFoundError(input.sourceContractId);
      }
    }

    // 4. La cuenta ORIGEN resuelve por su internal_id VIGENTE. HIGH-1: el flag isCancelled NO
    //    bloquea todavía — primero hay que saber si esto es un retry (resume) de un parcial.
    const sourceInternalId = currentTvInternalId(sourceCustomerId, source.tvActivationSeq ?? 0);
    let sourceAccount: GigaredAccount | null = null;
    try {
      sourceAccount = await this.gigared.getAccountByInternalId(sourceInternalId);
    } catch (e) {
      if (!(e instanceof GigaredNotFoundError)) throw e;
    }
    // El alias del CUA es append-only: un transfer previo JAMÁS des-resuelve el origen. "No
    // resuelve" = nunca hubo TV vinculada a este internal_id → 404, sin importar el destino.
    if (!sourceAccount) throw new TvNotLinkedError(sourceCustomerId);
    // Capturado ANTES de mutar nada — es la identidad que viaja al destino y al resultado.
    const cic = sourceAccount.cic;

    // 5. Destino: resolver su internal_id vigente para decidir NUEVA vs RESUME vs CONFLICTO.
    const targetInternalId = currentTvInternalId(input.targetCustomerId, target.tvActivationSeq ?? 0);
    let targetExisting: GigaredAccount | null = null;
    try {
      targetExisting = await this.gigared.getAccountByInternalId(targetInternalId);
    } catch (e) {
      if (!(e instanceof GigaredNotFoundError)) throw e;
      // 404 upstream = destino libre — transferencia nueva.
    }
    // HIGH-1 — MODO RESUME: el destino ya resuelve AL MISMO cic → el alias quedó de un intento
    // previo parcial (207). Los pasos 3-7 son idempotentes: se re-ejecutan sin re-aliasar.
    const resume = targetExisting !== null && targetExisting.cic === cic;
    if (targetExisting && !resume) {
      // Destino vinculado a OTRO cic: transferirle este crearía un doble vínculo irreversible
      // (mapping append-only) → 409, como siempre.
      throw new TvAlreadyLinkedError(input.targetCustomerId, targetExisting.cic);
    }

    // 5b. Cross-check LOCAL de ownership — INCONDICIONAL (fix wave 3; nació como FIX-1 del fix
    //     wave 2 solo para el resume): el ownership local manda sobre el estado upstream (F0),
    //     SIEMPRE. La verdad de ownership son las filas managed ACTIVAS con este cic EXACTO
    //     (+ flags tvCancelledAt), jamás el partner:
    //     - resume: el alias del CUA es append-only PARA SIEMPRE — "el destino resuelve al mismo
    //       cic" puede ser el residuo de un parcial VIEJO aunque la cuenta se haya movido a un
    //       TERCERO después (A→B parcial 207 → A→C completa → replay del POST A→B viejo).
    //     - no-resume: que el destino esté FRESCO (404 upstream) tampoco prueba nada — tras un
    //       A→C parcial con severed:false (C con fila ACTIVA, A sin flag), un POST A→B se
    //       aliasaba y los pasos 5/6b capturaban las credenciales e inactivaban la fila ACTIVA
    //       de C con 200 (robo silencioso). Por eso el check corre en AMBOS caminos, ANTES de
    //       setInternalId.
    //     Si alguna fila managed ACTIVA con el cic pertenece a un cliente que NO es ni el origen
    //     ni el destino, el dueño local vigente es OTRO → 409 con SU customerId, cero mutaciones.
    {
      const tvCatalog = await this.catalogRepo.getByName('TV');
      // Sin catálogo TV no hay forma de verificar el ownership local → fail-closed (422), igual
      // que el reconcile. Jamás transferir/resumir sin poder verificar.
      if (!tvCatalog || !tvCatalog.active) throw new TvCatalogMissingError();
      const owned = await this.csRepo.findActiveByCatalogAndNotesPrefix(
        tvCatalog.id,
        `${GIGARED_NOTES_PREFIX}${cic}`,
      );
      for (const row of owned) {
        if (cicFromNotes(row.notes) !== cic) continue; // colisión de prefijo (MEDIUM-1)
        const rowContract = await this.contractLookup.findById(row.contractId);
        const ownerId = rowContract?.clientId;
        // Contrato irresoluble → no se le puede atribuir dueño: no bloquea (residuo sucio que el
        // paso 6b limpiará como siempre).
        if (ownerId && ownerId !== sourceCustomerId && ownerId !== input.targetCustomerId) {
          throw new TvAlreadyLinkedError(ownerId, cic);
        }
      }
    }

    // 6. isCancelled(origen) bloquea SOLO fuera de resume: en el retry post-parcial el severing
    //    del intento anterior pudo haber corrido — el 207 promete retry, no un 404.
    if (!resume && (await this.tvCancellation.isCancelled(sourceCustomerId))) {
      throw new TvNotLinkedError(sourceCustomerId);
    }

    if (!resume) {
      // Paso 1 — alias en el partner. F0: el CUA responde 200 pero NO pisa: agrega un alias.
      await this.gigared.setInternalId(cic, targetInternalId);

      // Paso 2 — VERIFY del alias. El 200 del PATCH no prueba nada: hay que releer por el
      // internal_id destino y chequear que resuelve AL MISMO CIC. Si no tomó, se aborta acá,
      // ANTES de cualquier efecto local (flags/slots/eventos intactos).
      let verified: GigaredAccount;
      try {
        verified = await this.gigared.getAccountByInternalId(targetInternalId);
      } catch (e) {
        if (e instanceof GigaredNotFoundError) {
          throw new GigaredRejectedError(
            'Transferencia de TV rechazada',
            `el alias ${targetInternalId} no resuelve en el CUA tras el PATCH (respondió 200 sin efecto)`,
          );
        }
        throw e;
      }
      if (verified.cic !== cic) {
        throw new GigaredRejectedError(
          'Transferencia de TV rechazada',
          `el alias ${targetInternalId} resuelve al CIC ${verified.cic}, no al CIC ${cic} transferido`,
        );
      }
    }

    // Paso 3 — severing LOCAL del origen (mecanismo #72). ESENCIAL para matar el doble vínculo:
    // el internal_id del origen sigue resolviendo por el alias, así que el flag local es lo único
    // que hace que el panel del origen muestre "sin TV" y bloquee operaciones sobre la cuenta.
    // Un fallo NO revierte la op partner (no hay unlink primitive): severed:false → 207.
    let severed = true;
    try {
      await this.tvCancellation.markCancelled(sourceCustomerId);
    } catch (err) {
      severed = false;
      console.warn('[gigared] transfer: markCancelled(origen) falló — severing pendiente (207)', err);
    }

    // Paso 4 — el destino vuelve a tener TV: limpiar su flag de baja local. Best-effort pero
    // VISIBLE (MEDIUM-2): un fallo deja al destino "sin TV" en el panel → targetCleared:false, 207.
    let targetCleared = true;
    try {
      await this.tvCancellation.clearCancelled(input.targetCustomerId);
    } catch (err) {
      targetCleared = false;
      console.warn('[gigared] transfer: clearCancelled(destino) falló — flag pendiente (207)', err);
    }

    // Paso 5 — RESOLUCIÓN del slot(s) TV del ORIGEN + CAPTURA de credenciales, SIN inactivar
    // todavía (FIX-3). MEDIUM-1: cuentan TODAS las filas managed ACTIVAS cuyo cic EXACTO
    // (cicFromNotes) coincide — el prefijo solo pre-filtra ("CIC 123" matchea "CIC 1234") y la
    // data sucia puede tener más de una fila registrando el cic (residuo de parciales). La fila
    // del contrato DESTINO se excluye siempre: en resume ya existe con el mismo cic y es del
    // destino (excluirla también evita capturar/wipear SUS credenciales).
    // HIGH-2: las credenciales capturadas son la única copia local de la password.
    let localSource: 'synced' | 'failed' = 'synced';
    let carriedLogin: string | null = null;
    let carriedPassword: string | null = null;
    const sourceRows: ContractServiceView[] = [];
    try {
      const tvCatalog = await this.catalogRepo.getByName('TV');
      if (!tvCatalog || !tvCatalog.active) throw new TvCatalogMissingError();

      const rows: ContractServiceView[] = [];
      if (input.sourceContractId && input.sourceContractId !== input.targetContractId) {
        const byPair = await this.csRepo.getByPair(input.sourceContractId, tvCatalog.id);
        if (byPair && cicFromNotes(byPair.notes) === cic) rows.push(byPair);
      }
      const candidates = await this.csRepo.findActiveByCatalogAndNotesPrefix(
        tvCatalog.id,
        `${GIGARED_NOTES_PREFIX}${cic}`,
      );
      for (const candidate of candidates) {
        if (
          cicFromNotes(candidate.notes) === cic &&
          candidate.contractId !== input.targetContractId &&
          !rows.some((r) => r.id === candidate.id)
        ) {
          rows.push(candidate);
        }
      }

      for (const row of rows) {
        // Solo filas managed (H2) — cicFromNotes ya lo garantiza, doble cinturón.
        if (!isGigaredManaged(row.notes)) continue;
        // HIGH-2: primera credencial viva encontrada — es la única copia local de la password.
        if (carriedLogin === null && row.tvLogin != null) carriedLogin = row.tvLogin;
        if (carriedPassword === null && row.tvPassword != null) carriedPassword = row.tvPassword;
        sourceRows.push(row);
      }
      // Sin fila resoluble no hay nada NUESTRO que inactivar → synced (vacuamente).
    } catch (err) {
      localSource = 'failed';
      console.warn('[gigared] transfer: resolución del slot origen falló (retry direccionado)', err);
    }

    // Paso 6 — slot TV local del DESTINO PRIMERO (FIX-3): reconcile account-driven normal (acá
    // SÍ sirve — el internal_id destino resuelve a la cuenta transferida con sus packs) + carry
    // de credenciales (HIGH-2). Sin credenciales capturadas NO se escribe nada: en resume la
    // fila origen puede seguir activa (se capturan de nuevo) o ya estar wipeada (las del destino
    // no se pisan).
    let localTarget: 'synced' | 'failed' = 'synced';
    try {
      const { contractServiceId } = await reconcileTvContractService({
        gigared: this.gigared,
        csRepo: this.csRepo,
        catalogRepo: this.catalogRepo,
        customerId: input.targetCustomerId,
        contractId: input.targetContractId,
        internalId: targetInternalId,
      });
      if (contractServiceId && (carriedLogin !== null || carriedPassword !== null)) {
        await this.csRepo.update(contractServiceId, {
          ...(carriedLogin !== null ? { tvLogin: carriedLogin } : {}),
          ...(carriedPassword !== null ? { tvPassword: carriedPassword } : {}),
        });
      }
    } catch (err) {
      localTarget = 'failed';
      console.warn('[gigared] transfer: reconcile del slot destino falló (retry direccionado)', err);
    }

    // Paso 6b — inactivación DIRECTA + wipe del ORIGEN, SOLO con el write del destino OK (FIX-3):
    // si el destino falló, el origen queda deliberadamente ACTIVO y CON credenciales para que el
    // retry resume las encuentre (findActive… filtra active) — inactivarlo acá dejaría la
    // password TV (no re-derivable) en NINGUNA fila: pérdida definitiva.
    // MEDIUM-3b: resolvedSourceContractId = contrato de la fila REALMENTE inactivada (manda sobre
    // el input para el evento transfer-out).
    let resolvedSourceContractId: string | null = null;
    if (localTarget === 'synced') {
      try {
        for (const row of sourceRows) {
          await this.csRepo.update(row.id, { status: 'inactive', tvLogin: null, tvPassword: null });
          if (resolvedSourceContractId === null) resolvedSourceContractId = row.contractId;
        }
      } catch (err) {
        localSource = 'failed';
        console.warn('[gigared] transfer: inactivación del slot origen falló (retry direccionado)', err);
      }
    } else if (sourceRows.length > 0) {
      localSource = 'failed';
      console.warn(
        '[gigared] transfer: destino falló — el slot origen queda ACTIVO con credenciales para el retry (FIX-3)',
      );
    }

    // Paso 7 — auditoría transversal (best-effort, patrón UpdatePppoeService): transfer-out en el
    // contrato origen y transfer-in en el destino, con snapshot legible de-quién-a-quién.
    // Nombres + contrato origen resuelto se hoistean: el Paso 7b (TV-3) los reutiliza — misma
    // fuente de verdad, DEPENDENCIA distinta (activationEventRepo, nunca this.eventRepo).
    const sourceName = source.name ?? sourceCustomerId;
    const targetName = target.name ?? input.targetCustomerId;
    // MEDIUM-3b — precedencia INVERTIDA: la fila realmente inactivada manda; el input es
    // solo el fallback (p.ej. slot origen irresoluble pero contrato validado por 3b).
    const outContractId = resolvedSourceContractId ?? input.sourceContractId;

    if (this.eventRepo) {
      try {
        const catalog = await this.catalogRepo.getByName('TV');
        if (catalog) {
          const base = {
            serviceCatalogId: catalog.id,
            eventType: 'modified' as const,
            actorId: input.actorId ?? null,
            actorName: input.actorName ?? '',
            // Snapshot legible (decisión del proposal): nombres de ambos clientes. Sin name en el
            // lookup (callers viejos), cae al id — nunca un evento sin dirección.
            oldValue: sourceName,
            newValue: targetName,
            // MEDIUM-5: la ficha lee las notes — "de quién a quién" tiene que ser legible.
            notes: `CIC ${cic} — de ${sourceName} a ${targetName}`,
          };
          if (outContractId) {
            await this.eventRepo.record({ ...base, contractId: outContractId, changeKind: 'transfer-out' });
          } else {
            console.warn('[gigared] transfer: sin contrato origen resoluble — se omite el evento transfer-out', {
              sourceCustomerId, cic,
            });
          }
          await this.eventRepo.record({ ...base, contractId: input.targetContractId, changeKind: 'transfer-in' });
        }
      } catch (err) {
        console.warn('[gigared] transfer: fallo grabando eventos de historial (best-effort)', err);
      }
    }

    // Paso 7b — service-transfer (TV-3, D7): Historial TV GLOBAL. Dos eventos `transferencia`,
    // uno por cliente involucrado — el log por-contrato de arriba (eventRepo) NO alimenta
    // `ListTvActivationHistory`/`GET .../activation-history`, así que sin esto una transferencia
    // exitosa queda invisible ahí (caso Centeno/Vacherand real). Best-effort, DEPENDENCIA
    // DISTINTA de this.eventRepo — un fallo JAMÁS aborta la transferencia (try/catch por evento,
    // así el fallo del destino no le impide al origen su propio intento). Se graba siempre que
    // llegamos hasta acá: fresh recién aliasado+verificado, o resume ya verificado en un run
    // previo — independiente de severed/targetCleared/localSource/localTarget.
    if (this.activationEventRepo) {
      try {
        await this.activationEventRepo.record({
          clientId:    input.targetCustomerId,
          actorId:     input.actorId ?? null,
          actorName:   input.actorName ?? '',
          eventType:   'transferencia',
          cic,
          internalId:  targetInternalId,
          contractId:  input.targetContractId,
          reason:      `Recibido por transferencia de ${sourceName}`,
        });
      } catch (err) {
        console.warn('[gigared] transfer: fallo grabando evento transferencia (destino, best-effort)', err);
      }
      try {
        await this.activationEventRepo.record({
          clientId:    sourceCustomerId,
          actorId:     input.actorId ?? null,
          actorName:   input.actorName ?? '',
          eventType:   'transferencia',
          cic,
          internalId:  sourceInternalId,
          contractId:  outContractId ?? null,
          reason:      `Transferido a ${targetName}`,
        });
      } catch (err) {
        console.warn('[gigared] transfer: fallo grabando evento transferencia (origen, best-effort)', err);
      }
    }

    return { cic, severed, targetCleared, localSource, localTarget };
  }
}
