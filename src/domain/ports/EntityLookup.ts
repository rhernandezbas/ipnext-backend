/**
 * Minimal lookup interface used by FK validation in use cases.
 * Any repository with a findById method satisfies this port.
 *
 * `name` is OPTIONAL: lookups that can resolve a display name (e.g. the user
 * lookup) return it so callers can record human-readable diffs (watcher names in
 * the activity log, #17). Lookups that don't simply omit it — backward-compatible.
 */
export interface EntityLookup {
  findById(id: string): Promise<{ id: string; name?: string } | null>;
}
