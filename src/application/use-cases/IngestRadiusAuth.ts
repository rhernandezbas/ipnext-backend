/**
 * IngestRadiusAuth — caso de uso de ingest de eventos de autenticación RADIUS (application layer).
 *
 * Espejo de IngestRadiusAccounting, simplificado: no hay NAS map (postauth no trae nasipaddress).
 * Consume `RadiusOrchestratorGateway.listPostauth` paginando hasta agotar, hace upsert idempotente
 * en RadiusAuthEventRepository (por sourceUniqueId) y al final purga eventos viejos best-effort.
 *
 * Dependencias: solo ports de @domain — NUNCA importa de @infrastructure.
 *
 * Cursor = watermark sobre authdate + re-scan window (default 2h). Almacenado en SyncState
 * (entity 'radius-auth-ingest').
 */
import type { RadiusOrchestratorGateway, AuthEventRow } from '@domain/ports/RadiusOrchestratorGateway';
import type { RadiusAuthEventRepository, RadiusAuthEventUpsert } from '@domain/ports/RadiusAuthEventRepository';
import type { SyncStateRepository } from '@domain/ports/SyncStateRepository';
import type { RadiusAuthReply } from '@domain/entities/radius-auth-event';

export interface IngestRadiusAuthOptions {
  /** Ventana de re-escaneo hacia atrás (milisegundos). Default 2h. */
  reScanWindowMs?: number;
  /** Meses de retención para purga. Default 12. */
  retentionMonths?: number;
  /** Tamaño de batch para la purga. Default 10000. */
  purgeBatchSize?: number;
  /**
   * Máxima cantidad de batches de purga por tick.
   * Evita que un primer run cargado trague todo el backlog bajo el lock y starve la ingesta.
   * Default: sin límite (undefined → purga todo).
   */
  maxBatchesPerTick?: number;
  /** Filas por página al consultar el orchestrator. Default 500. */
  pageSize?: number;
  /** Proveedor de now() para tests. */
  now?: () => Date;
}

export interface IngestAuthRunResult {
  upserted: number;
  pages: number;
  purgedRows: number;
  newCursor: string | null;
}

const ENTITY_KEY = 'radius-auth-ingest';
const DEFAULT_RE_SCAN_WINDOW_MS = 2 * 60 * 60 * 1000; // 2h
const DEFAULT_RETENTION_MONTHS  = 12;
const DEFAULT_PURGE_BATCH       = 10_000;
const DEFAULT_PAGE_SIZE         = 500;

export class IngestRadiusAuth {
  private readonly reScanWindowMs:    number;
  private readonly retentionMonths:   number;
  private readonly purgeBatchSize:    number;
  private readonly maxBatchesPerTick: number | undefined;
  private readonly pageSize:          number;
  private readonly now:               () => Date;

  constructor(
    private readonly gateway:   RadiusOrchestratorGateway,
    private readonly eventRepo: RadiusAuthEventRepository,
    private readonly stateRepo: SyncStateRepository,
    opts: IngestRadiusAuthOptions = {},
  ) {
    this.reScanWindowMs    = opts.reScanWindowMs    ?? DEFAULT_RE_SCAN_WINDOW_MS;
    this.retentionMonths   = opts.retentionMonths   ?? DEFAULT_RETENTION_MONTHS;
    this.purgeBatchSize    = opts.purgeBatchSize    ?? DEFAULT_PURGE_BATCH;
    this.maxBatchesPerTick = opts.maxBatchesPerTick;
    this.pageSize          = opts.pageSize          ?? DEFAULT_PAGE_SIZE;
    this.now               = opts.now               ?? (() => new Date());
  }

  async run(): Promise<IngestAuthRunResult> {
    // 1. Leer cursor (watermark en authdate) de SyncState.
    const state  = await this.stateRepo.get(ENTITY_KEY);
    const cursor = state?.cursor ?? null;

    // 2. Calcular sinceAuthdate = cursor - reScanWindow (o sin filtro si nunca corrió).
    let sinceAuthdate: string | undefined;
    if (cursor) {
      const cursorMs = new Date(cursor).getTime();
      const since    = new Date(cursorMs - this.reScanWindowMs);
      sinceAuthdate  = since.toISOString();
    }

    // 3. Paginar y hacer upsert.
    let page         = 1;
    let totalUpsert  = 0;
    let pageCount    = 0;
    let maxAuthdate: string | null = cursor;

    while (true) {
      const postauth = await this.gateway.listPostauth({
        sinceAuthdate,
        page,
        pageSize: this.pageSize,
      });

      if (postauth.items.length > 0) {
        const rows = postauth.items.map(item => this.toUpsert(item));
        totalUpsert += await this.eventRepo.upsertMany(rows);
        pageCount++;

        // Avanzar watermark al mayor authdate visto.
        for (const item of postauth.items) {
          const ts = item.authdate;
          if (maxAuthdate === null || ts > maxAuthdate) {
            maxAuthdate = ts;
          }
        }
      }

      if (postauth.nextPage === null) break;
      page = postauth.nextPage;
    }

    // 4. Guardar cursor y estado.
    await this.stateRepo.save({
      entity:      ENTITY_KEY,
      cursor:      maxAuthdate,
      lastRunAt:   this.now(),
      lastResult:  'ok',
      itemsSynced: totalUpsert,
    });

    // 5. Purga best-effort.
    let purgedRows = 0;
    try {
      const nowDate  = this.now();
      const cutoff   = this.retentionCutoff(nowDate);
      const maxBatch = this.maxBatchesPerTick ?? Infinity;
      let batch = 0;
      while (batch < maxBatch) {
        const deleted = await this.eventRepo.deleteOlderThan(cutoff, this.purgeBatchSize);
        purgedRows += deleted;
        batch++;
        if (deleted < this.purgeBatchSize) break;
      }
    } catch {
      // Best-effort: error en purga no aborta el ingest.
    }

    return {
      upserted:  totalUpsert,
      pages:     pageCount,
      purgedRows,
      newCursor: maxAuthdate,
    };
  }

  // -- Helpers privados -------------------------------------------------------

  private toUpsert(item: AuthEventRow): RadiusAuthEventUpsert {
    return {
      sourceUniqueId: item.sourceId,
      username:       item.username,
      reply:          item.reply as RadiusAuthReply,
      authdate:       new Date(item.authdate),
      class:          item.class,
    };
  }

  private retentionCutoff(now: Date): Date {
    const d = new Date(now);
    d.setMonth(d.getMonth() - this.retentionMonths);
    return d;
  }
}
