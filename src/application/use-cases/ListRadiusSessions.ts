import { RadiusSessionRepository } from '@domain/ports/RadiusSessionRepository';
import { PppoeServiceRepository } from '@domain/ports/PppoeServiceRepository';
import { RadiusSession } from '@domain/entities/radiusSessions';
import {
  RadiusSessionDto,
  RadiusSessionsStats,
  PaginatedRadiusSessionsDto,
} from '@application/dto/radius-session.dto';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT     = 200;

export interface ListRadiusSessionsParams {
  /** Substring case-insensitive en username | customerName | ipAddress | macAddress. */
  search?:  string;
  /** Filtra por nasId de la sesión (= nasIp en la fuente real). */
  nasId?:   string;
  /** Filtra por status de la sesión. */
  status?:  'active' | 'idle';
  /** Página (1-based). Default 1. */
  page?:    number;
  /** Filas por página. Default 50, cap 200. */
  limit?:   number;
}

/**
 * ListRadiusSessions (gestion-red-sessions) — sesiones RADIUS activas ENRIQUECIDAS con el cruce
 * a contrato (pppoe → contract → client) por `username`.
 *
 * El cruce es BATCH: se juntan TODOS los usernames de las sesiones y se resuelven en UNA sola
 * query (`findByUsernames` → `username IN (...)`), NUNCA N+1 — son potencialmente miles de sesiones.
 *
 * Para cada sesión:
 *   - PppoeService enabled con contrato  → contractId + clientId + customerName
 *   - PppoeService terminated            → los 3 en null (servicio dado de baja → ⚠)
 *   - PppoeService huérfano (sin FK)     → los 3 en null
 *   - sin PppoeService matching          → los 3 en null
 * Los 3 en null = el FE muestra ⚠ ("PPPoE sin contrato asociado").
 *
 * execute() sin params → RadiusSession[] (back-compat; preserva tests Array.isArray).
 * execute(params) con al menos un campo → PaginatedRadiusSessionsDto (envelope).
 *
 * El filtrado, cálculo de stats y paginado son en MEMORIA post-enriquecimiento (design D2).
 * No se agregan métodos al port RadiusSessionRepository (DIP estricto).
 */
export class ListRadiusSessions {
  constructor(
    private readonly repo: RadiusSessionRepository,
    private readonly pppoeRepo: PppoeServiceRepository,
  ) {}

  /** Sin params: devuelve el array legacy RadiusSession[] (back-compat). */
  async execute(): Promise<RadiusSession[]>;
  /** Con params: devuelve el envelope paginado PaginatedRadiusSessionsDto. */
  async execute(params: ListRadiusSessionsParams): Promise<PaginatedRadiusSessionsDto>;

  async execute(
    params?: ListRadiusSessionsParams,
  ): Promise<RadiusSession[] | PaginatedRadiusSessionsDto> {
    // ── 1. Fetch + enriquecer (igual que hoy) ──────────────────────────────────
    const sessions = await this.repo.listSessions();

    if (sessions.length === 0) {
      if (params === undefined) return [];
      return emptyEnvelope(params);
    }

    // BATCH: usernames únicos → una sola query con `IN`.
    const usernames = [...new Set(sessions.map(s => s.username))];
    const pppoes    = await this.pppoeRepo.findByUsernames(usernames);

    const byUsername = new Map(pppoes.map(p => [p.username, p]));

    const enriched: RadiusSession[] = sessions.map(s => {
      const p      = byUsername.get(s.username);
      const linked = p != null && p.status !== 'terminated';
      return {
        ...s,
        contractId:   linked ? (p!.contractId   ?? null) : null,
        clientId:     linked ? (p!.clientId     ?? null) : null,
        customerName: linked ? (p!.customerName ?? null) : null,
      };
    });

    // ── 2. Back-compat: sin params → array legacy ──────────────────────────────
    if (params === undefined) {
      return enriched;
    }

    // ── 3. Filtrar por search + nasId (para stats) ────────────────────────────
    const { search, nasId, status } = params;
    const term = search?.toLowerCase();

    const bySearchNas = enriched.filter(s => {
      if (nasId !== undefined && s.nasId !== nasId) return false;
      if (term !== undefined) {
        const matchUsername     = s.username.toLowerCase().includes(term);
        const matchCustomerName = s.customerName != null && s.customerName.toLowerCase().includes(term);
        const matchIp           = s.ipAddress    != null && s.ipAddress.toLowerCase().includes(term);
        const matchMac          = s.macAddress   != null && s.macAddress.toLowerCase().includes(term);
        if (!matchUsername && !matchCustomerName && !matchIp && !matchMac) return false;
      }
      return true;
    });

    // ── 4. Calcular stats sobre bySearchNas IGNORANDO status (design D3) ──────
    const stats: RadiusSessionsStats = {
      total:  bySearchNas.length,
      active: bySearchNas.filter(s => s.status === 'active').length,
      idle:   bySearchNas.filter(s => s.status === 'idle').length,
    };

    // ── 5. Aplicar filtro status ───────────────────────────────────────────────
    const filtered = status !== undefined
      ? bySearchNas.filter(s => s.status === status)
      : bySearchNas;

    // ── 6. Orden TOTAL username ASC + tiebreaker id ASC (cross-página) ─────────
    // F1: `username` NO es único (session_stuck + reconexión producen duplicados reales).
    // Sin tiebreaker, el desempate entre duplicados queda a merced del orden de entrada
    // (Array.sort es estable) — que el orchestrator NO garantiza estable entre requests
    // sucesivos. Eso duplica o pierde filas al paginar. `id` SÍ es único en la entity →
    // el tiebreaker por id da un orden TOTAL determinístico, consistente cross-página
    // sin importar en qué orden llegó el snapshot de cada request.
    // Comparación de strings estándar (no locale-aware) para consistencia cross-plataforma.
    const ordered = [...filtered].sort((a, b) => {
      if (a.username < b.username) return -1;
      if (a.username > b.username) return 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

    // ── 7. Paginar ────────────────────────────────────────────────────────────
    const page  = params.page  ?? 1;
    const limit = Math.min(params.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const start = (page - 1) * limit;
    const slice = ordered.slice(start, start + limit);

    // ── 8. Mapear a DTO (no devolver entidad cruda) ───────────────────────────
    return {
      data:    slice.map(toDto),
      total:   filtered.length,
      page,
      limit,
      hasNext: page * limit < filtered.length,
      stats,
    };
  }
}

/** Mapeo explícito 1:1 RadiusSession → RadiusSessionDto. NO devuelve la entidad cruda. */
function toDto(s: RadiusSession): RadiusSessionDto {
  return {
    id:            s.id,
    sessionId:     s.sessionId,
    username:      s.username,
    clientName:    s.clientName,
    nasId:         s.nasId,
    nasName:       s.nasName,
    ipAddress:     s.ipAddress,
    macAddress:    s.macAddress,
    startedAt:     s.startedAt,
    duration:      s.duration,
    downloadBytes: s.downloadBytes,
    uploadBytes:   s.uploadBytes,
    downloadMbps:  s.downloadMbps,
    uploadMbps:    s.uploadMbps,
    status:        s.status,
    contractId:    s.contractId,
    clientId:      s.clientId,
    customerName:  s.customerName,
  };
}

function emptyEnvelope(params: ListRadiusSessionsParams): PaginatedRadiusSessionsDto {
  const page  = params.page  ?? 1;
  const limit = Math.min(params.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  return {
    data:    [],
    total:   0,
    page,
    limit,
    hasNext: false,
    stats:   { total: 0, active: 0, idle: 0 },
  };
}
