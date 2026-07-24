import { randomUUID } from 'crypto';
import { NocAlert, NocAlertInput, computeNocAlertIngest } from '@domain/entities/nocAlert';
import { NocAlertRepository, NocAlertListFilters } from '@domain/ports/NocAlertRepository';

export class InMemoryNocAlertRepository implements NocAlertRepository {
  private readonly byId = new Map<string, NocAlert>();

  private findBySourceFingerprint(source: string, fingerprint: string): NocAlert | null {
    for (const alert of this.byId.values()) {
      if (alert.source === source && alert.fingerprint === fingerprint) return alert;
    }
    return null;
  }

  async upsertByFingerprint(input: NocAlertInput): Promise<NocAlert> {
    const existing = this.findBySourceFingerprint(input.source, input.fingerprint);
    const next = computeNocAlertIngest(existing, input, new Date().toISOString(), randomUUID);
    this.byId.set(next.id, next);
    return { ...next };
  }

  async findById(id: string): Promise<NocAlert | null> {
    const alert = this.byId.get(id);
    return alert ? { ...alert } : null;
  }

  async list(filters: NocAlertListFilters): Promise<NocAlert[]> {
    return [...this.byId.values()]
      .filter((a) => (filters.source ? a.source === filters.source : true))
      .filter((a) => (filters.severity ? a.severity === filters.severity : true))
      .filter((a) => (filters.status ? a.status === filters.status : true))
      .filter((a) => (filters.acknowledged !== undefined ? a.acknowledged === filters.acknowledged : true))
      .map((a) => ({ ...a }));
  }

  async acknowledge(id: string, by: string, at: string, note?: string): Promise<NocAlert | null> {
    const existing = this.byId.get(id);
    if (!existing) return null;
    const updated: NocAlert = {
      ...existing,
      acknowledged: true,
      ackBy: by,
      ackAt: at,
      ackNote: note ?? existing.ackNote,
      updatedAt: at,
    };
    this.byId.set(id, updated);
    return { ...updated };
  }

  /** Test seam — pre-populate a row directly (bypasses the ingest lifecycle rules). */
  seed(alert: NocAlert): void {
    this.byId.set(alert.id, { ...alert });
  }
}
