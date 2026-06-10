import type { UispSite } from '@domain/entities/uisp';

export interface UispSiteRepository {
  upsert(site: UispSite): Promise<void>;
  listAll(): Promise<UispSite[]>;
  findByUispId(uispId: string): Promise<UispSite | null>;
  markMissing(uispIds: string[], since: Date): Promise<void>;
  clearMissing(uispIds: string[]): Promise<void>;
}
