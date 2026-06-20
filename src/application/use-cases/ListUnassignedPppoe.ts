import { PppoeService } from '@domain/entities/pppoeService';
import { PppoeServiceRepository } from '@domain/ports/PppoeServiceRepository';

/**
 * ListUnassignedPppoe — lista los PPPoE HUÉRFANOS (contractId=null): el inventario adoptado que
 * todavía no se asoció a ningún contrato. La ruta mapea cada entidad a `PppoeServiceDto` (sin password).
 *
 * Defence-in-depth: si se inyectan `exclusionPatterns`, los usernames placeholder que hayan
 * llegado a la DB (por ingest anterior al fix) también quedan excluidos del listado.
 * Default: [] (sin exclusiones = comportamiento original BC).
 */
export class ListUnassignedPppoe {
  constructor(
    private readonly repo: PppoeServiceRepository,
    private readonly exclusionPatterns: RegExp[] = [],
  ) {}

  async execute(): Promise<PppoeService[]> {
    const all = await this.repo.findUnassigned();
    if (this.exclusionPatterns.length === 0) return all;
    return all.filter(
      s => !this.exclusionPatterns.some(re => re.test(s.username)),
    );
  }
}
