import { randomUUID } from 'crypto';
import { ExternalBulkPreview } from '@domain/entities/externalBulkPreview';
import {
  ExternalBulkPreviewRepository,
  ExternalBulkPreviewCreateData,
} from '@domain/ports/ExternalBulkPreviewRepository';

/**
 * external-bulk-messaging (1.5) — test seam para `ExternalBulkPreviewRepository`.
 * Molde `InMemoryCampaignRepository` (Map-backed por id). `now()` inyectable
 * para `createdAt` determinístico en tests.
 */
export class InMemoryExternalBulkPreviewRepository implements ExternalBulkPreviewRepository {
  private readonly previews = new Map<string, ExternalBulkPreview>();
  private readonly now: () => Date;

  constructor(opts?: { now?: () => Date }) {
    this.now = opts?.now ?? (() => new Date());
  }

  async create(data: ExternalBulkPreviewCreateData): Promise<ExternalBulkPreview> {
    const preview: ExternalBulkPreview = {
      id: randomUUID(),
      payloadHash: data.payloadHash,
      templateRef: data.templateRef,
      templateName: data.templateName,
      variables: { ...data.variables },
      chatwootLabel: data.chatwootLabel ?? null,
      recipients: [...data.recipients],
      invalid: [...data.invalid],
      validCount: data.validCount,
      invalidCount: data.invalidCount,
      expiresAt: data.expiresAt,
      consumedAt: null,
      campaignId: null,
      createdAt: this.now().toISOString(),
    };
    this.previews.set(preview.id, preview);
    return { ...preview };
  }

  async findById(id: string): Promise<ExternalBulkPreview | null> {
    const p = this.previews.get(id);
    return p ? { ...p } : null;
  }

  /**
   * D3.b/D8 — ganador de la carrera: SOLO gana si `consumedAt` estaba `null`
   * en el momento de esta llamada (mirror del `updateMany({where:{consumedAt:
   * null}})` de Postgres — count===1 → true).
   */
  async markConsumed(id: string, campaignId: string): Promise<boolean> {
    const p = this.previews.get(id);
    if (!p || p.consumedAt !== null) return false;
    p.consumedAt = this.now().toISOString();
    p.campaignId = campaignId;
    return true;
  }

  async deleteExpiredBefore(before: Date, limit: number): Promise<number> {
    const expired = Array.from(this.previews.values())
      .filter((p) => new Date(p.expiresAt) < before)
      .slice(0, limit);
    for (const p of expired) {
      this.previews.delete(p.id);
    }
    return expired.length;
  }
}
