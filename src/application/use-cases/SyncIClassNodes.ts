import { IClassPort } from '@domain/ports/IClassPort';
import { IClassNodeRepository } from '@domain/ports/IClassNodeRepository';

export interface SyncNodesResult {
  /** Total nodes processed (upserted) from IClass after discarding empty codes. */
  synced: number;
  created: number;
  updated: number;
  reactivated: number;
  deactivated: number;
}

/**
 * Grouping nodes in the IClass tree — they are organizational containers, not
 * assignable cities. Persisted (audit) but flagged `selectable=false`.
 */
export const NON_SELECTABLE_NODE_CODES = ['IPNEXT INTERNET', 'Main', 'Argentina'];

/**
 * Syncs the IClass node catalog into the local repository (REQ-NCAT-1).
 *
 * Flow:
 * 1. Fetch all nodes from IClass via listNodes().
 * 2. Discard nodes whose `code` is empty after trimming.
 * 3. Upsert each by `nodeId`, marking grouping codes as selectable=false.
 * 4. Mark inactive every node NOT present in the IClass response.
 *
 * Throws IClassUnavailableError if IClass is unreachable (propagated from the port).
 */
export class SyncIClassNodes {
  constructor(
    private readonly iclass: IClassPort,
    private readonly repo: IClassNodeRepository,
  ) {}

  async execute(): Promise<SyncNodesResult> {
    const descriptors = await this.iclass.listNodes();

    const present = descriptors
      .map(d => ({ nodeId: d.nodeId, code: d.code.trim(), description: d.description.trim() }))
      .filter(d => d.code.length > 0);

    let created = 0;
    let updated = 0;
    let reactivated = 0;

    for (const node of present) {
      const selectable = !NON_SELECTABLE_NODE_CODES.includes(node.code);
      const { status } = await this.repo.upsertByNodeId({
        nodeId: node.nodeId,
        code: node.code,
        description: node.description,
        selectable,
      });
      if (status === 'created') created++;
      else if (status === 'updated') updated++;
      else if (status === 'reactivated') reactivated++;
    }

    const presentNodeIds = present.map(n => n.nodeId);
    const deactivated = await this.repo.markInactiveExcept(presentNodeIds);

    return {
      synced: present.length,
      created,
      updated,
      reactivated,
      deactivated,
    };
  }
}
