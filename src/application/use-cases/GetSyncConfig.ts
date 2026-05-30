import { GestionRealSyncConfigRepository } from '@domain/ports/GestionRealSyncConfigRepository';
import { SyncConfigDTO, toSyncConfigDTO } from '@application/dto/gestionRealSync.dto';

/**
 * Returns the current Gestión Real client-sync config as a DTO. The repo returns
 * defaults when no row has been persisted yet (REQ-GETCFG-1 / REQ-CFG-1).
 */
export class GetSyncConfig {
  constructor(private readonly config: GestionRealSyncConfigRepository) {}

  async execute(): Promise<SyncConfigDTO> {
    const current = await this.config.get();
    return toSyncConfigDTO(current);
  }
}
