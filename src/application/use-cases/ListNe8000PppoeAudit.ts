/**
 * ListNe8000PppoeAudit — caso de uso de lectura (read-only).
 *
 * Padrón de PPPoE que terminan en el NE8000 BRAS, enriquecido con la última
 * conexión desde RadiusEvent (AD-4: on-read, sin N+1).
 *
 * REQ-LOOKUP: el NE8000 se resuelve por nasIpAddress (inyectada, NUNCA hardcodear en este archivo).
 * REQ-UC-3: lastEventByUsername = UNA sola query para todos los usernames del lote.
 * REQ-UC-2: orden default username ASC.
 * REQ-DTO-2: password no aparece en el DTO.
 */
import { PppoeServiceRepository } from '@domain/ports/PppoeServiceRepository';
import { RadiusEventRepository, LastConnectionSummary } from '@domain/ports/RadiusEventRepository';
import { NasRepository } from '@domain/ports/NasRepository';
import { PppoeService } from '@domain/entities/pppoeService';
import { Ne8000AuditRowDto, PaginatedNe8000AuditDto } from '@application/dto/radius-event.dto';

/**
 * IP default del NE8000 en radacct — confirmado en Phase 0 (2026-06-22).
 * FIX8: Exportada para que config.ts (infra) la use como fallback sin importar desde infra.
 * En producción, config.ts lee NE8000_NAS_IP env var y la inyecta vía constructor.
 */
export const DEFAULT_NE8000_NAS_IP = '10.75.0.30';

const DEFAULT_LIMIT  = 50;
const MAX_LIMIT      = 200;
const DEFAULT_PAGE   = 1;

/** FIX9: límite de seguridad para el filtro online (carga sin paginar para filtrar post-enriq). */
export const ONLINE_FILTER_MAX_ROWS = 10_000;

export interface ListNe8000PppoeAuditInput {
  username?: string;
  status?: string;
  enforcedState?: string;
  /** Filtro derivado: true → solo con RadiusEvent activo; false → sin RadiusEvent activo */
  online?: boolean;
  page?: number;
  limit?: number;
}

export class ListNe8000PppoeAudit {
  /** IP del NAS NE8000 BRAS (inyectada por infraestructura, default a env-safe fallback). */
  private readonly ne8000NasIp: string;

  constructor(
    private readonly pppoeRepo:   PppoeServiceRepository,
    private readonly radiusRepo:  RadiusEventRepository,
    private readonly nasRepo:     NasRepository,
    /** FIX8: IP del NE8000 inyectable desde config.ts (NE8000_NAS_IP env var). Default = '10.75.0.30'. */
    ne8000NasIp?: string,
  ) {
    this.ne8000NasIp = ne8000NasIp ?? DEFAULT_NE8000_NAS_IP;
  }

  async execute(input: ListNe8000PppoeAuditInput): Promise<PaginatedNe8000AuditDto> {
    const page     = Math.max(1, input.page ?? DEFAULT_PAGE);
    const limit    = Math.min(MAX_LIMIT, Math.max(1, input.limit ?? DEFAULT_LIMIT));
    const pageSize = limit;

    // 1. Resolver NE8000 por nasIpAddress inyectada (NUNCA hardcodear UUID)
    const ne8000 = await this.nasRepo.findNasServerByNasIp(this.ne8000NasIp);
    if (!ne8000) {
      return { data: [], total: 0, page, limit, hasNext: false };
    }

    // 2. Listar PPPoE del NE8000 (paginado + filtros básicos)
    //    Nota: si online filter está activo, traemos sin paginar para poder filtrar
    //    post-enriquecimiento. Para el caso sin filtro online, pagina el repo directamente.
    const wantsOnlineFilter = input.online !== undefined;

    if (wantsOnlineFilter) {
      // Cargar todos para filtrar post-enriquecimiento (el filtro online es derivado)
      return this.executeWithOnlineFilter(ne8000.id, input, page, limit, pageSize);
    }

    const { data: pppoeList, total } = await this.pppoeRepo.findByNasIdPaginated({
      nasId:         ne8000.id,
      page,
      pageSize,
      username:      input.username,
      status:        input.status,
      enforcedState: input.enforcedState,
    });

    if (pppoeList.length === 0) {
      return { data: [], total, page, limit, hasNext: false };
    }

    // 3. Enriquecimiento: UNA query para todos los usernames del lote (AD-4, no N+1)
    const usernames = pppoeList.map(p => p.username);
    const lastEventMap = await this.radiusRepo.lastEventByUsername(ne8000.id, usernames);

    const data = pppoeList.map(p => toDto(p, lastEventMap.get(p.username)));

    return {
      data,
      total,
      page,
      limit,
      hasNext: page * pageSize < total,
    };
  }

