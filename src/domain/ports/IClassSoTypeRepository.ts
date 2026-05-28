import { IClassSoType } from '@domain/entities/iclass-so-type';

export interface UpsertSoTypeInput {
  code: string;
  description: string;
}

export interface SyncSummary {
  created: number;
  updated: number;
  /** Rows that were active=false and reappeared in the latest sync. */
  reactivated: number;
  /** Rows deactivated (marked active=false) because they disappeared from IClass. */
  deactivated: number;
}

/**
 * Port for persisting the IClass Service Order type catalog.
 * Application layer only depends on this interface — never on a Prisma model.
 */
export interface IClassSoTypeRepository {
  list(filter?: { active?: boolean }): Promise<IClassSoType[]>;
  getById(id: string): Promise<IClassSoType | null>;
  getByCode(code: string): Promise<IClassSoType | null>;
  /**
   * Upserts each item by `code`. Reactivates rows that were `active=false` if
   * they reappear. Returns counts of created / updated / reactivated rows.
   */
  upsertMany(items: UpsertSoTypeInput[], now: Date): Promise<{ created: number; updated: number; reactivated: number }>;
  /**
   * Marks `active=false` every row whose `code` is NOT in `presentCodes`.
   * Returns the count of rows deactivated.
   */
  deactivateMissing(presentCodes: string[]): Promise<number>;
}
