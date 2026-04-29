import { UbicacionRepository } from '@domain/ports/UbicacionRepository';
import { Ubicacion } from '@domain/entities/ubicacion';

export class GetUbicacion {
  constructor(private readonly repo: UbicacionRepository) {}

  execute(id: string): Promise<Ubicacion | null> {
    return this.repo.findById(id);
  }
}
