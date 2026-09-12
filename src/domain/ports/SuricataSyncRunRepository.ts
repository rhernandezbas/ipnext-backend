import type { SuricataSyncRunRecord, FinishSuricataSyncRunInput } from '@domain/entities/suricata';

export interface SuricataSyncRunRepository {
  /** Creates a new row, `outcome='running'`. */
  start(): Promise<SuricataSyncRunRecord>;
  finish(id: string, input: FinishSuricataSyncRunInput): Promise<SuricataSyncRunRecord>;
  /**
   * MIRROR-1/2 — the watermark: the most recent run whose `outcome` is `ok` or
   * `degraded` (a `degraded` run still persisted real data — only `failed`
   * with zero writes must NOT advance the watermark, D6.d).
   */
  lastSuccessful(): Promise<SuricataSyncRunRecord | null>;
}
