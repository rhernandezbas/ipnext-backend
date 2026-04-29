import { UbicacionRepository } from '@domain/ports/UbicacionRepository';

export class DeleteUbicacion {
  constructor(private readonly repo: UbicacionRepository) {}

  execute(id: string): Promise<boolean> {
    return this.repo.delete(id);
  }
}
