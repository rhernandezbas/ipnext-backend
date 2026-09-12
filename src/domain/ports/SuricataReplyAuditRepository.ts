import type {
  SuricataReplyAuditRecord,
  RecordSuricataReplyAttemptInput,
  MarkSuricataReplyOutcomeInput,
} from '@domain/entities/suricata';

/**
 * suricata-tickets-mirror (Phase E, task E.1, design D3/D10) — `record` is
 * called BEFORE the shared session is ever touched, auditing the ATTEMPT and
 * not the outcome (REPLY-4): the row starts `outcome='failed'` provisionally.
 * `markOutcome` later flips it to `'sent'` (with `sentAt`) or leaves it
 * `'failed'` with the concrete `error` once the actual send resolves.
 */
export interface SuricataReplyAuditRepository {
  record(input: RecordSuricataReplyAttemptInput): Promise<SuricataReplyAuditRecord>;
  markOutcome(id: string, input: MarkSuricataReplyOutcomeInput): Promise<SuricataReplyAuditRecord>;
}
