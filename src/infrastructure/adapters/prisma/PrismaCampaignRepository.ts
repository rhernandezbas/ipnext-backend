import type { Campaign, CampaignRecipient } from '@domain/entities/campaign';
import type {
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
import type { PaginatedResult } from '@application/dto/pagination';
import { prisma } from '../../database/prisma';

/**
 * messaging-bulk (F2, Batch 7, T7.4) — implementación Prisma real de
 * `CampaignRepository` contra los modelos `Campaign`/`CampaignRecipient`
 * (Batch 1, `prisma/schema.prisma`). Molde `PrismaCustomerRepository` (mappers
 * puros exportados, Date→ISO string, Decimal-safe donde aplica).
 *
 * Sin test unitario propio contra Prisma real (no hay DB local, regla
 * CLAUDE.md — mismo criterio documentado que `PrismaCustomerRepository.
 * registerOptOut`). Se ejercita indirectamente por `messagingBulk.routes.test.ts`
 * (T7.2), que usa `InMemoryCampaignRepository` para el seam de rutas — la ÚNICA
 * verificación real de ESTE archivo es el gate EN VIVO de Batch 9 +
 * `prisma migrate deploy` en CI.
 */
export function toCampaign(row: any): Campaign {
  return {
    id: row.id,
    name: row.name,
    templateRef: row.templateRef,
    templateName: row.templateName ?? null,
    templateBody: row.templateBody ?? null,
    segment: row.segment,
    variableSpec: row.variableSpec,
    status: row.status,
    total: row.total,
    sentCount: row.sentCount,
    failedCount: row.failedCount,
    skippedCount: row.skippedCount,
    optedOutCount: row.optedOutCount,
    createdById: row.createdById,
    error: row.error ?? null,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    startedAt: row.startedAt instanceof Date ? row.startedAt.toISOString() : (row.startedAt ?? null),
    finishedAt: row.finishedAt instanceof Date ? row.finishedAt.toISOString() : (row.finishedAt ?? null),
  };
}

export function toCampaignRecipient(row: any): CampaignRecipient {
  return {
    id: row.id,
    campaignId: row.campaignId,
    clientId: row.clientId,
    phoneNormalized: row.phoneNormalized,
    phoneE164: row.phoneE164,
    status: row.status,
    providerId: row.providerId ?? null,
    chatwootConversationId: row.chatwootConversationId ?? null,
    conversationId: row.conversationId ?? null,
    error: row.error ?? null,
    sentAt: row.sentAt instanceof Date ? row.sentAt.toISOString() : (row.sentAt ?? null),
    deliveredAt: row.deliveredAt instanceof Date ? row.deliveredAt.toISOString() : (row.deliveredAt ?? null),
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
  };
}

export class PrismaCampaignRepository implements CampaignRepository, ActiveCampaignLookup {
  /**
   * Change 3 (ActiveCampaignLookup) — campañas EN VUELO (`pending`/`running`/
   * `paused`) que referencian `templateRef`. Guard de borrado de templates: no
   * borrar un template en uso por una campaña que todavía puede enviarlo. `paused`
   * cuenta (es reanudable) — mismo criterio que `deriveLiveCounters`/`ListCampaigns`.
   */
  async listActiveByTemplateRef(templateRef: string): Promise<Campaign[]> {
    const rows = await prisma.campaign.findMany({
      where: { templateRef, status: { in: ['pending', 'running', 'paused'] } },
    });
    return rows.map(toCampaign);
  }

  async create(data: CampaignCreateData): Promise<Campaign> {
    const row = await prisma.campaign.create({
      data: {
        name: data.name,
        templateRef: data.templateRef,
        templateName: data.templateName ?? null,
        templateBody: data.templateBody ?? null,
        segment: data.segment as never,
        variableSpec: data.variableSpec as never,
        total: data.total,
        createdById: data.createdById,
      },
    });
    return toCampaign(row);
  }

  async findById(id: string): Promise<Campaign | null> {
    const row = await prisma.campaign.findUnique({ where: { id } });
    return row ? toCampaign(row) : null;
  }

  async update(id: string, patch: CampaignPatch): Promise<Campaign> {
    const row = await prisma.campaign.update({
      where: { id },
      data: {
        ...(patch.status !== undefined ? { status: patch.status as never } : {}),
        ...(patch.sentCount !== undefined ? { sentCount: patch.sentCount } : {}),
        ...(patch.failedCount !== undefined ? { failedCount: patch.failedCount } : {}),
        ...(patch.skippedCount !== undefined ? { skippedCount: patch.skippedCount } : {}),
        ...(patch.optedOutCount !== undefined ? { optedOutCount: patch.optedOutCount } : {}),
        ...(patch.error !== undefined ? { error: patch.error } : {}),
        ...(patch.startedAt !== undefined ? { startedAt: patch.startedAt ? new Date(patch.startedAt) : null } : {}),
        ...(patch.finishedAt !== undefined ? { finishedAt: patch.finishedAt ? new Date(patch.finishedAt) : null } : {}),
      },
    });
    return toCampaign(row);
  }

  async list(query: ListCampaignsQuery): Promise<PaginatedResult<Campaign>> {
    const page = query.page && query.page > 0 ? query.page : 1;
    const limit = query.limit && query.limit > 0 ? query.limit : 25;
    const [rows, total] = await Promise.all([
      prisma.campaign.findMany({
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.campaign.count(),
    ]);
    return { data: rows.map(toCampaign), total, page, limit };
  }

  /**
   * Idempotente por `@@unique[campaignId, clientId]` — `createMany` con
   * `skipDuplicates` no re-inserta filas ya existentes; el re-fetch por
   * `clientId IN (...)` devuelve el set completo (nuevas + ya existentes),
   * mismo contrato que `InMemoryCampaignRepository.bulkCreateRecipients`.
   */
  async bulkCreateRecipients(campaignId: string, rows: CampaignRecipientCreateRow[]): Promise<CampaignRecipient[]> {
    if (rows.length === 0) return [];
    await prisma.campaignRecipient.createMany({
      data: rows.map((r) => ({
        campaignId,
        clientId: r.clientId,
        phoneNormalized: r.phoneNormalized,
        phoneE164: r.phoneE164,
      })),
      skipDuplicates: true,
    });
    const clientIds = rows.map((r) => r.clientId);
    const persisted = await prisma.campaignRecipient.findMany({
      where: { campaignId, clientId: { in: clientIds } },
    });
    return persisted.map(toCampaignRecipient);
  }

  async updateRecipient(id: string, patch: CampaignRecipientPatch): Promise<CampaignRecipient> {
    const row = await prisma.campaignRecipient.update({
      where: { id },
      data: {
        ...(patch.status !== undefined ? { status: patch.status as never } : {}),
        ...(patch.providerId !== undefined ? { providerId: patch.providerId } : {}),
        ...(patch.chatwootConversationId !== undefined ? { chatwootConversationId: patch.chatwootConversationId } : {}),
        ...(patch.conversationId !== undefined ? { conversationId: patch.conversationId } : {}),
        ...(patch.error !== undefined ? { error: patch.error } : {}),
        ...(patch.sentAt !== undefined ? { sentAt: patch.sentAt ? new Date(patch.sentAt) : null } : {}),
        ...(patch.deliveredAt !== undefined ? { deliveredAt: patch.deliveredAt ? new Date(patch.deliveredAt) : null } : {}),
      },
    });
    return toCampaignRecipient(row);
  }

  async listRecipients(campaignId: string, filter?: ListRecipientsFilter): Promise<PaginatedResult<CampaignRecipient>> {
    const page = filter?.page && filter.page > 0 ? filter.page : 1;
    const limit = filter?.limit && filter.limit > 0 ? filter.limit : 25;
    const where: Record<string, unknown> = { campaignId };
    if (filter?.statusIn?.length) where['status'] = { in: filter.statusIn };
    const [rows, total] = await Promise.all([
      prisma.campaignRecipient.findMany({
        where,
        // FIX-4 — ORDEN TOTAL ESTABLE: `bulkCreateRecipients` usa `createMany`,
        // que escribe `createdAt` IDÉNTICO en todas las filas → empates. Ordenar
        // SOLO por `createdAt` deja el desempate indefinido en Postgres, y la
        // paginación `skip/take` sobre un set que muta (recipients saliendo del
        // filtro al pasar a `sent`) podía SALTEAR un recipient → nunca procesado.
        // El tiebreaker por `id` da un orden total determinístico.
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.campaignRecipient.count({ where }),
    ]);
    return { data: rows.map(toCampaignRecipient), total, page, limit };
  }

  /**
   * FIX-4-v2 — keyset sobre el orden total `[createdAt, id]` (el MISMO que
   * `listRecipients` fija en FIX-4). El cursor `after` se traduce al predicado
   * SQL estándar `(createdAt > x) OR (createdAt = x AND id > y)`, AND-eado con
   * `campaignId` + `status IN`. `take: limit` acota el batch → memoria O(limit)
   * en toda la corrida (sin cargar los 50-100k `queued/failed` de golpe).
   *
   * Precisión del cursor: Prisma mapea `DateTime` a `timestamp(3)` (milisegundos)
   * en Postgres, la MISMA precisión que el `Date` de JS, así que el round-trip
   * ISO→Date del cursor es exacto y la rama de igualdad `createdAt = x` no pierde
   * filas empatadas (createMany escribe el MISMO `createdAt` a todo el lote).
   */
  async listRecipientsKeyset(
    campaignId: string,
    filter: ListRecipientsKeysetFilter,
  ): Promise<CampaignRecipient[]> {
    const limit = filter.limit && filter.limit > 0 ? filter.limit : 25;
    const where: Record<string, unknown> = { campaignId };
    if (filter.statusIn?.length) where['status'] = { in: filter.statusIn };
    if (filter.after) {
      const cursorDate = new Date(filter.after.createdAt);
      where['OR'] = [
        { createdAt: { gt: cursorDate } },
        { createdAt: cursorDate, id: { gt: filter.after.id } },
      ];
    }
    const rows = await prisma.campaignRecipient.findMany({
      where,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });
    return rows.map(toCampaignRecipient);
  }
}
