import { GestionRealIngestConfigRepository } from '@domain/ports/GestionRealIngestConfigRepository';
import { IngestConfigDTO, toIngestConfigDTO } from '@application/dto/gestionRealIngest.dto';

/**
 * Returns the current Gestión Real ingest config as a DTO. The repo returns
 * defaults when no row has been persisted yet (REQ-GETCFG-1 / REQ-CFG-1).
 */
export class GetIngestConfig {
  constructor(private readonly config: GestionRealIngestConfigRepository) {}

  async execute(): Promise<IngestConfigDTO> {
    const current = await this.config.get();
    return toIngestConfigDTO(current);
  }
}
