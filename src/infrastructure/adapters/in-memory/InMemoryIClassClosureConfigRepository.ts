import {
  IClassClosureConfig,
  IClassClosureConfigRepository,
} from '@domain/ports/IClassClosureConfigRepository';

/** Hardcoded defaults returned before any row is persisted (spec scenario 1). */
const DEFAULTS: IClassClosureConfig = {
  closureIntervalMs: 600000,
  autocompleteIntervalMs: 900000,
};

/**
 * In-memory implementation of the IClass closure config. Mirrors the Prisma
 * adapter's contract: `get()` returns defaults until something is persisted,
 * `update()` merges a partial patch and returns the resulting full config.
 */
export class InMemoryIClassClosureConfigRepository implements IClassClosureConfigRepository {
  private config: IClassClosureConfig | null = null;

  async get(): Promise<IClassClosureConfig> {
    const current = this.config ?? DEFAULTS;
    return { closureIntervalMs: current.closureIntervalMs, autocompleteIntervalMs: current.autocompleteIntervalMs };
  }

  async update(patch: Partial<IClassClosureConfig>): Promise<IClassClosureConfig> {
    const current = this.config ?? DEFAULTS;
    this.config = {
      closureIntervalMs: patch.closureIntervalMs ?? current.closureIntervalMs,
      autocompleteIntervalMs: patch.autocompleteIntervalMs ?? current.autocompleteIntervalMs,
    };
    return { closureIntervalMs: this.config.closureIntervalMs, autocompleteIntervalMs: this.config.autocompleteIntervalMs };
  }
}
