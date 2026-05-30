import {
  GestionRealSyncConfigRepository,
  SyncConfig,
} from '@domain/ports/GestionRealSyncConfigRepository';
import { prisma } from '../../database/prisma';

/** The single config row is always keyed by this id (schema `@default("singleton")`). */
const SINGLETON_ID = 'singleton';

/** Hardcoded defaults returned before the singleton row exists (REQ-CFG-1). */
const DEFAULTS: SyncConfig = {
  intervalMs: 180000,
  estados: ['1', '2', '3', '4', '6'],
};

interface ConfigRow {
  intervalMs: number;
  /** Stored comma-joined, e.g. "1,2,3,4,6". */
  estados: string;
}

/** "1,2,3,4,6" → ["1","2","3","4","6"]; empty/whitespace → []. */
function parseEstados(raw: string): string[] {
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

/** ["1","6"] → "1,6". */
function joinEstados(estados: string[]): string {
  return estados.join(',');
}

function toConfig(row: ConfigRow): SyncConfig {
  return {
    intervalMs: row.intervalMs,
    estados: parseEstados(row.estados),
  };
}

/**
 * Prisma adapter for the single-row client-sync config. Uses the `(prisma as any)`
 * accessor because the generated client may not be regenerated locally for this
 * new table. `estados` is stored comma-joined and exposed as a `string[]`;
 * `get()` returns defaults when the singleton row is absent; `update()` upserts
 * and returns the resulting full config.
 */
export class PrismaGestionRealSyncConfigRepository implements GestionRealSyncConfigRepository {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private get table(): any {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (prisma as any).gestionRealSyncConfig;
  }

  async get(): Promise<SyncConfig> {
    const row: ConfigRow | null = await this.table.findUnique({ where: { id: SINGLETON_ID } });
    return row ? toConfig(row) : { intervalMs: DEFAULTS.intervalMs, estados: [...DEFAULTS.estados] };
  }

  async update(patch: Partial<SyncConfig>): Promise<SyncConfig> {
    // Build only the fields explicitly present so omitted keys are untouched.
    const data: { intervalMs?: number; estados?: string } = {};
    if (patch.intervalMs !== undefined) data.intervalMs = patch.intervalMs;
    if (patch.estados !== undefined) data.estados = joinEstados(patch.estados);

    const row: ConfigRow = await this.table.upsert({
      where: { id: SINGLETON_ID },
      create: {
        id: SINGLETON_ID,
        intervalMs: data.intervalMs ?? DEFAULTS.intervalMs,
        estados: data.estados ?? joinEstados(DEFAULTS.estados),
      },
      update: data,
    });
    return toConfig(row);
  }
}
