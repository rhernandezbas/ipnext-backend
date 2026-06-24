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

    const filters: RadiusAuthEventFilters = {
      username: input.username,
      reply:    input.reply,
      from:     input.from ? new Date(input.from) : undefined,
      to:       input.to   ? new Date(input.to)   : undefined,
      page,
      pageSize,
    };

    const result = await this.repo.list(filters);

    // El repo garantiza ORDER BY authdate DESC. NO re-ordenar aquí (rompería cross-página).
    return {
      data:    result.data.map(toDto),
      total:   result.total,
      page:    result.page,
      limit,
      hasNext: result.page * pageSize < result.total,
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
  };
}
