import { SyncStateRepository } from '@domain/ports/SyncStateRepository';
import { IngestStatusDTO, toIngestStatusDTO } from '@application/dto/gestionRealIngest.dto';

/**
 * Returns the last Gestión Real ingest run's timestamp and counts (REQ-STATUS-1).
 *
 * Status is sync metadata, so it is read from the `gr-ingest` SyncState entity
 * (written by IngestGestionRealOrders). Before any run the state is absent →
 * `lastRunAt: null` and all counts `0`. The DTO mapper owns the parsing of the
 * JSON-encoded counts blob and degrades safely to zeros on malformed data.
 */
export class GetIngestStatus {
  private static readonly ENTITY = 'gr-ingest';

  constructor(private readonly state: SyncStateRepository) {}

  async execute(): Promise<IngestStatusDTO> {
    const state = await this.state.get(GetIngestStatus.ENTITY);
    return toIngestStatusDTO(state);
  }
}
