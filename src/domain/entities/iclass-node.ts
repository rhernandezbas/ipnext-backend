/**
 * Persisted catalog entry for an IClass node (microárea).
 * In Prominense, nodes ARE the cities — `code` is the value written to
 * NetworkSite.city / NetworkSite.iclassNodeCode when a node is assigned.
 *
 * `nodeId` (int, UNIQUE) is the IClass-side id and the upsert key — `code`
 * could in theory collide across renames, `nodeId` is stable.
 * `selectable=false` flags the 3 grouping nodes ("IPNEXT INTERNET", "Main",
 * "Argentina") that must not be assignable to a NetworkSite.
 */
export interface IClassNode {
  id: string;
  nodeId: number;
  code: string;
  description: string;
  active: boolean;
  selectable: boolean;
  lastSyncedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}
