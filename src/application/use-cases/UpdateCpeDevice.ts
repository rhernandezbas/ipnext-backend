import { CpeDevice } from '@domain/entities/cpe';
import { CpeRepository } from '@domain/ports/CpeRepository';

export class UpdateCpeDevice {
  constructor(private readonly repo: CpeRepository) {}

  async execute(id: string, data: Partial<CpeDevice>) {
    return this.repo.update(id, data);
  }
}
