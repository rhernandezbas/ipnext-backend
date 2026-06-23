/**
 * ListRadiusEvents — caso de uso de lectura (read-only).
 *
 * Filtra y pagina eventos RADIUS del mirror `RadiusEvent`.
 * Dependencia: RadiusEventRepository (port). Nunca importa de @infrastructure.
 *
 * AD-4: "última conexión" no aplica acá — esto es la vista temporal cruda.
 * REQ-UC-2: orden default startedAt DESC.
 * REQ-PAGE-1: limit cap 200; default page=1, limit=50.
 */
import {
  RadiusEventRepository,
  RadiusEventFilters,
} from '@domain/ports/RadiusEventRepository';
import { RadiusEventDto, PaginatedRadiusEventsDto } from '@application/dto/radius-event.dto';
import { RadiusEvent } from '@domain/entities/radius-event';

export interface ListRadiusEventsInput {
  username?: string;
  nasId?: string;
  vlanId?: number;
  /** 'start' | 'stop' | 'interim' — si se pasa, filtra por eventType */
  eventType?: 'start' | 'stop' | 'interim';
  /** Shortcut: true → stoppedAt IS NULL; false → stoppedAt IS NOT NULL */
  online?: boolean;
  /** ISO 8601 — startedAt >= from */
  from?: string;
  /** ISO 8601 — startedAt <= to */
  to?: string;
  page?: number;
  limit?: number;
}

const DEFAULT_LIMIT  = 50;
const MAX_LIMIT      = 200;
const DEFAULT_PAGE   = 1;

export class ListRadiusEvents {
  constructor(private readonly repo: RadiusEventRepository) {}

  async execute(input: ListRadiusEventsInput): Promise<PaginatedRadiusEventsDto> {
    const page     = Math.max(1, input.page ?? DEFAULT_PAGE);
    const limit    = Math.min(MAX_LIMIT, Math.max(1, input.limit ?? DEFAULT_LIMIT));
    const pageSize = limit;

    // Mapear online → status (el repo filtra por el campo denormalizado status)
    let status: 'online' | 'closed' | undefined;
    if (input.online === true)  status = 'online';
    if (input.online === false) status = 'closed';

    const filters: RadiusEventFilters = {
      username:  input.username,
      nasId:     input.nasId,
      vlanId:    input.vlanId,
      eventType: input.eventType,
      status,
      from:      input.from ? new Date(input.from) : undefined,
      to:        input.to   ? new Date(input.to)   : undefined,
      page,
      pageSize,
    };

    const result = await this.repo.list(filters);

    // FIX3: el repo garantiza ORDER BY startedAt DESC (tanto InMemory como Prisma).
    // NO re-ordenar aquí — hacerlo solo picaría la página actual, rompiendo cross-página.
    return {
      data:    result.data.map(toDto),
      total:   result.total,
      page:    result.page,
      limit,
      hasNext: result.page * pageSize < result.total,
    };
  }
}

function toDto(e: RadiusEvent): RadiusEventDto {
  return {
    id:                  e.id,
    username:            e.username,
    nasId:               e.nasId,
    nasIpAddress:        e.nasIpAddress,
    nasName:             null,          // se resuelve en el adapter Prisma vía JOIN; in-memory = null
    framedIp:            e.framedIp,
    macAddress:          e.macAddress,
    vlanId:              e.vlanId,
    startedAt:           e.startedAt,
    stoppedAt:           e.stoppedAt,
    sessionTimeSeconds:  e.sessionTime,
    inOctets:            e.bytesIn.toString(),
    outOctets:           e.bytesOut.toString(),
    eventType:           e.eventType,
    status:              e.status as 'online' | 'closed',
    online:              e.stoppedAt === null,
  };
}
