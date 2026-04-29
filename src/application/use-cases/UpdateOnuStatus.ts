import { GponRepository } from '@domain/ports/GponRepository';
import { OnuDevice } from '@domain/entities/gpon';

export class UpdateOnuStatus {
  constructor(private readonly repo: GponRepository) {}

  execute(id: string, status: OnuDevice['status']): Promise<OnuDevice | null> {
    return this.repo.updateOnuStatus(id, status);
  }
}
