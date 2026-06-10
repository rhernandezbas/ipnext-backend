import type { UispDevice } from '@domain/entities/uisp';

export interface UispDeviceRepository {
  upsert(device: UispDevice): Promise<void>;
  /** List all devices regardless of site (FIX-6d: catches orphaned devices). */
  listAll(): Promise<UispDevice[]>;
  listBySiteId(uispSiteId: string): Promise<UispDevice[]>;
  findByUispId(uispId: string): Promise<UispDevice | null>;
  markMissing(uispIds: string[], since: Date): Promise<void>;
  clearMissing(uispIds: string[]): Promise<void>;
}
