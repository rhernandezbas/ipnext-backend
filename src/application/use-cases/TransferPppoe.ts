import { PppoeServiceRepository } from '@domain/ports/PppoeServiceRepository';
import { ServiceCatalogRepository } from '@domain/ports/ServiceCatalogRepository';
import { ContractServiceEventRepository } from '@domain/ports/ContractServiceEventRepository';
import { ContractNotFoundError } from '@domain/errors/contractServices';
import {
  PppoeServiceNotFoundError,
  PppoeAlreadyAssociatedError,
  PppoeContractAlreadyHasServiceError,
  PppoeTransferValidationError,
  PppoeTransferPendingResidueError,
} from '@domain/errors/pppoe';
import { CreatePppoeService, CreatePppoeServiceInput } from './CreatePppoeService';
import { TerminatePppoeService } from './TerminatePppoeService';
import { EnsureInternetContractService } from './EnsureInternetContractService';

/**
 * Contract lookup con ownership + nombre del cliente (service-transfer W2). Espejo del
 * ContractLookup de gigared/lookups.ts (#47k) — devuelve `clientId` (resolución de titularidad)
 * más `clientName` para el snapshot LEGIBLE de los eventos transfer-out/in ("de quién a quién").
 * `clientName` opcional/null → el evento cae al clientId (nunca un evento sin dirección).
 */
export interface TransferContractLookup {
  findById(id: string): Promise<{ id: string; clientId: string; clientName?: string | null } | null>;
}

export type TransferPppoeMode = 'as-is' | 'recreate';

export interface TransferPppoeInput {
  targetContractId: string;
  mode: TransferPppoeMode;
  /** OBLIGATORIO en mode 'as-is' (falta → PppoeTransferValidationError; la ruta responde 400). */
  reason?: string | null;
  /** OBLIGATORIO en mode 'recreate': datos del PPPoE nuevo (el contractId lo fija el use case). */
  newPppoe?: Omit<CreatePppoeServiceInput, 'contractId'>;
  actorId?: string | null;
  actorName?: string;
}

export interface TransferPppoeResult {
  mode: TransferPppoeMode;
  oldContractId: string;
  newContractId: string;
  oldUsername: string;
  /** Solo en 'recreate': username del PPPoE nuevo. */
  newUsername?: string;
  /**
   * Solo en 'recreate': true = el nuevo quedó VIVO pero el terminate del viejo falló.
   * Retry direccionado: DELETE /api/pppoe/:id del viejo. El router responde 207.
   */
  partial?: boolean;
}

/**
 * TransferPppoe (service-transfer W2, EPIC Titularidad) — transfiere un PppoeService a otro
 * contrato (otro cliente) en dos modos:
 *
 * - **as-is** (fallback con motivo): reasigna SOLO el `contractId` (setContractId, port :159 —
 *   NO toca secret/RADIUS/router). `reason` OBLIGATORIO. Marca distintiva en el historial:
 *   notes 'tal cual (sin recrear) — pendiente de regularizar' → la lista de regularización
 *   sale filtrando ese changeKind+notes.
 * - **recreate**: COMPONE los use cases inyectados, crear PRIMERO:
 *     1. `createPppoe.execute({...newPppoe, contractId: destino})` — si LANZA → abort total
 *        (el viejo queda intacto, CERO eventos), error propagado.
 *     2. `terminatePppoe.execute(pppoeId)` — baja HARD del viejo. Si LANZA → resultado
 *        PARCIAL `{partial:true}` (nuevo vivo, viejo pendiente; retry por el DELETE existente)
 *        y los eventos se graban IGUAL con la marca del parcial.
 *
 * Guardas comunes (pinned por el design §3):
 *   1. pppoe existe                       → PppoeServiceNotFoundError (404)
 *   1b. pppoe CON contrato origen         → PppoeTransferValidationError (un huérfano se adopta
 *       por associate, no por transfer — decisión de margen documentada)
 *   2. targetContract existe (+clientId)  → ContractNotFoundError (404)
 *   3. target ≠ contrato actual           → PppoeAlreadyAssociatedError (409; REUSO semántico:
 *       "ya está asociado a ESE contrato" describe exactamente el no-op)
 *   4. destino SIN otro PPPoE enabled     → PppoeContractAlreadyHasServiceError (409, espejo
 *       AssociatePppoeToContract guard #4)
 *
 * Eventos (patrón best-effort UpdatePppoeService:172-219, catálogo INTERNET por nombre):
 * transfer-out en el contrato origen / transfer-in en el destino, eventType 'modified',
 * oldValue/newValue = nombres snapshot de ambos clientes (fallback clientId), reason + notes.
 * Un eventRepo roto JAMÁS aborta la transferencia ya hecha.
 */
