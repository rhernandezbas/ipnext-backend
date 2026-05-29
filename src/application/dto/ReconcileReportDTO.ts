/**
 * Read-only reconcile report: bidirectional set-diff between the GR full
 * universe and the local client mirror. Wire-shaped — returned directly by the
 * endpoint. Never carries Prisma entities nor raw GR JSON.
 */
export interface ReconcileReportDTO {
  /** Count of distinct grClienteId in the local mirror. */
  localTotal: number;
  /** Count of distinct grClienteId in the GR full universe. */
  grTotal: number;
  /** localOnly.length — orphan candidates (present locally, absent in GR). */
  localOnlyCount: number;
  /** grOnly.length — missing inserts (present in GR, absent locally). */
  grOnlyCount: number;
  /** grClienteId present locally and absent in GR. */
  localOnly: string[];
  /** grClienteId present in GR and absent locally. */
  grOnly: string[];
}
