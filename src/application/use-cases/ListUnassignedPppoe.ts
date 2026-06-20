import { PppoeService } from '@domain/entities/pppoeService';
import { PppoeServiceRepository } from '@domain/ports/PppoeServiceRepository';

/**
 * ListUnassignedPppoe — lista los PPPoE HUÉRFANOS (contractId=null): el inventario adoptado que
 * todavía no se asoció a ningún contrato. La ruta mapea cada entidad a `PppoeServiceDto` (sin password).
 */
export class ListUnassignedPppoe {
  constructor(private readonly repo: PppoeServiceRepository) {}

  async execute(): Promise<PppoeService[]> {
    return this.repo.findUnassigned();
  }
}
