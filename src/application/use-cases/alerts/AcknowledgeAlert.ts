import { NocAlert } from '@domain/entities/nocAlert';
import { NocAlertRepository } from '@domain/ports/NocAlertRepository';

/**
 * AcknowledgeAlert — sets ackBy/ackAt (and an optional ackNote) on an existing
 * NocAlert. MTTA (ackAt - startsAt) is NOT computed here — spec.md says it's
 * exposed by the DTO (`toNocAlertDto`), so it's derived uniformly for both a
 * fresh ack and any later read (ListAlerts) from the same persisted fields.
 *
 * Non-existent id → does NOT throw; returns null (route maps it to 404).
 */
export class AcknowledgeAlert {
  constructor(private readonly repo: NocAlertRepository) {}

  execute(id: string, by: string, at: string, note?: string): Promise<NocAlert | null> {
    return this.repo.acknowledge(id, by, at, note);
  }
}
