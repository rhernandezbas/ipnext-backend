import { GponRepository } from '@domain/ports/GponRepository';
import { OltDevice } from '@domain/entities/gpon';

export class ListOlts {
  constructor(private readonly repo: GponRepository) {}

  execute(): Promise<OltDevice[]> {
    return this.repo.listOlts();
  }
}
