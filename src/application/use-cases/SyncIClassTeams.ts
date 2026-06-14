import { IClassPort } from '@domain/ports/IClassPort';
import { IClassTeamRepository } from '@domain/ports/IClassTeamRepository';

export interface SyncTeamsResult {
  /** Total teams processed (upserted) from IClass after discarding empty logins. */
  synced: number;
  created: number;
  updated: number;
  reactivated: number;
  deactivated: number;
}

/**
 * Grouping teams in IClass — organizational containers, not assignable cuadrillas.
 * Persisted (audit) but flagged selectable=false so they don't appear in the
 * assign-team selector.
 *
 * Mirrors NON_SELECTABLE_NODE_CODES from SyncIClassNodes.
 *
 * Populate this list with real grouping logins once confirmed in the live environment (§10).
 * Example: ['COORD-GENERAL', 'ADMIN-TEAM']
 */
export const NON_SELECTABLE_TEAM_LOGINS: string[] = [
  // TODO: add real grouping logins after live validation (§10)
];

/**
 * Syncs the IClass team catalog into the local repository.
 * Clone of SyncIClassNodes, keyed by `login` instead of `nodeId`.
 *
 * Flow:
 * 1. Fetch all teams from IClass via listTeams().
 * 2. Discard teams whose `login` is empty after trimming.
 * 3. Upsert each by `login`, marking grouping logins as selectable=false.
 * 4. Mark inactive every team NOT present in the IClass response.
 *
 * The `update` path in upsertByLogin does NOT overwrite operator-managed config
 * beyond what the sync owns (name, thirdPartyCode, active, selectable) — following
 * the same pattern as SyncIClassNodes/PrismaIClassNodeRepository.
 *
 * Throws IClassUnavailableError if IClass is unreachable (propagated from the port).
 */
export class SyncIClassTeams {
  constructor(
    private readonly iclass: IClassPort,
    private readonly repo: IClassTeamRepository,
  ) {}

  async execute(): Promise<SyncTeamsResult> {
    const descriptors = await this.iclass.listTeams();

    const present = descriptors
      .map(d => ({
        login: d.login.trim(),
        name: d.name,
        thirdPartyCode: d.thirdPartyCode ?? null,
      }))
      .filter(d => d.login.length > 0);

    let created = 0;
    let updated = 0;
    let reactivated = 0;

    for (const team of present) {
      const selectable = !NON_SELECTABLE_TEAM_LOGINS.includes(team.login);
      const { status } = await this.repo.upsertByLogin({
        login: team.login,
        name: team.name,
        thirdPartyCode: team.thirdPartyCode,
        active: true,
        selectable,
      });
      if (status === 'created') created++;
      else if (status === 'updated') updated++;
      else if (status === 'reactivated') reactivated++;
    }

    const presentLogins = present.map(t => t.login);
    const deactivated = await this.repo.markInactiveExcept(presentLogins);

    return {
      synced: present.length,
      created,
      updated,
      reactivated,
      deactivated,
    };
  }
}
