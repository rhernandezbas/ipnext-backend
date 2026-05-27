import { GestionRealPort, FetchClientsParams } from '@domain/ports/GestionRealPort';
import { ClientMirrorRepository } from '@domain/ports/ClientMirrorRepository';
import { SyncStateRepository } from '@domain/ports/SyncStateRepository';

const SYNC_ENTITY = 'gr-clients';
const DEFAULT_PAGE_SIZE = 100;

export interface SyncRunResult {
  mode: 'backfill' | 'delta';
  fetched: number;
  created: number;
  updated: number;
  /** Watermark persisted after this run (DD-MM-AAAA). */
  cursor: string;
  /** GR client ids touched this run — fed to the contracts sync. */
  touchedClientIds: string[];
}

export interface SyncOptions {
  now?: () => Date;
  pageSize?: number;
  /**
   * GR estado codes to sync (1=Activo, 2=Deudor, 3=Inactivo, 4=Incobrable, 6=Baja).
   * Omit/empty → a single unfiltered scan (all estados).
   */
  estados?: string[];
}

/**
 * Pulls clients from Gestión Real into the local mirror.
 *
 * - First run (no cursor) → full backfill, paginated, no date filter.
 * - Subsequent runs → delta by modification date (fecha_tipo=m) starting from
 *   the previous run's date. The re-scan from the last day is intentional:
 *   GR's delta is day-granular, and upserts are idempotent, so a small overlap
 *   guarantees we never miss a same-day change.
 */
export class SyncGestionRealClients {
  private readonly now: () => Date;
  private readonly pageSize: number;
  private readonly estados: (string | undefined)[];

  constructor(
    private readonly gr: GestionRealPort,
    private readonly mirror: ClientMirrorRepository,
    private readonly state: SyncStateRepository,
    opts: SyncOptions = {},
  ) {
    this.now = opts.now ?? (() => new Date());
    this.pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
    // Each segment is queried independently; undefined means "no estado filter".
    this.estados = opts.estados && opts.estados.length > 0 ? opts.estados : [undefined];
  }

  async execute(): Promise<SyncRunResult> {
    const prior = await this.state.get(SYNC_ENTITY);
    const mode: 'backfill' | 'delta' = prior?.cursor ? 'delta' : 'backfill';
    const runDate = formatGrDate(this.now());

    let fetched = 0;
    let created = 0;
    let updated = 0;
    const touchedClientIds: string[] = [];

    try {
      // Each estado segment is paginated independently from offset 0.
      for (const estado of this.estados) {
        let offset = 0;
        // total is read from each response and used as the upper bound.
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const params: FetchClientsParams = { cantidad: this.pageSize, offset };
          if (estado) params.estado = estado;
          if (mode === 'delta' && prior?.cursor) {
            params.fechaTipo = 'm';
            params.fechaDesde = prior.cursor;
            params.fechaHasta = runDate;
          }
          const { total, clients } = await this.gr.fetchClients(params);
          for (const client of clients) {
            const { created: wasCreated } = await this.mirror.upsertClient(client);
            if (wasCreated) created++; else updated++;
            touchedClientIds.push(client.grClienteId);
            fetched++;
          }
          offset += this.pageSize;
          if (clients.length === 0 || offset >= total) break;
        }
      }
    } catch (err) {
      await this.state.save({
        entity: SYNC_ENTITY,
        cursor: prior?.cursor ?? null,
        lastRunAt: this.now(),
        lastResult: `error: ${(err as Error).message}`,
        itemsSynced: fetched,
      });
      throw err;
    }

    await this.state.save({
      entity: SYNC_ENTITY,
      cursor: runDate,
      lastRunAt: this.now(),
      lastResult: 'ok',
      itemsSynced: fetched,
    });

    return { mode, fetched, created, updated, cursor: runDate, touchedClientIds };
  }
}

/** Date → "DD-MM-AAAA" (GR's expected delta format). */
function formatGrDate(d: Date): string {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}-${mm}-${d.getFullYear()}`;
}
