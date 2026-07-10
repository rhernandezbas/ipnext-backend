import { ContractInventoryRepository } from '@domain/ports/ContractInventoryRepository';
import { UnitOfWork } from '@domain/ports/UnitOfWork';
import { ServiceCatalogRepository } from '@domain/ports/ServiceCatalogRepository';
import { ContractServiceEventRepository } from '@domain/ports/ContractServiceEventRepository';
import { ContractInstalledItem } from '@domain/entities/contract-installed-item';
import { ContractNotFoundError } from '@domain/errors/contractServices';
import {
  EquipmentTransferValidationError,
  InstalledItemAlreadyRemovedError,
  InstalledItemNotFoundError,
} from '@domain/errors/inventory';
import { ResolveClientLocation } from './ResolveClientLocation';
import { TransferContractLookup } from './TransferPppoe';

export interface TransferContractEquipmentInput {
  targetContractId: string;
  itemIds: string[];
  actorId?: string | null;
  actorName?: string;
}

export interface TransferContractEquipmentResult {
  moved: number;
  items: { id: string; type: string; assetMoved: boolean }[];
}

/**
 * TransferContractEquipment (service-transfer W3, EPIC Titularidad) — mueve un lote de
 * ContractInstalledItem del contrato origen al destino (otro cliente), spec EQ-1.
 *
 * Guardas (pinned por el design §4, TODAS antes de mover nada):
 *   1. source contract existe (lookup ownership-aware) → ContractNotFoundError (404)
 *   2. target contract existe                          → ContractNotFoundError (404)
 *   3. target ≠ source                                 → EquipmentTransferValidationError (400)
 *   4. itemIds no vacío                                → EquipmentTransferValidationError (400)
 *   5. CADA ítem: existe Y pertenece al source (ajeno → InstalledItemNotFoundError 404, sin
 *      leak — espejo del scoping de RetireInstalledItem) Y está 'active' (inactivo →
 *      InstalledItemAlreadyRemovedError 409). Un solo ítem inválido → falla el lote COMPLETO.
 *
 * Atomicidad: TODO el lote corre dentro de UN `uow.runInTransaction` — el TransactionalRepos
 * ya expone `inventory` (repo legacy) + `movements` (ledger unificado), así que legacy y
 * ledger comparten LA MISMA transacción (all-or-nothing, patrón IssueStockToTechnician).
 * Las CLIENTE-locations se resuelven ANTES de la tx: el find-or-create es idempotente y
 * side-effect-safe de repetir (mismo razonamiento que IssueStockToTechnician).
 *
 * Por ítem: `transferToContract(itemId, target)`; si `item.assetId` → movimiento TRANSFER
 * CLIENTE(origen) → CLIENTE(destino) (computeAssetEffect actualiza currentLocationId).
 *
 * Eventos (best-effort, patrón UpdatePppoeService:172-219): transfer-out (origen) /
 * transfer-in (destino), eventType 'modified', oldValue/newValue = nombres snapshot de ambos
 * clientes, notes = 'Equipos: {type serial/mac, ...}'. serviceCatalogId es NOT NULL en el
 * schema y NO hay catálogo de servicio para equipos → se usa el catálogo 'INTERNET' por
 * nombre, la MISMA decisión que TransferPppoe (W2): el historial del contrato se lee por
 * changeKind/notes, no por catálogo. Un eventRepo roto JAMÁS aborta la transferencia hecha.
 */
export class TransferContractEquipment {
  constructor(
    private readonly inventory: ContractInventoryRepository,
    private readonly contractLookup: TransferContractLookup,
    private readonly resolveClientLocation: ResolveClientLocation,
    private readonly uow: UnitOfWork,
    private readonly catalogRepo?: ServiceCatalogRepository,
    private readonly eventRepo?: ContractServiceEventRepository,
  ) {}