export class TransferPppoe {
  constructor(
    private readonly repo: PppoeServiceRepository,
    private readonly contractLookup: TransferContractLookup,
    private readonly createPppoe: CreatePppoeService,
    private readonly terminatePppoe: TerminatePppoeService,
    private readonly ensureInternet: EnsureInternetContractService,
    private readonly catalogRepo?: ServiceCatalogRepository,
    private readonly eventRepo?: ContractServiceEventRepository,
  ) {}

  async execute(pppoeId: string, input: TransferPppoeInput): Promise<TransferPppoeResult> {
    // Validación de input PRIMERO (cero I/O, cero efectos) — defensa espejo de la ruta (400).
    if (input.mode !== 'as-is' && input.mode !== 'recreate') {
      throw new PppoeTransferValidationError(`mode inválido: '${String(input.mode)}' (esperado 'as-is' | 'recreate')`);
    }
    const reason = input.reason?.trim() ?? '';
    if (input.mode === 'as-is' && reason === '') {
      throw new PppoeTransferValidationError("mode 'as-is' requiere un motivo (reason)");
    }
    if (input.mode === 'recreate' && input.newPppoe == null) {
      throw new PppoeTransferValidationError("mode 'recreate' requiere los datos del PPPoE nuevo (newPppoe)");
    }

    // Guard 1: el PPPoE existe.
    const pppoe = await this.repo.findById(pppoeId);
    if (!pppoe) throw new PppoeServiceNotFoundError(pppoeId);

    // Guard 1b: transferir exige titularidad ORIGEN — un huérfano se adopta por associate.
    if (pppoe.contractId === null) {
      throw new PppoeTransferValidationError(
        `El PPPoE ${pppoeId} no está asociado a ningún contrato — usá POST /pppoe/:id/associate`,
      );
    }
    const sourceContractId = pppoe.contractId;

    // Guard 2: el contrato destino existe (y trae clientId + clientName para el snapshot).
    const target = await this.contractLookup.findById(input.targetContractId);
    if (!target) throw new ContractNotFoundError(input.targetContractId);

    // Guard 3: destino == contrato actual → no-op rechazado (409, reuso semántico).
    if (sourceContractId === input.targetContractId) {
      throw new PppoeAlreadyAssociatedError(pppoeId, sourceContractId);
    }

    // Guard 4: el contrato destino NO debe tener ya un PPPoE enabled (espejo associate :44).
    const existing = await this.repo.findByContract(input.targetContractId);
    const activeExisting = existing.find(p => p.status === 'enabled');
    if (activeExisting) {
      throw new PppoeContractAlreadyHasServiceError(input.targetContractId, activeExisting.id);
    }

    // Snapshot legible de-quién-a-quién ANTES de mutar nada. El lookup del origen es solo para
    // el nombre: si no resuelve (contrato borrado), cae al id — la transferencia no se bloquea.
    const source = await this.contractLookup.findById(sourceContractId);
    const oldValue = source?.clientName ?? source?.clientId ?? sourceContractId;
    const newValue = target.clientName ?? target.clientId;

    const actorId = input.actorId ?? null;
    const actorName = input.actorName ?? '';

    if (input.mode === 'as-is') {
      // Paso 1 — reasignación pura del contrato (NO toca secret/RADIUS).
      const updated = await this.repo.setContractId(pppoeId, input.targetContractId);
      // setContractId solo devuelve null si la fila desapareció entre el findById y el update (carrera).
      if (!updated) throw new PppoeServiceNotFoundError(pppoeId);

      // Paso 2 — líneas INTERNET de ambos contratos, best-effort (espejo associate/deassociate).
      const opts = { reason, actorId, actorName };
      try {
        await this.ensureInternet.execute(sourceContractId, false, opts);
      } catch (err) {
        console.warn('[TransferPppoe] ensureInternet(origen,false) falló (best-effort):', err);
      }
      try {
        await this.ensureInternet.execute(input.targetContractId, true, opts);
      } catch (err) {
        console.warn('[TransferPppoe] ensureInternet(destino,true) falló (best-effort):', err);
      }

      // Paso 3 — historial: la marca "tal cual" alimenta la lista de regularización.
      await this.recordTransferEvents({
        sourceContractId,
        targetContractId: input.targetContractId,
        oldValue,
        newValue,
        reason,
        notes: `PPPoE ${pppoe.username} — tal cual (sin recrear) — pendiente de regularizar`,
        actorId,
        actorName,
      });

      return {
        mode: 'as-is',
        oldContractId: sourceContractId,
        newContractId: input.targetContractId,
        oldUsername: pppoe.username,
      };
    }

    // ── mode 'recreate' ───────────────────────────────────────────────────────
    // MEDIUM-4 — residuo de un intento PREVIO: si el create pasado falló post-upsert, la fila
    // del username nuevo quedó 'pending' en el contrato DESTINO. Sin este guard, el retry
    // moriría en un PPPOE_USERNAME_TAKEN engañoso (findByUsername dup dentro de create).
    // Solo aplica al residuo NUESTRO (pending + mismo contrato destino); una fila real
    // (enabled / otro contrato) sigue cayendo en el 409 USERNAME_TAKEN de siempre.
    const priorByUsername = await this.repo.findByUsername(input.newPppoe!.username);
    if (
      priorByUsername &&
      priorByUsername.status === 'pending' &&
      priorByUsername.contractId === input.targetContractId
    ) {
      throw new PppoeTransferPendingResidueError(input.newPppoe!.username, priorByUsername.id);
    }

    // Paso 1 — crear PRIMERO. Si LANZA se propaga tal cual: el viejo queda intacto y NO se
    // grabó ningún evento (abort íntegro, spec PPPOE-2).
    const created = await this.createPppoe.execute(
      { ...input.newPppoe!, contractId: input.targetContractId },
      { actorId, actorName },
    );

    // Paso 2 — baja HARD del viejo (orchestrator.deleteUser / router.removeSecret según nas.type
    // + deleteById + ensureInternet(origen,false) best-effort — todo DENTRO de terminate).
    // Fallo → PARCIAL: el nuevo ya vive; el retry direccionado es el DELETE /pppoe/:id existente.
    let partial = false;
    try {
      await this.terminatePppoe.execute(pppoeId, { reason: reason || null, actorId, actorName });
    } catch (err) {
      partial = true;
      console.warn(
        '[TransferPppoe] terminate del PPPoE viejo falló — resultado PARCIAL (nuevo vivo, viejo pendiente de borrar):',
        err,
      );
    }

    // Paso 3 — historial (best-effort). En el parcial se graban IGUAL, con la marca explícita.
    const baseNotes = `PPPoE recreado: ${pppoe.username} → ${created.username}`;
    await this.recordTransferEvents({
      sourceContractId,
      targetContractId: input.targetContractId,
      oldValue,
      newValue,
      reason: reason || null,
      notes: partial ? `${baseNotes} — PARCIAL: el viejo sigue vivo, pendiente de borrar` : baseNotes,
      actorId,
      actorName,
    });

    const result: TransferPppoeResult = {
      mode: 'recreate',
      oldContractId: sourceContractId,
      newContractId: input.targetContractId,
      oldUsername: pppoe.username,
      newUsername: created.username,
    };
    if (partial) result.partial = true;
    return result;
  }

  /**
   * Graba transfer-out (contrato origen) + transfer-in (destino), best-effort — patrón
   * UpdatePppoeService:172-219. Catálogo por nombre ('INTERNET'). NUNCA lanza.
   */
  private async recordTransferEvents(p: {
    sourceContractId: string;
    targetContractId: string;
    oldValue: string;
    newValue: string;
    reason: string | null;
    notes: string;
    actorId: string | null;
    actorName: string;
  }): Promise<void> {
    if (!this.catalogRepo || !this.eventRepo) return;
    try {
      const catalog = await this.catalogRepo.getByName('INTERNET');
      if (!catalog) return;
      const base = {
        serviceCatalogId: catalog.id,
        eventType: 'modified' as const,
        reason: p.reason,
        actorId: p.actorId,
        actorName: p.actorName,
        oldValue: p.oldValue,
        newValue: p.newValue,
        notes: p.notes,
      };
      await this.eventRepo.record({ ...base, contractId: p.sourceContractId, changeKind: 'transfer-out' });
      await this.eventRepo.record({ ...base, contractId: p.targetContractId, changeKind: 'transfer-in' });
    } catch (err) {
      console.warn('[TransferPppoe] fallo grabando eventos transfer-out/in (best-effort):', err);
    }
  }
}
