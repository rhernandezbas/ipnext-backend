import { ProjectRepository } from '@domain/ports/ProjectRepository';
import { ProjectHasActiveTasksError } from '@domain/errors/projects';

/**
 * Soft-deletes a project (sets visible=false) so historical tasks keep their
 * project reference. Blocks the operation if the project still has tasks in
 * active stage categories ("nuevo" or "enProgreso"); the caller must close /
 * cancel those tasks first.
 *
 * Returns `false` when the project does not exist (no-op) — symmetric with
 * the original hard-delete contract so the HTTP layer can keep returning 404.
 */
export class DeleteProject {
  constructor(private readonly repo: ProjectRepository) {}

  async execute(id: string): Promise<boolean> {
    const project = await this.repo.get(id);
    if (!project) return false;

    const counts = project.taskCounts ?? { nuevo: 0, enProgreso: 0, hecho: 0, total: 0 };
    if (counts.nuevo > 0 || counts.enProgreso > 0) {
      throw new ProjectHasActiveTasksError(id, {
        nuevo: counts.nuevo,
        enProgreso: counts.enProgreso,
      });
    }

    const updated = await this.repo.update(id, { visible: false });
    return updated !== null;
  }
}
