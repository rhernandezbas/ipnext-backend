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
import { UniqueConstraintViolationError } from '@domain/errors/persistence';

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

  /**
   * fix wave F2 (NEW-1) — paridad campo-a-campo con el `@@unique([externalIdempotencyKey])`
   * real de `PrismaCampaignRepository` (D1.a): sin este chequeo, un test de
   * carrera contra el in-memory nunca podia ejercitar el path REAL de
   * `UniqueConstraintViolationError` que `SendExternalBulk` cachea (fix wave F1
   * F5) — quedaba testeado solo con un spy que inyectaba el error a mano.
   */
  async create(data: CampaignCreateData): Promise<Campaign> {
    if (data.externalIdempotencyKey != null) {
      const clash = Array.from(this.campaigns.values()).find(
        (c) => c.externalIdempotencyKey === data.externalIdempotencyKey,
      );
      if (clash) {
        throw new UniqueConstraintViolationError('Campaign', 'externalIdempotencyKey');
      }
    }
    const campaign: Campaign = {
      id: randomUUID(),
      name: data.name,
      templateRef: data.templateRef,
      templateName: data.templateName ?? null,
      templateBody: data.templateBody ?? null,
      chatwootLabel: data.chatwootLabel ?? null,
      externalIdempotencyKey: data.externalIdempotencyKey ?? null,
      segment: data.segment,
      variableSpec: data.variableSpec,
      recipientStatuses: data.recipientStatuses ?? [],
      hasRawRecipients: data.hasRawRecipients ?? false,
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

  /** external-bulk-messaging (D3, GUARD-0) — lookup por la key dedicada del caller M2M. */
  async findByExternalIdempotencyKey(key: string): Promise<Campaign | null> {
    const c = Array.from(this.campaigns.values()).find((x) => x.externalIdempotencyKey === key);
    return c ? { ...c } : null;
  }

  /**
   * external-bulk-messaging (D3.a/D6, fix wave F1 — finding F2) — cuenta los
   * `CampaignRecipient` AUTORIZADOS (`createdAt >= since`, inclusivo; status
   * NOT IN skipped/opted_out) de campañas creadas por `createdById`. Mirror
   * EXACTO campo-a-campo del filtro de `PrismaCampaignRepository`.
   */
  async countAuthorizedRecipientsByCreatorSince(createdById: string, since: Date): Promise<number> {
    let count = 0;
    for (const r of this.recipients.values()) {
      if (r.status === 'skipped' || r.status === 'opted_out') continue;
      if (new Date(r.createdAt).getTime() < since.getTime()) continue;
      const campaign = this.campaigns.get(r.campaignId);
      if (campaign?.createdById !== createdById) continue;
      count++;
    }
    return count;
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

  /**
   * bulk-csv-recipients (PER-2) — la idempotencia pasa de `clientId` a
   * `phoneNormalized`: el `@@unique[campaignId, clientId]` real NO protege filas
   * contact (`clientId: null`, Postgres trata cada NULL como distinto). Molde del
   * adapter Prisma (D2) — `phoneNormalized` es NOT NULL SIEMPRE y único dentro del
   * set ya deduplicado por `resolveCombinedRecipients` (FIX-1/CSV-4), así que el
   * cambio es transparente para las filas vinculadas (mismo resultado que antes).
   */
  async bulkCreateRecipients(
    campaignId: string,
    rows: CampaignRecipientCreateRow[],
  ): Promise<CampaignRecipient[]> {
    const result: CampaignRecipient[] = [];
    for (const row of rows) {
      // bulk-task-stage-transition — idempotencia: filas task por `taskId` (dos tareas del
      // mismo cliente/teléfono son DOS recipients, decisión 3); el resto por `phoneNormalized`
      // (comportamiento previo). Mirror del @@unique([campaignId, taskId]) real (NULLs distintos).
      const existing = Array.from(this.recipients.values()).find((r) => {
        if (r.campaignId !== campaignId) return false;
        if (row.taskId != null) return r.taskId === row.taskId;
        return r.taskId === null && r.phoneNormalized === row.phoneNormalized;
      });
      if (existing) {
        result.push({ ...existing });
        continue;
      }
      const recipient: CampaignRecipient = {
        id: randomUUID(),
        campaignId,
        clientId: row.clientId,
        contactName: row.contactName ?? null,
        phoneNormalized: row.phoneNormalized,
        phoneE164: row.phoneE164,
        variables: row.variables ?? null,
        status: 'queued',
        providerId: null,
        chatwootConversationId: null,
        conversationId: null,
        error: null,
        taskId: row.taskId ?? null,
        taskFromStageId: row.taskFromStageId ?? null,
        taskResultingStageId: row.taskResultingStageId ?? null,
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
    if (patch.conversationId !== undefined) r.conversationId = patch.conversationId;
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
