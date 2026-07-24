import { NocAlert, NocAlertInput, NocAlertSeverity, NocAlertStatus } from '@domain/entities/nocAlert';

export interface NocAlertListFilters {
  source?: string;
  severity?: NocAlertSeverity;
  status?: NocAlertStatus;
  acknowledged?: boolean;
}

export interface NocAlertRepository {
  /** Dedup by (source, fingerprint) — see `computeNocAlertIngest` for the full rule. */
  upsertByFingerprint(input: NocAlertInput): Promise<NocAlert>;
  findById(id: string): Promise<NocAlert | null>;
  list(filters: NocAlertListFilters): Promise<NocAlert[]>;
  acknowledge(id: string, by: string, at: string, note?: string): Promise<NocAlert | null>;
}
