import { IClassPort } from '@domain/ports/IClassPort';
import { IClassTeamRepository } from '@domain/ports/IClassTeamRepository';

export interface SyncTeamsResult {
  /** Total teams processed (upserted) from IClass after discarding empty logins. */
  synced: number;
  created: number;
  updated: number;
  reactivated: number;
  /**
   * Teams marked active=false by this sync. Includes BOTH: teams absent from the
   * IClass response (markInactiveExcept) AND teams present but whose live IClass
   * `status` is `Cancelado` (see `cancelled` below for the latter alone).
   */
  deactivated: number;
  /**
   * Subset of `deactivated`: teams present in the IClass response whose `status`
   * is `Cancelado` — terminated logins, deactivated even though IClass still lists
   * them. Never counted as created/updated/reactivated (#134).
   */
  cancelled: number;
}

/** IClass team status meaning the login was terminated — see IClassTeamDescriptor. */
const CANCELLED_STATUS = 'cancelado';

function isCancelledStatus(status: string | null | undefined): boolean {
  return (status ?? '').trim().toLowerCase() === CANCELLED_STATUS;
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
 * 3. Upsert each by `login`, marking grouping logins as selectable=false, and
 *    marking `active=false` for any team whose IClass `status` is `Cancelado`
 *    (still upserted — kept for audit — but never selectable as assignable).
 * 4. Mark inactive every team NOT present at all in the IClass response.
 *
 * `login` is the ONLY identity key and is compared byte-for-byte (case-sensitive) —
 * `IPNXjulio` and `IPNXJULIO` are DIFFERENT teams in IClass and must stay separate
 * rows here too (#134). Never dedupe/normalize case.
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
        cancelled: isCancelledStatus(d.status),
      }))
      .filter(d => d.login.length > 0);

    let created = 0;
    let updated = 0;
    let reactivated = 0;
    let cancelled = 0;

    for (const team of present) {
      const selectable = !NON_SELECTABLE_TEAM_LOGINS.includes(team.login);
      const { status } = await this.repo.upsertByLogin({
        login: team.login,
        name: team.name,
        thirdPartyCode: team.thirdPartyCode,
        active: !team.cancelled,
        selectable,
      });
      // A Cancelado team is ALWAYS counted as cancelled/deactivated, regardless of
      // what the repo's created/updated/reactivated status says about its PRIOR
      // active state — the repo status only reflects whether the row was inactive
      // BEFORE this upsert, not the outcome of this sync (#134).
      if (team.cancelled) {
        cancelled++;
      } else if (status === 'created') created++;
      else if (status === 'updated') updated++;
      else if (status === 'reactivated') reactivated++;
    }

    const presentLogins = present.map(t => t.login);
    const deactivatedAbsent = await this.repo.markInactiveExcept(presentLogins);

    return {
      synced: present.length,
      created,
      updated,
      reactivated,
      deactivated: deactivatedAbsent + cancelled,
      cancelled,
    };
  }
}
