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
 *
 * Per-entry API (REQ-CAT-2): callers upsert one entry at a time and then call
 * markInactiveExcept once with the full list of present codes.
 * Spec REQ-CAT-2 prefers per-entry over bulk for simplicity at this scale (~26 entries).
 */
export interface IClassSoTypeRepository {
  list(filter?: { active?: boolean }): Promise<IClassSoType[]>;
  getById(id: string): Promise<IClassSoType | null>;
  getByCode(code: string): Promise<IClassSoType | null>;
  /**
   * Upserts a single entry by `code`. Reactivates the row if it was `active=false`.
   * Returns the outcome status for the caller to aggregate counts.
   */
  upsertByCode(entry: UpsertSoTypeInput): Promise<{ status: 'created' | 'updated' | 'reactivated' }>;
  /**
   * Marks `active=false` every row whose `code` is NOT in `presentCodes`.
   * Returns the count of rows deactivated.
   */
  markInactiveExcept(presentCodes: string[]): Promise<number>;
}
