/**
 * Persisted catalog entry for an IClass team (equipe).
 * Synced from IClass `GET /teams`. The `login` field is the stable unique key
 * used for upserts — same pattern as IClassNode (keyed by nodeId) but IClass
 * teams use login as their stable identifier.
 *
 * `selectable=false` flags organizational groupers (non-assignable teams).
 */
export interface IClassTeam {
  id: string;
  /** IClass team login — stable unique key for upserts. */
  login: string;
  name: string;
  thirdPartyCode: string | null;
  active: boolean;
  selectable: boolean;
  lastSyncedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}
