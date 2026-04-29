import { UbicacionRepository } from '@domain/ports/UbicacionRepository';
import { Ubicacion } from '@domain/entities/ubicacion';

export class UpdateUbicacion {
  constructor(private readonly repo: UbicacionRepository) {}

  execute(id: string, data: Partial<Ubicacion>): Promise<Ubicacion | null> {
    return this.repo.update(id, data);
  }
}
