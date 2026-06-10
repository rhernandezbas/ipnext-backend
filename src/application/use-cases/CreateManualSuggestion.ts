import { randomUUID } from 'crypto';
import { InventorySuggestionRepository } from '@domain/ports/InventorySuggestionRepository';
import { SchedulingRepository } from '@domain/ports/SchedulingRepository';
import { ContractInventoryRepository } from '@domain/ports/ContractInventoryRepository';
import { TaskNotFoundError } from '@domain/errors/scheduling';
import { InvalidItemTypeError } from '@domain/errors/inventory';
import { assertSuggestionComplete } from '@domain/services/suggestionCompleteness';
import { TaskInventorySuggestionDto, toTaskInventorySuggestionDto } from '@application/dto/TaskInventorySuggestionDto';
import { matchInstalledItem, toSuggestionMatch } from '@application/services/matchInstalledItem';
import { DeviceTypeCatalogService } from '@application/services/DeviceTypeCatalogService';
import { canonicalizeMac } from '@domain/entities/return-suggestion';

export interface CreateManualSuggestionInput {
  taskId: string;
  kind: 'DEVICE' | 'MATERIAL';
  /** Catalog type name (DEVICE only). Validated via DeviceTypeCatalogService. */
  type?: string | null;
  serialNumber?: string | null;
  mac?: string | null;
  materialDesc?: string | null;
  quantity?: number | null;
  unit?: string | null;
}

/**
 * Crea una sugerencia MANUAL para un task. La sugerencia entra al pipeline
 * de revisión del operador (confirm/discard) igual que las OCR/IClass.
 * No hace upsert — insert puro para no clobber filas OCR con mismo SN/MAC.
 */
export class CreateManualSuggestion {
  constructor(
    private readonly suggestions: InventorySuggestionRepository,
    private readonly scheduling: SchedulingRepository,
    private readonly inventory: ContractInventoryRepository,
    private readonly deviceTypes: DeviceTypeCatalogService,
  ) {}

  async execute(input: CreateManualSuggestionInput): Promise<TaskInventorySuggestionDto> {
    // 1) Verificar que el task existe
    const task = await this.scheduling.getTask(input.taskId);
    if (!task) throw new TaskNotFoundError(input.taskId);

    // 2) Validar tipo de dispositivo (DEVICE only)
    let resolvedType: string | null = null;
    if (input.kind === 'DEVICE') {
      const rawType = input.type ?? null;
      if (rawType != null && !(await this.deviceTypes.isValid(rawType))) {
        throw new InvalidItemTypeError(rawType);
      }
      resolvedType = rawType != null ? rawType.toUpperCase() : null;
    }

    // 3) Construir entidad con source='MANUAL', status='pending'
    const now = new Date().toISOString();
    const id = randomUUID();
    const suggestion = {
      id,
      taskId: input.taskId,
      kind: input.kind,
      deviceType: resolvedType,
      qwenDeviceType: null,
      serialNumber: input.serialNumber ?? null,
      // W2b: canonicalize MAC on create so it's stored as 'AA:BB:CC:DD:EE:FF'.
      // canonicalizeMac returns null for invalid/null inputs (no exception).
      mac: input.mac != null ? (canonicalizeMac(input.mac) ?? input.mac) : null,
      materialDesc: input.materialDesc ?? null,
      quantity: input.quantity ?? null,
      unit: input.unit ?? null,
      source: 'MANUAL',
      photoUrl: null,
      status: 'pending' as const,
      confirmedItemId: null,
      createdAt: now,
    };

    // 4) Validar completitud (fail-fast antes del insert)
    assertSuggestionComplete(suggestion);

    // 5) Persistir
    const saved = await this.suggestions.create(suggestion);

    // 6) Enriquecer con match (igual que ListTaskInventorySuggestions)
    const contractId = task.contractId ?? null;
    if (contractId == null) {
      return toTaskInventorySuggestionDto(saved, null);
    }
    const activeItems = (await this.inventory.listByContract(contractId)).filter(
      (i) => i.status === 'active',
    );
    const match = toSuggestionMatch(matchInstalledItem(saved, activeItems));
    return toTaskInventorySuggestionDto(saved, match);
  }
}
