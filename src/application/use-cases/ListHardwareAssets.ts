import { HardwareRepository } from '@domain/ports/HardwareRepository';

export class ListHardwareAssets {
  constructor(private readonly repo: HardwareRepository) {}

  async execute() {
    return this.repo.findAll();
  }
}
