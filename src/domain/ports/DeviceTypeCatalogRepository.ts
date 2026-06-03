import { DeviceTypeCatalog } from '../entities/device-type-catalog';

export interface DeviceTypeCatalogRepository {
  list(): Promise<DeviceTypeCatalog[]>;
  getById(id: string): Promise<DeviceTypeCatalog | null>;
  getByName(name: string): Promise<DeviceTypeCatalog | null>;
  create(data: { name: string; label?: string | null; active?: boolean; sortOrder?: number }): Promise<DeviceTypeCatalog>;
  update(id: string, data: Partial<{ name: string; label: string | null; active: boolean; sortOrder: number }>): Promise<DeviceTypeCatalog | null>;
  delete(id: string): Promise<boolean>;
  /** How many ContractInstalledItem rows use this type NAME (delete guard). */
  countInUse(typeName: string): Promise<number>;
  /** Active type NAMES (UPPERCASE) — the valid set for OCR/confirm/route validation. */
  listActiveNames(): Promise<string[]>;
}
