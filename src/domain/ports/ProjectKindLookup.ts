/**
 * #40 — Project lookup that also resolves the network-project flag.
 *
 * Widened sibling of EntityLookup used by CreateTask's project FK slot: a single
 * findById both verifies project existence AND returns `isNetworkProject`, so the
 * symmetric project↔kind guard runs from ONE query (no N+1).
 *
 * The returned shape is a SUPERSET of EntityLookup's `{ id }`, so any lookup that
 * satisfies ProjectKindLookup also satisfies EntityLookup.
 */
export interface ProjectKindLookup {
  findById(id: string): Promise<{ id: string; isNetworkProject: boolean } | null>;
}
