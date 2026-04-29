import { GponRepository } from '@domain/ports/GponRepository';
import { OnuDevice } from '@domain/entities/gpon';

export class ListOnus {
  constructor(private readonly repo: GponRepository) {}

  execute(): Promise<OnuDevice[]> {
    return this.repo.listOnus();
  }
}
