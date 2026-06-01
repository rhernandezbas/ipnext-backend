import {
  GestionRealIngestConfigRepository,
  IngestConfig,
} from '@domain/ports/GestionRealIngestConfigRepository';
import { prisma } from '../../database/prisma';

/** The single config row is always keyed by this id (schema `@default("singleton")`). */
const SINGLETON_ID = 'singleton';

/** Hardcoded defaults returned before the singleton row exists (REQ-CFG-1). */
const DEFAULTS: IngestConfig = {
  intervalMs: 180000,
  windowMonths: 12,
  fiberProjectId: null,
  wirelessProjectId: null,
  sourceEstado: 'CONF',
};

interface ConfigRow {
  intervalMs: number;
  windowMonths: number;
  fiberProjectId: string | null;
  wirelessProjectId: string | null;
  sourceEstado: string;
}

function toConfig(row: ConfigRow): IngestConfig {
  return {
    intervalMs: row.intervalMs,
    windowMonths: row.windowMonths,
    fiberProjectId: row.fiberProjectId,
    wirelessProjectId: row.wirelessProjectId,
    sourceEstado: row.sourceEstado,
  };
}

/**
 * Prisma adapter for the single-row ingest config. Uses the `(prisma as any)`
 * accessor because the generated client is not regenerated locally for this
 * new table. `get()` returns defaults when the singleton row is absent;
 * `update()` upserts and returns the resulting full config.
 */
export class PrismaGestionRealIngestConfigRepository implements GestionRealIngestConfigRepository {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private get table(): any {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (prisma as any).gestionRealIngestConfig;
  }

  async get(): Promise<IngestConfig> {
    const row: ConfigRow | null = await this.table.findUnique({ where: { id: SINGLETON_ID } });
    return row ? toConfig(row) : { ...DEFAULTS };
  }

  async update(patch: Partial<IngestConfig>): Promise<IngestConfig> {
    // Build only the fields explicitly present so omitted keys are untouched.
    const data: Partial<IngestConfig> = {};
    if (patch.intervalMs !== undefined) data.intervalMs = patch.intervalMs;
    if (patch.windowMonths !== undefined) data.windowMonths = patch.windowMonths;
    if ('fiberProjectId' in patch) data.fiberProjectId = patch.fiberProjectId ?? null;
    if ('wirelessProjectId' in patch) data.wirelessProjectId = patch.wirelessProjectId ?? null;
    if (patch.sourceEstado !== undefined) data.sourceEstado = patch.sourceEstado;

    const row: ConfigRow = await this.table.upsert({
      where: { id: SINGLETON_ID },
      create: { id: SINGLETON_ID, ...DEFAULTS, ...data },
      update: data,
    });
    return toConfig(row);
  }
}
