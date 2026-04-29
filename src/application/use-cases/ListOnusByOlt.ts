import { GponRepository } from '@domain/ports/GponRepository';
import { OnuDevice } from '@domain/entities/gpon';

export class ListOnusByOlt {
  constructor(private readonly repo: GponRepository) {}

  execute(oltId: string): Promise<OnuDevice[]> {
    return this.repo.listOnusByOlt(oltId);
  }
}
