import { randomUUID } from 'crypto';
import { Campaign, CampaignRecipient } from '@domain/entities/campaign';
import {
  CampaignRepository,
  ActiveCampaignLookup,
  CampaignCreateData,
  CampaignPatch,
  CampaignRecipientCreateRow,
  CampaignRecipientPatch,
  ListCampaignsQuery,
  ListRecipientsFilter,
  ListRecipientsKeysetFilter,
} from '@domain/ports/CampaignRepository';
import { PaginatedResult } from '@application/dto/pagination';

const DEFAULT_PAGE_SIZE = 25;

/**
 * InMemoryCampaignRepository — test seam para CampaignRepository (messaging-bulk
 * F2, T3.1). Molde InMemoryServiceCutBatchRepository (Map-backed por id).
 * `now()` inyectable para createdAt deterministas en tests.
 */
export class InMemoryCampaignRepository implements CampaignRepository, ActiveCampaignLookup {
  private readonly campaigns = new Map<string, Campaign>();
  private readonly recipients = new Map<string, CampaignRecipient>();
  private readonly now: () => Date;

  constructor(opts?: { now?: () => Date }) {
    this.now = opts?.now ?? (() => new Date());
  }

  async create(data: CampaignCreateData): Promise<Campaign> {
    const campaign: Campaign = {
      id: randomUUID(),
      name: data.name,
      templateRef: data.templateRef,
      templateName: data.templateName ?? null,
      segment: data.segment,
      variableSpec: data.variableSpec,
      status: 'pending',
      total: data.total,
      sentCount: 0,
      failedCount: 0,
      skippedCount: 0,
      optedOutCount: 0,
      createdById: data.createdById,
      error: null,
      createdAt: this.now().toISOString(),
      startedAt: null,
      finishedAt: null,
    };
    this.campaigns.set(campaign.id, campaign);
    return { ...campaign };
  }

  async findById(id: string): Promise<Campaign | null> {
    const c = this.campaigns.get(id);
    return c ? { ...c } : null;
  }

  /**
   * Change 3 (ActiveCampaignLookup) — campañas EN VUELO (`pending`/`running`/
   * `paused`) que usan `templateRef` como template. Guard de borrado de templates.
   * `paused` cuenta como en-vuelo (una campaña pausada puede reanudarse y volver a
   * enviar el template) — mismo criterio que `deriveLiveCounters`/`ListCampaigns`.
   */
  async listActiveByTemplateRef(templateRef: string): Promise<Campaign[]> {
    return Array.from(this.campaigns.values())
      .filter(
        (c) =>
          c.templateRef === templateRef &&
          (c.status === 'pending' || c.status === 'running' || c.status === 'paused'),
      )
      .map((c) => ({ ...c }));
  }

  async update(id: string, patch: CampaignPatch): Promise<Campaign> {
    const c = this.campaigns.get(id);
    if (!c) throw new Error(`Campaign ${id} not found`);
    if (patch.status !== undefined) c.status = patch.status;
    if (patch.sentCount !== undefined) c.sentCount = patch.sentCount;
    if (patch.failedCount !== undefined) c.failedCount = patch.failedCount;
    if (patch.skippedCount !== undefined) c.skippedCount = patch.skippedCount;
    if (patch.optedOutCount !== undefined) c.optedOutCount = patch.optedOutCount;
    if (patch.error !== undefined) c.error = patch.error;
    if (patch.startedAt !== undefined) c.startedAt = patch.startedAt;
    if (patch.finishedAt !== undefined) c.finishedAt = patch.finishedAt;
    return { ...c };
  }

  async list(query: ListCampaignsQuery): Promise<PaginatedResult<Campaign>> {
    const all = Array.from(this.campaigns.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const limit = query.limit && query.limit > 0 ? query.limit : DEFAULT_PAGE_SIZE;
    const page = query.page && query.page > 0 ? query.page : 1;
    const start = (page - 1) * limit;
    const data = all.slice(start, start + limit).map((c) => ({ ...c }));
    return { data, total: all.length, page, limit };
  }

  async bulkCreateRecipients(
    campaignId: string,
    rows: CampaignRecipientCreateRow[],
  ): Promise<CampaignRecipient[]> {
    const result: CampaignRecipient[] = [];
    for (const row of rows) {
      const existing = Array.from(this.recipients.values()).find(
        (r) => r.campaignId === campaignId && r.clientId === row.clientId,
      );
      if (existing) {
        result.push({ ...existing });
        continue;
      }
      const recipient: CampaignRecipient = {
        id: randomUUID(),
        campaignId,
        clientId: row.clientId,
        phoneNormalized: row.phoneNormalized,
        phoneE164: row.phoneE164,
        status: 'queued',
        providerId: null,
        chatwootConversationId: null,
        error: null,
        sentAt: null,
        deliveredAt: null,
        createdAt: this.now().toISOString(),
      };
      this.recipients.set(recipient.id, recipient);
      result.push({ ...recipient });
    }
    return result;
  }

  async updateRecipient(id: string, patch: CampaignRecipientPatch): Promise<CampaignRecipient> {
    const r = this.recipients.get(id);
    if (!r) throw new Error(`CampaignRecipient ${id} not found`);
    if (patch.status !== undefined) r.status = patch.status;
    if (patch.providerId !== undefined) r.providerId = patch.providerId;
    if (patch.chatwootConversationId !== undefined) r.chatwootConversationId = patch.chatwootConversationId;
    if (patch.error !== undefined) r.error = patch.error;
    if (patch.sentAt !== undefined) r.sentAt = patch.sentAt;
    if (patch.deliveredAt !== undefined) r.deliveredAt = patch.deliveredAt;
    return { ...r };
  }

  async listRecipients(
    campaignId: string,
    filter?: ListRecipientsFilter,
  ): Promise<PaginatedResult<CampaignRecipient>> {
    let all = Array.from(this.recipients.values()).filter((r) => r.campaignId === campaignId);
    if (filter?.statusIn?.length) {
      const statuses = new Set(filter.statusIn);
      all = all.filter((r) => statuses.has(r.status));
    }
    const limit = filter?.limit && filter.limit > 0 ? filter.limit : DEFAULT_PAGE_SIZE;
    const page = filter?.page && filter.page > 0 ? filter.page : 1;
    const start = (page - 1) * limit;
    const data = all.slice(start, start + limit).map((r) => ({ ...r }));
    return { data, total: all.length, page, limit };
  }

  /**
   * FIX-4-v2 — keyset sobre el orden total `[createdAt, id]` (molde del adapter
   * Prisma). Estable, determinístico; `after` avanza el cursor. `limit` acota el
   * batch (memoria O(limit)).
   */
  async listRecipientsKeyset(
    campaignId: string,
    filter: ListRecipientsKeysetFilter,
  ): Promise<CampaignRecipient[]> {
    let all = Array.from(this.recipients.values()).filter((r) => r.campaignId === campaignId);
    if (filter.statusIn?.length) {
      const statuses = new Set(filter.statusIn);
      all = all.filter((r) => statuses.has(r.status));
    }
    all.sort((a, b) =>
      a.createdAt !== b.createdAt ? a.createdAt.localeCompare(b.createdAt) : a.id.localeCompare(b.id),
    );
    const after = filter.after;
    if (after) {
      all = all.filter(
        (r) => r.createdAt > after.createdAt || (r.createdAt === after.createdAt && r.id > after.id),
      );
    }
    const limit = filter.limit && filter.limit > 0 ? filter.limit : DEFAULT_PAGE_SIZE;
    return all.slice(0, limit).map((r) => ({ ...r }));
  }
}