  /**
   * Caso especial: filtro `online` requiere enriquecimiento primero, filtro después.
   * FIX9: Usa ONLINE_FILTER_MAX_ROWS (constante) en lugar de 99999 (magic number).
   * Si hay truncado (pppoeList.length === ONLINE_FILTER_MAX_ROWS), se informa en hasNext=true
   * y total refleja solo los datos cargados (honesto con el cliente).
   */
  private async executeWithOnlineFilter(
    nasId: string,
    input: ListNe8000PppoeAuditInput,
    page: number,
    limit: number,
    pageSize: number,
  ): Promise<PaginatedNe8000AuditDto> {
    // FIX9: pageSize acotado por constante, no por magic number
    const { data: pppoeList } = await this.pppoeRepo.findByNasIdPaginated({
      nasId,
      page:          1,
      pageSize:      ONLINE_FILTER_MAX_ROWS,
      username:      input.username,
      status:        input.status,
      enforcedState: input.enforcedState,
    });

    if (pppoeList.length === 0) {
      return { data: [], total: 0, page, limit, hasNext: false };
    }

    // Enriquecimiento UNA query (no N+1)
    const usernames = pppoeList.map(p => p.username);
    const lastEventMap = await this.radiusRepo.lastEventByUsername(nasId, usernames);

    // Filtrar por online después del enriquecimiento
    const all = pppoeList
      .map(p => toDto(p, lastEventMap.get(p.username)))
      .filter(dto => input.online === true ? dto.currentlyOnline : !dto.currentlyOnline);

    const total = all.length;
    const skip  = (page - 1) * pageSize;
    const data  = all.slice(skip, skip + pageSize);

    // FIX9: hasNext honesto. Si cargamos exactamente ONLINE_FILTER_MAX_ROWS es posible que
    // haya más (truncado). En ese caso hasNext=true incluso si la paginación de los filtrados
    // dice que ya terminó, para alertar al cliente.
    const truncated = pppoeList.length === ONLINE_FILTER_MAX_ROWS;
    const hasNext   = page * pageSize < total || (truncated && skip + pageSize >= total);

    return {
      data,
      total,
      page,
      limit,
      hasNext,
    };
  }
}

// ── mapper ───────────────────────────────────────────────────────────────────────

function toDto(pppoe: PppoeService, summary: LastConnectionSummary | undefined): Ne8000AuditRowDto {
  return {
    pppoeId:        pppoe.id,
    username:       pppoe.username,
    profile:        pppoe.profile,
    remoteAddress:  pppoe.remoteAddress,
    macAddress:     pppoe.callerId,        // última MAC conocida (persistida)
    status:         pppoe.status,
    enforcedState:  pppoe.enforcedState,
    contractId:     pppoe.contractId,
    currentlyOnline: summary?.currentlyOnline ?? false,
    lastStartedAt:   summary?.lastStartedAt ?? null,
    lastStoppedAt:   summary?.lastStoppedAt ?? null,
    lastFramedIp:    summary?.lastFramedIp ?? null,
    lastVlanId:      summary?.lastVlanId ?? null,
  };
}
