import { Project } from '@domain/entities/project';
import { ProjectRepository } from '@domain/ports/ProjectRepository';
import { IClassSoTypeRepository } from '@domain/ports/IClassSoTypeRepository';
import { IClassSoTypeNotFoundError, IClassSoTypeInactiveError } from '@domain/errors/iclass';
import { ProjectNotFoundError } from '@domain/errors/projects';

/**
 * Assigns (or clears) an IClass SO type mapping on a project.
 *
 * - If iclassSoTypeId is null → clear the mapping (always allowed).
 * - If non-null → validate the type exists and is active, then persist.
 *
 * Throws:
 *  - IClassSoTypeNotFoundError if the type id does not exist.
 *  - IClassSoTypeInactiveError if the type is not active.
 *  - ProjectNotFoundError if the project does not exist.
 */
export class AssignIClassSoTypeToProject {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly soTypes: IClassSoTypeRepository,
  ) {}

  async execute(projectId: string, iclassSoTypeId: string | null): Promise<Project> {
    if (iclassSoTypeId !== null) {
      const soType = await this.soTypes.getById(iclassSoTypeId);
      if (!soType) throw new IClassSoTypeNotFoundError(iclassSoTypeId);
      if (!soType.active) throw new IClassSoTypeInactiveError(soType.code);
    }

    const updated = await this.projects.updateIClassSoType(projectId, iclassSoTypeId);
    if (!updated) throw new ProjectNotFoundError(projectId);

    return updated;
  }
}
