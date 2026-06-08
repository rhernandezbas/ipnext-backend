import {
  IClassClosureConfig,
  IClassClosureConfigRepository,
} from '@domain/ports/IClassClosureConfigRepository';
import { prisma } from '../../database/prisma';

/** The single config row is always keyed by this id (schema `@default("singleton")`). */
const SINGLETON_ID = 'singleton';

/** Hardcoded defaults returned before the singleton row exists (spec scenario 1). */
const DEFAULTS: IClassClosureConfig = {
  closureIntervalMs: 600000,
  autocompleteIntervalMs: 900000,
};

/**
 * Prisma adapter for the single-row IClass closure config. Uses `(prisma as any)`
 * because the generated client may not be regenerated locally for this new table.
 * `get()` returns defaults when the singleton row is absent; `update()` upserts
 * and returns the resulting full config.
 */
export class PrismaIClassClosureConfigRepository implements IClassClosureConfigRepository {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private get table(): any {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (prisma as any).iClassClosureConfig;
  }

  async get(): Promise<IClassClosureConfig> {
    const row: IClassClosureConfig | null = await this.table.findUnique({ where: { id: SINGLETON_ID } });
    return row
      ? { closureIntervalMs: row.closureIntervalMs, autocompleteIntervalMs: row.autocompleteIntervalMs }
      : { ...DEFAULTS };
  }

  async update(patch: Partial<IClassClosureConfig>): Promise<IClassClosureConfig> {
    const data: Partial<IClassClosureConfig> = {};
    if (patch.closureIntervalMs !== undefined) data.closureIntervalMs = patch.closureIntervalMs;
    if (patch.autocompleteIntervalMs !== undefined) data.autocompleteIntervalMs = patch.autocompleteIntervalMs;

    const row: IClassClosureConfig = await this.table.upsert({
      where: { id: SINGLETON_ID },
      create: {
        id: SINGLETON_ID,
        closureIntervalMs: data.closureIntervalMs ?? DEFAULTS.closureIntervalMs,
        autocompleteIntervalMs: data.autocompleteIntervalMs ?? DEFAULTS.autocompleteIntervalMs,
      },
      update: data,
    });
    return { closureIntervalMs: row.closureIntervalMs, autocompleteIntervalMs: row.autocompleteIntervalMs };
  }
}
