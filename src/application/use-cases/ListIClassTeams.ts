import { IClassTeam } from '@domain/entities/iclass-team';
import { IClassTeamRepository } from '@domain/ports/IClassTeamRepository';

/**
 * Returns the persisted IClass team catalog, optionally filtered by active/selectable.
 * Thin wrapper over the repository. Clone of ListIClassNodeCatalog, keyed by login.
 */
export class ListIClassTeams {
  constructor(private readonly repo: IClassTeamRepository) {}

  execute(filter?: { active?: boolean; selectable?: boolean }): Promise<IClassTeam[]> {
    return this.repo.list(filter);
  }
}
