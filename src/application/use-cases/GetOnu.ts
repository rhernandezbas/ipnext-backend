import { GponRepository } from '@domain/ports/GponRepository';
import { OnuDevice } from '@domain/entities/gpon';

export class GetOnu {
  constructor(private readonly repo: GponRepository) {}

  execute(id: string): Promise<OnuDevice | null> {
    return this.repo.getOnu(id);
  }
}
