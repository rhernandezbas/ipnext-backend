import { CpeRepository } from '@domain/ports/CpeRepository';

export class ListCpeDevices {
  constructor(private readonly repo: CpeRepository) {}

  async execute() {
    return this.repo.findAll();
  }
}
