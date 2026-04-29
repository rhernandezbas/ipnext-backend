import { HardwareAsset } from '@domain/entities/hardware';
import { HardwareRepository } from '@domain/ports/HardwareRepository';

export class UpdateHardwareAsset {
  constructor(private readonly repo: HardwareRepository) {}

  async execute(id: string, data: Partial<HardwareAsset>) {
    return this.repo.update(id, data);
  }
}
