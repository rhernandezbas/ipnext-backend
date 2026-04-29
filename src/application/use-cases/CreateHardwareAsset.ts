import { HardwareAsset } from '@domain/entities/hardware';
import { HardwareRepository } from '@domain/ports/HardwareRepository';

export class CreateHardwareAsset {
  constructor(private readonly repo: HardwareRepository) {}

  async execute(data: Omit<HardwareAsset, 'id'>) {
    return this.repo.create(data);
  }
}
