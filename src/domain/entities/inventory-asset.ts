import { InvalidStatusTransitionError } from '@domain/errors/inventory';

export type AssetStatus = 'available' | 'installed' | 'removed' | 'damaged' | 'retired';

export const ASSET_STATUSES: readonly AssetStatus[] = [
  'available',
  'installed',
  'removed',
  'damaged',
  'retired',
];

/**
 * Mapa de transiciones válidas. `damaged`/`retired` son alcanzables desde cualquier
 * estado (vía ADJUST con status explícito). El resto sigue el ciclo INSTALL/RETURN/REMOVE.
 */
const TRANSITIONS: Record<AssetStatus, readonly AssetStatus[]> = {
  available: ['installed', 'damaged', 'retired'],
  installed: ['available', 'removed', 'damaged', 'retired'],
  removed: ['damaged', 'retired'],
  damaged: ['retired'],
  retired: [],
};

/**
 * Activo serializado unificado (ONU, router, antena, …). Reemplaza a
 * ContractInstalledItem como fuente de verdad de equipos individuales.
 */
export interface InventoryAsset {
  id: string;
  serialNumber: string;
  mac: string | null;
  deviceTypeId: string;
  status: AssetStatus;
  currentLocationId: string;
  source: string;
  sourceTaskId: string | null;
}

export interface CreateInventoryAssetInput {
  id: string;
  serialNumber: string;
  mac?: string | null;
  deviceTypeId: string;
  status: AssetStatus;
  currentLocationId: string;
  source: string;
  sourceTaskId?: string | null;
}

export function createInventoryAsset(input: CreateInventoryAssetInput): InventoryAsset {
  return {
    id: input.id,
    serialNumber: input.serialNumber,
    mac: input.mac ?? null,
    deviceTypeId: input.deviceTypeId,
    status: input.status,
    currentLocationId: input.currentLocationId,
    source: input.source,
    sourceTaskId: input.sourceTaskId ?? null,
  };
}

/**
 * Valida una transición de estado. Devuelve el `to` si es válida; lanza
 * InvalidStatusTransitionError si no lo es.
 */
export function nextStatus(from: AssetStatus, to: AssetStatus): AssetStatus {
  if (from === to) return to;
  if (!TRANSITIONS[from].includes(to)) {
    throw new InvalidStatusTransitionError(from, to);
  }
  return to;
}
