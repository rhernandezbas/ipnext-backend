import { IClassNode } from '@domain/entities/iclass-node';

export interface UpsertNodeInput {
  nodeId: number;
  code: string;
  description: string;
  /** false for grouping nodes (IPNEXT INTERNET / Main / Argentina). */
  selectable: boolean;
}

/**
 * Port for persisting the IClass node catalog.
 * Application layer only depends on this interface — never on a Prisma model.
 *
 * Per-entry API: callers upsert one node at a time (by `nodeId`) and then call
 * markInactiveExcept once with the full list of present nodeIds. Mirrors the
 * IClassSoTypeRepository contract.
 */
export interface IClassNodeRepository {
  list(filter?: { active?: boolean; selectable?: boolean }): Promise<IClassNode[]>;
  getById(id: string): Promise<IClassNode | null>;
  /**
   * Upserts a single node by `nodeId`. Reactivates the row if it was `active=false`.
   * Returns the outcome status for the caller to aggregate counts.
   */
  upsertByNodeId(node: UpsertNodeInput): Promise<{ status: 'created' | 'updated' | 'reactivated' }>;
  /**
   * Marks `active=false` every row whose `nodeId` is NOT in `presentNodeIds`.
   * Returns the count of rows deactivated.
   */
  markInactiveExcept(presentNodeIds: number[]): Promise<number>;
}
