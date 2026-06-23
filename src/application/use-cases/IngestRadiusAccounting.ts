/**
 * IngestRadiusAccounting — caso de uso de ingest (application layer).
 *
 * Consume `RadiusOrchestratorGateway.listAccounting` paginando hasta agotar,
 * resuelve nasId por nasIpAddress y hace upsert idempotente en RadiusEventRepository.
 * Al final purga eventos viejos vía deleteOlderThan.
 *
 * Dependencias: solo ports de @domain — NUNCA importa de @infrastructure.
 *
 * Design.md AD-2: cursor = watermark en acctstarttime + re-scan window de 2h.
 * Design.md AD-7: cursor almacenado en SyncState (entity 'radius-accounting-ingest').
 * Design.md REQ-INGEST-4: nasId resuelto una vez por run (map nasIp→nasId).
 * Design.md REQ-PURGE-1: purga al final del ciclo, best-effort.
 */
import type { RadiusOrchestratorGateway, AccountingEventRow } from '@domain/ports/RadiusOrchestratorGateway';
import type { RadiusEventRepository, RadiusEventUpsert } from '@domain/ports/RadiusEventRepository';
import type { NasRepository } from '@domain/ports/NasRepository';
import type { SyncStateRepository } from '@domain/ports/SyncStateRepository';

export interface IngestRadiusAccountingOptions {
  /** Ventana de re-escaneo hacia atrás (milisegundos). Default 2h. */
  reScanWindowMs?: number;
  /** Meses de retención para purga. Default 12. */
  retentionMonths?: number;
  /** Tamaño de batch para la purga. Default 10000. */
  purgeBatchSize?: number;
  /**
   * FIX6: máxima cantidad de batches de purga por tick.
   * Evita que un primer run cargado trague todo el backlog bajo el lock y starve la ingesta.
   * Default: sin límite (undefined → purga todo).
   */
  maxBatchesPerTick?: number;
  /** Filas por página al consultar el orchestrator. Default 500. */
  pageSize?: number;
  /** Proveedor de now() para tests. */
  now?: () => Date;
}

export interface IngestRunResult {
  upserted: number;
  pages: number;
  purgedRows: number;
  newCursor: string | null;
}

const ENTITY_KEY = 'radius-accounting-ingest';
const DEFAULT_RE_SCAN_WINDOW_MS = 2 * 60 * 60 * 1000; // 2h
const DEFAULT_RETENTION_MONTHS  = 12;
const DEFAULT_PURGE_BATCH       = 10_000;
const DEFAULT_PAGE_SIZE         = 500;

export class IngestRadiusAccounting {
  private readonly reScanWindowMs:   number;
  private readonly retentionMonths:  number;
  private readonly purgeBatchSize:   number;
  private readonly maxBatchesPerTick: number | undefined;
  private readonly pageSize:         number;
  private readonly now:              () => Date;

  constructor(
    private readonly gateway:    RadiusOrchestratorGateway,
    private readonly eventRepo:  RadiusEventRepository,
    private readonly nasRepo:    NasRepository,
    private readonly stateRepo:  SyncStateRepository,
    opts: IngestRadiusAccountingOptions = {},
  ) {
    this.reScanWindowMs    = opts.reScanWindowMs    ?? DEFAULT_RE_SCAN_WINDOW_MS;
    this.retentionMonths   = opts.retentionMonths   ?? DEFAULT_RETENTION_MONTHS;
    this.purgeBatchSize    = opts.purgeBatchSize    ?? DEFAULT_PURGE_BATCH;
    this.maxBatchesPerTick = opts.maxBatchesPerTick;
    this.pageSize          = opts.pageSize          ?? DEFAULT_PAGE_SIZE;
    this.now               = opts.now               ?? (() => new Date());
  }

