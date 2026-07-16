/**
 * ListRadiusSessionCures — caso de uso de lectura (read-only), molde ListRadiusAuthFailures.
 *
 * Filtra y pagina el registro de intentos de curación de sesiones RADIUS colgadas
 * (radius-session-autocure BE-1, REQ-CURE-5). Dependencia: RadiusSessionCureEventRepository (port).
 *
 * Orden default createdAt DESC (lo más reciente primero). limit cap 200; default page=1, limit=50.
 */
import {
  RadiusSessionCureEvent,
  RadiusSessionCureEventRepository,
  ListRadiusSessionCureEventsParams,
} from '@domain/ports/RadiusSessionCureEventRepository';
import { PaginatedRadiusSessionCureEventsDto, RadiusSessionCureEventDto } from '@application/dto/radius-event.dto';

export interface ListRadiusSessionCuresInput {
  username?: string;
  outcome?: string;
  trigger?: string;
  /** ISO 8601 — createdAt >= from */
  from?: string;
  /** ISO 8601 — createdAt <= to */
  to?: string;
  page?: number;
  limit?: number;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT     = 200;
const DEFAULT_PAGE  = 1;

export class ListRadiusSessionCures {
  constructor(private readonly repo: RadiusSessionCureEventRepository) {}

  async execute(input: ListRadiusSessionCuresInput): Promise<PaginatedRadiusSessionCureEventsDto> {
    const page  = Math.max(1, input.page ?? DEFAULT_PAGE);
    const limit = Math.min(MAX_LIMIT, Math.max(1, input.limit ?? DEFAULT_LIMIT));

    const fromDate = input.from ? new Date(input.from) : undefined;
    const toDate   = input.to   ? new Date(input.to)   : undefined;

    const filters: ListRadiusSessionCureEventsParams = {
      username: input.username,
      outcome:  input.outcome,
      trigger:  input.trigger,
      from:     fromDate,
      to:       toDate,
      page,
      limit,
    };

    // 2 consultas paralelas: list (todos los filtros) + countByOutcome (ignora outcome).
    const [result, rawCounts] = await Promise.all([
      this.repo.list(filters),
      this.repo.countByOutcome({ username: input.username, trigger: input.trigger, from: fromDate, to: toDate }),
    ]);

    const countsByOutcome = {
      cured:              rawCounts['cured']              ?? 0,
      already_cured:      rawCounts['already_cured']       ?? 0,
      skipped_alive:      rawCounts['skipped_alive']       ?? 0,
      skipped_ambiguous:  rawCounts['skipped_ambiguous']   ?? 0,
      skipped_no_session: rawCounts['skipped_no_session']  ?? 0,
      skipped_no_signal:  rawCounts['skipped_no_signal']   ?? 0,
      flagged_flapping:   rawCounts['flagged_flapping']    ?? 0,
      failed:             rawCounts['failed']               ?? 0,
    };

    return {
      data:    result.items.map(toDto),
      total:   result.total,
      page,
      limit,
      hasNext: page * limit < result.total,
      countsByOutcome,
    };
  }
}

function toDto(e: RadiusSessionCureEvent): RadiusSessionCureEventDto {
  return {
    id:                e.id,
    username:          e.username,
    nasIp:             e.nasIp,
    sessionId:         e.sessionId,
    sessionStartedAt:  e.sessionStartedAt,
    sessionLastUpdate: e.sessionLastUpdate,
    signalUsed:        e.signalUsed,
    trigger:           e.trigger,
    action:            e.action,
    outcome:           e.outcome,
    reason:            e.reason,
    actorName:         e.actorName,
    createdAt:         e.createdAt,
  };
}
