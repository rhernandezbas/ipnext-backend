import { IClassTeam } from '@domain/entities/iclass-team';

export interface UpsertTeamInput {
  login: string;
  name: string;
  thirdPartyCode: string | null;
  active: boolean;
  selectable: boolean;
}

/**
 * Port for persisting the IClass team catalog.
 * Mirrors IClassNodeRepository — per-entry upsert by `login` + markInactiveExcept.
 */
export interface IClassTeamRepository {
  list(filter?: { active?: boolean; selectable?: boolean }): Promise<IClassTeam[]>;
  getByLogin(login: string): Promise<IClassTeam | null>;
  /**
   * Upserts a team by `login`. Reactivates if previously inactive.
   * Returns the outcome status for count aggregation.
   */
  upsertByLogin(team: UpsertTeamInput): Promise<{ status: 'created' | 'updated' | 'reactivated' }>;
  /**
   * Marks `active=false` every row whose `login` is NOT in `presentLogins`.
   * Returns the count of rows deactivated.
   */
  markInactiveExcept(presentLogins: string[]): Promise<number>;
}
