/**
 * Persisted config for the IClass closure-loop and task-autocomplete schedulers.
 * Backed by a single-row table; `get()` returns hardcoded defaults when no row exists.
 */
export interface IClassClosureConfig {
  /** IClass closure-loop scheduler tick interval in ms. Default: 600000 (10 min). */
  closureIntervalMs: number;
  /** Task-autocomplete scheduler tick interval in ms. Default: 900000 (15 min). */
  autocompleteIntervalMs: number;
}

/**
 * Port for reading/updating the IClass closure config.
 * Application layer depends on this; Prisma/InMemory adapters implement it.
 */
export interface IClassClosureConfigRepository {
  /** Current config; returns defaults if no row has been persisted yet. */
  get(): Promise<IClassClosureConfig>;
  /** Apply a partial patch and return the resulting full config. Omitted fields are untouched. */
  update(patch: Partial<IClassClosureConfig>): Promise<IClassClosureConfig>;
}
