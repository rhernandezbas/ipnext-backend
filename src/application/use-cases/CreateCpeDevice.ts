import { CpeDevice } from '@domain/entities/cpe';
import { CpeRepository } from '@domain/ports/CpeRepository';

export class CreateCpeDevice {
  constructor(private readonly repo: CpeRepository) {}

  async execute(data: Omit<CpeDevice, 'id'>) {
    return this.repo.create(data);
  }
}
