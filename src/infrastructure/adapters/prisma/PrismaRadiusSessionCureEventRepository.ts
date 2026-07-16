import { prisma } from '@infrastructure/database/prisma';
import type {
  ListRadiusSessionCureEventsParams,
  RadiusSessionCureEvent,
  RadiusSessionCureEventRepository,
  RecordRadiusSessionCureEventInput,
} from '@domain/ports/RadiusSessionCureEventRepository';

/**
 * PrismaRadiusSessionCureEventRepository — Prisma adapter para RadiusSessionCureEventRepository
 * (radius-session-autocure BE-1). Mapea a la tabla "RadiusSessionCureEvent" (migración
 * 20260917000000). Resultados SIEMPRE newest-first (createdAt DESC, id DESC como desempate).
 *
 * `(prisma as any).radiusSessionCureEvent`: mismo gotcha documentado en
 * PrismaPppoeNasMoveEventRepository — el client local no está regenerado en el worktree
 * (node_modules es junction compartida). El Dockerfile corre `prisma generate` en build.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function model(): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (prisma as any).radiusSessionCureEvent;
}

export class PrismaRadiusSessionCureEventRepository implements RadiusSessionCureEventRepository {
  async record(input: RecordRadiusSessionCureEventInput): Promise<RadiusSessionCureEvent> {
    const row = await model().create({
      data: {
        username:          input.username,
        nasIp:             input.nasIp ?? null,
        sessionId:         input.sessionId ?? null,
        sessionStartedAt:  input.sessionStartedAt ? new Date(input.sessionStartedAt) : null,
        sessionLastUpdate: input.sessionLastUpdate ? new Date(input.sessionLastUpdate) : null,
        signalUsed:        input.signalUsed ?? null,
        trigger:           input.trigger,
        action:            input.action ?? null,
        outcome:           input.outcome,
        reason:            input.reason ?? null,
        actorName:         input.actorName ?? null,
      },
    });
    return toEvent(row);
  }

  async list(params: ListRadiusSessionCureEventsParams): Promise<{ items: RadiusSessionCureEvent[]; total: number }> {
    const where = buildWhere(params);

    const skip = (params.page - 1) * params.limit;
    const [rows, total] = await Promise.all([
      model().findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: params.limit,
      }),
      model().count({ where }),
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { items: rows.map((r: any) => toEvent(r)), total };
  }

  async countByOutcome(filters: { username?: string; trigger?: string; from?: Date; to?: Date }): Promise<Record<string, number>> {
    const where = buildWhere(filters);
    const rows: { outcome: string; _count: { outcome: number } }[] = await model().groupBy({
      by: ['outcome'],
      where,
      _count: { outcome: true },
    });
    const counts: Record<string, number> = {};
    for (const r of rows) counts[r.outcome] = r._count.outcome;
    return counts;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildWhere(params: {
  outcome?: string;
  trigger?: string;
  username?: string;
  usernameExact?: string;
  from?: Date;
  to?: Date;
}): Record<string, any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const where: Record<string, any> = {};
  if (params.outcome) where['outcome'] = params.outcome;
  if (params.trigger) where['trigger'] = params.trigger;
  if (params.usernameExact) {
    where['username'] = params.usernameExact;
  } else if (params.username) {
    where['username'] = { contains: params.username, mode: 'insensitive' };
  }
  if (params.from || params.to) {
    where['createdAt'] = {
      ...(params.from ? { gte: params.from } : {}),
      ...(params.to ? { lte: params.to } : {}),
    };
  }
  return where;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toEvent(row: any): RadiusSessionCureEvent {
  return {
    id:                row.id,
    username:          row.username,
    nasIp:             row.nasIp ?? null,
    sessionId:         row.sessionId ?? null,
    sessionStartedAt:  toIso(row.sessionStartedAt),
    sessionLastUpdate: toIso(row.sessionLastUpdate),
    signalUsed:        row.signalUsed ?? null,
    trigger:           row.trigger,
    action:            row.action ?? null,
    outcome:           row.outcome,
    reason:            row.reason ?? null,
    actorName:         row.actorName ?? null,
    createdAt:         row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toIso(value: any): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}
