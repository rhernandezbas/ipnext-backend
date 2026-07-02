import type { PppoeServiceRepository } from '@domain/ports/PppoeServiceRepository';
import { isPppoeDisplayStatus } from '@domain/entities/pppoeService';

export interface ListAllPppoeServiceIdsFilter {
  search?: string;
  status?: string;
  nasId?: string;
  /** pppoe-bulk-select-filter (v2): cuando true, incluye PPPoE sin contrato (huérfanos). Default false. */
  includeUnassigned?: boolean;
}

export interface ListAllPppoeServiceIdsResult {
  ids: string[];
  total: number;
}

/**
 * ListAllPppoeServiceIds (pppoe-bulk-select-filter v2) — hermano LIVIANO de
 * `ListAllPppoeServices`. Devuelve SOLO `{ ids, total }` de TODOS los servicios que
 * matchean el filtro (sin paginar, sin enriquecimiento createdBy/nasName — ese trabajo
 * es exclusivo del listado paginado, no de una selección masiva).
 *
 * Normaliza `status` (vocabulario de NEGOCIO) → `displayStatus` con `isPppoeDisplayStatus`
 * — el MISMO type-guard que usa `ListAllPppoeServices` (domain, single source of truth).
 * Fail-open: un status desconocido se ignora (sin filtro), NUNCA lanza.
 *
 * DIP: depende SOLO de `PppoeServiceRepository` (ni eventRepo, ni catalogRepo, ni nasRepo —
 * a diferencia de `ListAllPppoeServices`, que SÍ los necesita para el enriquecimiento).
 */
export class ListAllPppoeServiceIds {
  constructor(private readonly pppoeRepo: PppoeServiceRepository) {}

  async execute(filters: ListAllPppoeServiceIdsFilter): Promise<ListAllPppoeServiceIdsResult> {
    const displayStatus = isPppoeDisplayStatus(filters.status) ? filters.status : undefined;

    return this.pppoeRepo.listAllIds({
      ...(filters.search ? { search: filters.search } : {}),
      ...(displayStatus ? { displayStatus } : {}),
      ...(filters.nasId ? { nasId: filters.nasId } : {}),
      ...(filters.includeUnassigned ? { includeUnassigned: true } : {}),
    });
  }
}
