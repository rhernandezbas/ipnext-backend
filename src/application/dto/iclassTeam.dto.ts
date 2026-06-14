import { IClassTeam } from '@domain/entities/iclass-team';

/** API wire shape for a single IClass team catalog entry (whitelist). */
export interface IClassTeamDTO {
  login: string;
  name: string;
  thirdPartyCode: string | null;
  active: boolean;
  selectable: boolean;
  lastSyncedAt: string; // ISO 8601
}

/** Maps an entity to the API DTO. */
export function toIClassTeamDTO(team: IClassTeam): IClassTeamDTO {
  return {
    login: team.login,
    name: team.name,
    thirdPartyCode: team.thirdPartyCode,
    active: team.active,
    selectable: team.selectable,
    lastSyncedAt: team.lastSyncedAt instanceof Date
      ? team.lastSyncedAt.toISOString()
      : team.lastSyncedAt,
  };
}
