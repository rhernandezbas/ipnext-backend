import { GponRepository } from '@domain/ports/GponRepository';
import { OltDevice } from '@domain/entities/gpon';

export class CreateOlt {
  constructor(private readonly repo: GponRepository) {}

  execute(data: Omit<OltDevice, 'id' | 'totalOnus' | 'onlineOnus' | 'status' | 'lastSeen'>): Promise<OltDevice> {
    return this.repo.createOlt(data);
  }
}
