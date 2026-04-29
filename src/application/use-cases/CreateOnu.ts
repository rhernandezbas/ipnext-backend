import { GponRepository } from '@domain/ports/GponRepository';
import { OnuDevice } from '@domain/entities/gpon';

export class CreateOnu {
  constructor(private readonly repo: GponRepository) {}

  execute(data: Omit<OnuDevice, 'id' | 'oltName' | 'onuId' | 'rxPower' | 'txPower' | 'distance' | 'firmwareVersion' | 'lastSeen' | 'status'>): Promise<OnuDevice> {
    return this.repo.createOnu(data);
  }
}
