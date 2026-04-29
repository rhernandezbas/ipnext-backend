import { GponRepository } from '@domain/ports/GponRepository';
import { OltDevice } from '@domain/entities/gpon';

export class GetOlt {
  constructor(private readonly repo: GponRepository) {}

  execute(id: string): Promise<OltDevice | null> {
    return this.repo.getOlt(id);
  }
}
