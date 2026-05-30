import { GestionRealSyncConfigRepository } from '@domain/ports/GestionRealSyncConfigRepository';
import {
  SyncConfigDTO,
  UpdateSyncConfigInput,
  toSyncConfigDTO,
} from '@application/dto/gestionRealSync.dto';

/**
 * Applies a validated partial patch to the client-sync config (REQ-PUTCFG-1).
 *
 * Pure partial patch — NO ProjectRepository, NO FK existence check (unlike
 * `UpdateIngestConfig`). `estados` replacement (not merge) is handled by the repo.
 * Body-shape validation (e.g. `intervalMs: "soon"`, unknown estado) is the route's
 * job via the Zod schema (400 VALIDATION_ERROR); this use-case receives an
 * already-parsed, type-safe patch.
 */
export class UpdateSyncConfig {
  constructor(private readonly config: GestionRealSyncConfigRepository) {}

  async execute(patch: UpdateSyncConfigInput): Promise<SyncConfigDTO> {
    const updated = await this.config.update(patch);
    return toSyncConfigDTO(updated);
  }
}
