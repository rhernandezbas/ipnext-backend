/**
 * Catalog entry for an IClass Service Order RESULT CODE (motivoFechamento).
 *
 * Synced from IClass (`/serviceordertypes/{id}/resultcodes`). The `mappedStageId`
 * is the CONFIGURABLE closure mapping (mirrors Project.iclassSoTypeId): when a
 * closed SO carries this result code, the linked task is moved to that Stage.
 * Null = unmapped (the task is left untouched for manual review).
 */
export interface IClassResultCode {
  id: string;
  /** IClass SO type id this result code belongs to (string-encoded BigInt). Null if global. */
  soTypeId: string | null;
  /** The result-code name — equals motivoFechamento on a closed SO. */
  code: string;
  /** Sucesso | Falha | ... */
  type: string;
  /** Configurable target Stage for the closure transition. Null = unmapped. */
  mappedStageId: string | null;
  /** Resolved Stage name (derived via JOIN; null when unmapped). */
  mappedStageName: string | null;
  /**
   * EPIC #38 W4 — configurable removal-code gate. When true AND `type === 'Sucesso'`,
   * a closing SO with this result code stages equipment-return suggestions. Default false;
   * seeded true for the 2 confirmed retiro codes. Lets ops add codes without a redeploy.
   */
  isRemovalCode: boolean;
  lastSyncedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}
