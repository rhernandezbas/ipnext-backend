import { PppoeNasMoveEventRepository } from '@domain/ports/PppoeNasMoveEventRepository';
import { NasRepository } from '@domain/ports/NasRepository';
import { PppoeNasMoveEventDto, PppoeNasMoveEventPageDto } from '@application/dto/pppoe.dto';

export interface ListPppoeNasMoveEventsInput {
  page?: number;
  limit?: number;
  outcome?: string;
  trigger?: string;
  /** Coincidencia parcial case-insensitive sobre el username. */
  username?: string;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * ListPppoeNasMoveEvents (pppoe-move-nas W1, REQ-LOG-1 / design D6 punto 3) — listado paginado
 * del registro visible de movimientos de NAS para el tab "Movimientos NAS" de la auditoría.
 *
 * - Paginación page/limit (default 20, tope 100 — patrón ListAllPppoeServices).
 * - Filtros outcome/trigger (exactos) + username (parcial, case-insensitive) — push-down al repo.
 * - Enriquecimiento: fromNasId/toNasId → {id, name} contra el inventario NAS en UNA consulta
 *   (findAllNasServers, ~10 filas). NAS borrado del inventario → name cae al id (no revienta).
 */
export class ListPppoeNasMoveEvents {
  constructor(
    private readonly moveEventRepo: PppoeNasMoveEventRepository,
    private readonly nasRepo: NasRepository,
  ) {}

  async execute(input: ListPppoeNasMoveEventsInput): Promise<PppoeNasMoveEventPageDto> {
    const page  = Math.max(1, input.page ?? 1);
    const limit = Math.min(MAX_LIMIT, Math.max(1, input.limit ?? DEFAULT_LIMIT));

    const params: Parameters<PppoeNasMoveEventRepository['list']>[0] = { page, limit };
    if (input.outcome)  params.outcome  = input.outcome;
    if (input.trigger)  params.trigger  = input.trigger;
    if (input.username) params.username = input.username;

    const { items, total } = await this.moveEventRepo.list(params);

    const nasNameById = new Map(
      (await this.nasRepo.findAllNasServers()).map(n => [n.id, n.name] as const),
    );
    const toNasRef = (nasId: string | null): PppoeNasMoveEventDto['fromNas'] =>
      nasId ? { id: nasId, name: nasNameById.get(nasId) ?? nasId } : null;

    return {
      items: items.map((e): PppoeNasMoveEventDto => ({
        id:        e.id,
        username:  e.username,
        fromNas:   toNasRef(e.fromNasId),
        toNas:     toNasRef(e.toNasId),
        fromIp:    e.fromIp,
        toIp:      e.toIp,
        trigger:   e.trigger,
        outcome:   e.outcome,
        reason:    e.reason,
        actorName: e.actorName,
        createdAt: e.createdAt,
      })),
      total,
      page,
      limit,
    };
  }
}
