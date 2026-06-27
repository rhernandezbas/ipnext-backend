/**
 * ListRadiusAuthFailures — caso de uso de lectura (read-only).
 *
 * Filtra y pagina eventos de autenticación RADIUS del mirror `RadiusAuthEvent`.
 * Espejo de ListRadiusEvents. Dependencia: RadiusAuthEventRepository (port).
 *
 * Orden default authdate DESC (lo más reciente primero).
 * limit cap 200; default page=1, limit=50.
 */
import {
  RadiusAuthEventRepository,
  RadiusAuthEventFilters,
} from '@domain/ports/RadiusAuthEventRepository';
import { RadiusAuthEventDto, PaginatedRadiusAuthEventsDto } from '@application/dto/radius-event.dto';
import { RadiusAuthEvent, RadiusAuthReply } from '@domain/entities/radius-auth-event';

export interface ListRadiusAuthFailuresInput {
  username?: string;
  /** 'Access-Accept' | 'Access-Reject' — si se pasa, filtra por reply */
  reply?: RadiusAuthReply;
  /** ISO 8601 — authdate >= from */
  from?: string;
  /** ISO 8601 — authdate <= to */
  to?: string;
  /** Motivo de rechazo: 'session_stuck' | 'user_not_found' | 'other'. Filtra sólo `data`. */
  reason?: string;
  page?: number;
  limit?: number;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT     = 200;
const DEFAULT_PAGE  = 1;

export class ListRadiusAuthFailures {
  constructor(private readonly repo: RadiusAuthEventRepository) {}

  async execute(input: ListRadiusAuthFailuresInput): Promise<PaginatedRadiusAuthEventsDto> {
    const page     = Math.max(1, input.page ?? DEFAULT_PAGE);
    const limit    = Math.min(MAX_LIMIT, Math.max(1, input.limit ?? DEFAULT_LIMIT));
    const pageSize = limit;

    // Filtros base (sin reason) — usados tanto para `list` como para `countByReason`.
    const fromDate = input.from ? new Date(input.from) : undefined;
    const toDate   = input.to   ? new Date(input.to)   : undefined;

    const filters: RadiusAuthEventFilters = {
      username: input.username,
      reply:    input.reply,
      from:     fromDate,
      to:       toDate,
      reason:   input.reason,
      page,
      pageSize,
    };

    // 2 consultas paralelas:
    //   - list: filtra por todos los filtros incluyendo reason
    //   - countByReason: ignora reason → desglose completo para los chips del FE
    const [result, rawCounts] = await Promise.all([
      this.repo.list(filters),
      this.repo.countByReason({ username: input.username, reply: input.reply, from: fromDate, to: toDate }),
    ]);

    const countsByReason = {
      session_stuck:  rawCounts['session_stuck']  ?? 0,
      user_not_found: rawCounts['user_not_found'] ?? 0,
      other:          rawCounts['other']          ?? 0,
    };

    // El repo garantiza ORDER BY authdate DESC. NO re-ordenar aquí (rompería cross-página).
    return {
      data:    result.data.map(toDto),
      total:   result.total,
      page:    result.page,
      limit,
      hasNext: result.page * pageSize < result.total,
      countsByReason,
    };
  }
}

function toDto(e: RadiusAuthEvent): RadiusAuthEventDto {
  return {
    id:       e.id,
    username: e.username,
    reply:    e.reply,
    authdate: e.authdate,
    class:    e.class,
    reason:   e.reason,
  };
}
