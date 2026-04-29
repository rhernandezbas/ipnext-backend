import { CpeRepository } from '@domain/ports/CpeRepository';

export class GetCpeDevice {
  constructor(private readonly repo: CpeRepository) {}

  async execute(id: string) {
    return this.repo.findById(id);
  }
}
