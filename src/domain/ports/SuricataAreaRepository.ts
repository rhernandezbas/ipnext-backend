import type { SuricataAreaRecord, UpsertSuricataAreaInput } from '@domain/entities/suricata';

/**
 * D6.c — full-catalog refresh with soft delete. `deactivateMissing` NEVER
 * deletes a row (the `SuricataTicket.areaId` FK is `onDelete: SetNull`; a hard
 * delete would corrupt historical per-area KPIs).
 */
export interface SuricataAreaRepository {
  upsertMany(areas: UpsertSuricataAreaInput[]): Promise<SuricataAreaRecord[]>;
  /** Any active area whose `externalId` is NOT in `seenExternalIds` flips to `active=false`. */
  deactivateMissing(seenExternalIds: string[]): Promise<void>;
  list(): Promise<SuricataAreaRecord[]>;
  findByExternalId(externalId: string): Promise<SuricataAreaRecord | null>;
}
