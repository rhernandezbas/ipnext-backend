import { HardwareRepository } from '@domain/ports/HardwareRepository';

export class DeleteHardwareAsset {
  constructor(private readonly repo: HardwareRepository) {}

  async execute(id: string) {
    return this.repo.delete(id);
  }
}
