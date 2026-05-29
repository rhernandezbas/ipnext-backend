import { GestionRealIngestConfigRepository } from '@domain/ports/GestionRealIngestConfigRepository';
import { ProjectRepository } from '@domain/ports/ProjectRepository';
import { ProjectNotFoundError } from '@domain/errors/projects';
import {
  IngestConfigDTO,
  UpdateIngestConfigInput,
  toIngestConfigDTO,
} from '@application/dto/gestionRealIngest.dto';

/**
 * Applies a validated partial patch to the ingest config (REQ-PUTCFG-1).
 *
 * Project-FK rules (REQ-PUTCFG-2):
 *  - A non-null `fiberProjectId`/`wirelessProjectId` MUST reference an existing
 *    Project, else `ProjectNotFoundError` (404) and nothing is persisted.
 *  - `null` clears the mapping and performs NO project lookup.
 *  - An omitted FK leaves the existing mapping untouched.
 *
 * Body-shape validation (e.g. `intervalMs: "soon"`) is the route's job via the
 * Zod schema (400 VALIDATION_ERROR); this use-case receives an already-parsed,
 * type-safe patch.
 */
export class UpdateIngestConfig {
  constructor(
    private readonly config: GestionRealIngestConfigRepository,
    private readonly projects: ProjectRepository,
  ) {}

  async execute(patch: UpdateIngestConfigInput): Promise<IngestConfigDTO> {
    // Validate FK existence BEFORE persisting. null skips the lookup (clears).
    if ('fiberProjectId' in patch && patch.fiberProjectId != null) {
      await this.assertProjectExists(patch.fiberProjectId);
    }
    if ('wirelessProjectId' in patch && patch.wirelessProjectId != null) {
      await this.assertProjectExists(patch.wirelessProjectId);
    }

    const updated = await this.config.update(patch);
    return toIngestConfigDTO(updated);
  }

  private async assertProjectExists(projectId: string): Promise<void> {
    const project = await this.projects.get(projectId);
    if (!project) throw new ProjectNotFoundError(projectId);
  }
}
