import { UbicacionRepository } from '@domain/ports/UbicacionRepository';
import { Ubicacion } from '@domain/entities/ubicacion';

export class CreateUbicacion {
  constructor(private readonly repo: UbicacionRepository) {}

  execute(data: Omit<Ubicacion, 'id'>): Promise<Ubicacion> {
    return this.repo.create(data);
  }
}
