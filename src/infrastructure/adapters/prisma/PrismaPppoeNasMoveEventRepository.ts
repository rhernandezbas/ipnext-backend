import { prisma } from '@infrastructure/database/prisma';
import type {
  ListPppoeNasMoveEventsParams,
  PppoeNasMoveEvent,
  PppoeNasMoveEventRepository,
  RecordPppoeNasMoveEventInput,
} from '@domain/ports/PppoeNasMoveEventRepository';

/**
 * PrismaPppoeNasMoveEventRepository — Prisma adapter para PppoeNasMoveEventRepository
 * (pppoe-move-nas W1). Mapea a la tabla "PppoeNasMoveEvent" (migración 20260824000000).
 * Resultados SIEMPRE newest-first (createdAt DESC, id DESC como desempate).
 *
 * `(prisma as any).pppoeNasMoveEvent`: el client local no está regenerado en el worktree
 * (node_modules es junction compartida). El Dockerfile corre `prisma generate` en build →
 * en prod tipa bien. Mismo gotcha documentado que PrismaContractServiceEventRepository.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function model(): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (prisma as any).pppoeNasMoveEvent;
}

export class PrismaPppoeNasMoveEventRepository implements PppoeNasMoveEventRepository {
  async record(input: RecordPppoeNasMoveEventInput): Promise<PppoeNasMoveEvent> {
    const row = await model().create({
      data: {
        username:       input.username,
        pppoeServiceId: input.pppoeServiceId ?? null,
        fromNasId:      input.fromNasId ?? null,
        toNasId:        input.toNasId ?? null,
        fromIp:         input.fromIp ?? null,
        toIp:           input.toIp ?? null,
        trigger:        input.trigger,
        outcome:        input.outcome,
        reason:         input.reason ?? null,
        actorName:      input.actorName ?? null,
      },
    });
    return toEvent(row);
  }

  async list(params: ListPppoeNasMoveEventsParams): Promise<{ items: PppoeNasMoveEvent[]; total: number }> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where: Record<string, any> = {};
    if (params.outcome) where['outcome'] = params.outcome;
    if (params.trigger) where['trigger'] = params.trigger;
    // username: coincidencia parcial case-insensitive (hábito del repo para búsquedas).
    if (params.username) where['username'] = { contains: params.username, mode: 'insensitive' };

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
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toEvent(row: any): PppoeNasMoveEvent {
  return {
    id:             row.id,
    username:       row.username,
    pppoeServiceId: row.pppoeServiceId ?? null,
    fromNasId:      row.fromNasId ?? null,
    toNasId:        row.toNasId ?? null,
    fromIp:         row.fromIp ?? null,
    toIp:           row.toIp ?? null,
    trigger:        row.trigger,
    outcome:        row.outcome,
    reason:         row.reason ?? null,
    actorName:      row.actorName ?? null,
    createdAt:      row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
  };
}
