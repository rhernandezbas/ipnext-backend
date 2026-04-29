import { UbicacionRepository } from '@domain/ports/UbicacionRepository';
import { Ubicacion } from '@domain/entities/ubicacion';

export class ListUbicaciones {
  constructor(private readonly repo: UbicacionRepository) {}

  execute(): Promise<Ubicacion[]> {
    return this.repo.findAll();
  }
}