  async run(): Promise<IngestRunResult> {
    // 1. Leer cursor (watermark en lastUpdate/acctupdatetime) de SyncState
    // FIX2: cursor = max(lastUpdate), NO max(startedAt). Esto permite que sesiones
    // con startedAt antiguo pero que cerraron recientemente entren en la ventana de re-scan.
    const state  = await this.stateRepo.get(ENTITY_KEY);
    const cursor = state?.cursor ?? null;

    // 2. Calcular sinceUpdate = cursor - reScanWindow (o sin filtro si nunca corrio)
    // FIX2: filtro sobre acctupdatetime (sinceUpdate), no sobre acctstarttime (sinceStart)
    let sinceUpdate: string | undefined;
    if (cursor) {
      const cursorMs = new Date(cursor).getTime();
      const since    = new Date(cursorMs - this.reScanWindowMs);
      sinceUpdate    = since.toISOString();
    }

    // 3. Precargar mapa nasIp->nasId una vez por run
    const nasMap = await this.buildNasMap();

    // 4. Paginar y hacer upsert
    let page        = 1;
    let totalUpsert = 0;
    let pageCount   = 0;
    // FIX2: cursor avanza por max(lastUpdate), no por max(startedAt)
    let maxLastUpdate: string | null = cursor;

    while (true) {
      const accounting = await this.gateway.listAccounting({
        sinceUpdate,
        page,
        pageSize: this.pageSize,
      });

      if (accounting.items.length > 0) {
        const rows = accounting.items.map(item => this.toUpsert(item, nasMap));
        totalUpsert += await this.eventRepo.upsertMany(rows);
        pageCount++;

        // FIX2: avanzar watermark al mayor lastUpdate visto (fallback a startedAt si no hay lastUpdate)
        for (const item of accounting.items) {
          const ts = item.lastUpdate ?? item.startedAt;
          if (maxLastUpdate === null || ts > maxLastUpdate) {
            maxLastUpdate = ts;
          }
        }
      }

      if (accounting.nextPage === null) break;
      page = accounting.nextPage;
    }

    // 5. Guardar cursor y estado
    await this.stateRepo.save({
      entity:      ENTITY_KEY,
      cursor:      maxLastUpdate,
      lastRunAt:   this.now(),
      lastResult:  'ok',
      itemsSynced: totalUpsert,
    });

    // 6. Purga best-effort
    // FIX6: maxBatchesPerTick limita cuántos lotes de purga se ejecutan por tick para que
    // el primer run con backlog grande no starve la ingesta ni mantenga el lock demasiado tiempo.
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
        // Si el repo borro menos que el batchSize, no hay mas para borrar → stop.
        if (deleted < this.purgeBatchSize) break;
      }
    } catch {
      // Best-effort: error en purga no aborta el ingest
    }

    return {
      upserted:  totalUpsert,
      pages:     pageCount,
      purgedRows,
      newCursor: maxLastUpdate,
    };
  }

  // -- Helpers privados -------------------------------------------------------

  private toUpsert(item: AccountingEventRow, nasMap: Map<string, string>): RadiusEventUpsert {
    const stoppedAt = item.stoppedAt ? new Date(item.stoppedAt) : null;
    return {
      sourceUniqueId: item.uniqueId,
      username:       item.username,
      nasIpAddress:   item.nasIpAddress,
      nasId:          nasMap.get(item.nasIpAddress) ?? null,
      framedIp:       item.framedIp,
      macAddress:     item.macAddress,
      vlanId:         item.vlan,
      startedAt:      new Date(item.startedAt),
      stoppedAt,
      sessionTime:    item.sessionTime,
      bytesIn:        item.inOctets,
      bytesOut:       item.outOctets,
      eventType:      stoppedAt ? 'stop' : 'start',
      status:         stoppedAt ? 'closed' : 'online',
    };
  }

  private async buildNasMap(): Promise<Map<string, string>> {
    const servers = await this.nasRepo.findAllNasServers();
    const map = new Map<string, string>();
    for (const s of servers) {
      if (s.nasIpAddress) map.set(s.nasIpAddress, s.id);
    }
    return map;
  }

  private retentionCutoff(now: Date): Date {
    const d = new Date(now);
    d.setMonth(d.getMonth() - this.retentionMonths);
    return d;
  }
}