  async execute(
    sourceContractId: string,
    input: TransferContractEquipmentInput,
  ): Promise<TransferContractEquipmentResult> {
    // Guard 1: el contrato origen existe (y trae clientName para el snapshot de eventos).
    const source = await this.contractLookup.findById(sourceContractId);
    if (!source) throw new ContractNotFoundError(sourceContractId);

    // Guard 2: el contrato destino existe.
    const target = await this.contractLookup.findById(input.targetContractId);
    if (!target) throw new ContractNotFoundError(input.targetContractId);

    // Guard 3: transferirse a sí mismo es un no-op rechazado.
    if (sourceContractId === input.targetContractId) {
      throw new EquipmentTransferValidationError('El contrato destino es el mismo que el origen');
    }

    // Guard 4: lote no vacío. Dedup defensivo: un id repetido movería/registraría doble.
    const itemIds = [...new Set(input.itemIds)];
    if (itemIds.length === 0) {
      throw new EquipmentTransferValidationError('itemIds no puede estar vacío');
    }

    // Guard 5: CADA ítem existe, pertenece al origen y está activo — ANTES de mover nada.
    const items: ContractInstalledItem[] = [];
    for (const id of itemIds) {
      const item = await this.inventory.getById(id);
      // Ajeno == inexistente (404 sin leak, espejo RetireInstalledItem).
      if (!item || item.contractId !== sourceContractId) throw new InstalledItemNotFoundError(id);
      if (item.status !== 'active') throw new InstalledItemAlreadyRemovedError(id);
      items.push(item);
    }

    // CLIENTE-locations solo si algún ítem tiene asset en el ledger. Fuera de la tx:
    // find-or-create idempotente (si la tx después falla, una location huérfana es inocua).
    const needsLedger = items.some(i => i.assetId != null);
    let sourceLocId: string | null = null;
    let targetLocId: string | null = null;
    if (needsLedger) {
      sourceLocId = (await this.resolveClientLocation.execute(sourceContractId)).id;
      targetLocId = (await this.resolveClientLocation.execute(input.targetContractId)).id;
    }

    // Lote atómico: legacy (contractId) + ledger (TRANSFER) en UNA transacción.
    await this.uow.runInTransaction(async (repos) => {
      for (const item of items) {
        await repos.inventory.transferToContract(item.id, input.targetContractId);
        if (item.assetId) {
          await repos.movements.record({
            type: 'TRANSFER',
            assetId: item.assetId,
            fromLocationId: sourceLocId!,
            toLocationId: targetLocId!,
            source: 'CONTRACT_TRANSFER',
            note: `Transferencia de equipos: contrato ${sourceContractId} → ${input.targetContractId}`,
          });
        }
      }
    });

    // Historial best-effort — la transferencia YA está hecha, un fallo acá solo warnea.
    await this.recordTransferEvents({
      sourceContractId,
      targetContractId: input.targetContractId,
      oldValue: source.clientName ?? source.clientId,
      newValue: target.clientName ?? target.clientId,
      notes: `Equipos: ${items.map(labelOf).join(', ')}`,
      actorId: input.actorId ?? null,
      actorName: input.actorName ?? '',
    });

    return {
      moved: items.length,
      items: items.map(i => ({ id: i.id, type: i.type, assetMoved: i.assetId != null })),
    };
  }

  /**
   * Graba transfer-out (origen) + transfer-in (destino), best-effort — NUNCA lanza.
   * Catálogo 'INTERNET' por nombre (decisión documentada arriba); sin catálogo → skip.
   */
  private async recordTransferEvents(p: {
    sourceContractId: string;
    targetContractId: string;
    oldValue: string;
    newValue: string;
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
        oldValue: p.oldValue,
        newValue: p.newValue,
        notes: p.notes,
        actorId: p.actorId,
        actorName: p.actorName,
      };
      await this.eventRepo.record({ ...base, contractId: p.sourceContractId, changeKind: 'transfer-out' });
      await this.eventRepo.record({ ...base, contractId: p.targetContractId, changeKind: 'transfer-in' });
    } catch (err) {
      console.warn('[TransferContractEquipment] fallo grabando eventos transfer-out/in (best-effort):', err);
    }
  }
}

/** Etiqueta compacta del ítem para las notes del historial: 'TYPE serial/mac' (partes opcionales). */
function labelOf(i: ContractInstalledItem): string {
  const ident = [i.serialNumber, i.mac].filter((v): v is string => v != null && v !== '').join('/');
  return ident ? `${i.type} ${ident}` : i.type;
}
