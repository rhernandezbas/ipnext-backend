import { CpeRepository } from '@domain/ports/CpeRepository';

export class DeleteCpeDevice {
  constructor(private readonly repo: CpeRepository) {}

  async execute(id: string) {
    return this.repo.delete(id);
  }
}
