import { z } from 'zod';
import type { CampaignSegmentFilter } from '@domain/ports/CustomerRepository';
import type { PortalPromo } from '@domain/entities/portalPromo';
import { PortalPromoValidationError } from '@domain/errors/portalPromo.errors';

// ─── Admin DTO ───────────────────────────────────────────────────────────────

/** Admin CRUD — TODOS los campos (a diferencia del DTO client-facing, que solo
 * expone lo que el cliente necesita ver). */
export interface PortalPromoAdminDto {
  id: string;
  title: string;
  summary: string;
  body: string;
  imageStorageKey: string | null;
  ctaLabel: string;
  ticketAreaId: string | null;
  segment: CampaignSegmentFilter;
  startsAt: string;
  endsAt: string;
  publishedAt: string | null;
  archivedAt: string | null;
  authorId: string | null;
  authorName: string;
  createdAt: string;
  updatedAt: string;
}

export function toPortalPromoAdminDto(promo: PortalPromo): PortalPromoAdminDto {
  return { ...promo };
}

// ─── segment parsing (molde messagingBulk.routes.ts toCampaignSegment/toNodeApFilter) ──
// Mismo criterio: `segment` NO se valida con un z.object() rígido porque
// `statuses` acepta cualquier string del catálogo dinámico de ClientStatus —
// se normaliza a array (descartando elementos no-string) en vez de fallar.
// networkSiteId/accessPointId SÍ se validan con Zod (fail-loud en tipos
// inválidos): dejarlos pasar en silencio dejaría el filtro sin efecto y la
// promo le llegaría a MÁS gente de la que el operador configuró.

const NodeApFilterSchema = z.object({
  networkSiteId: z.string().nullish(),
  accessPointId: z.string().nullish(),
});

export function parsePromoSegment(raw: unknown): CampaignSegmentFilter {
  const seg = (raw ?? {}) as Record<string, unknown>;
  const nodeAp = NodeApFilterSchema.safeParse({
    networkSiteId: seg['networkSiteId'],
    accessPointId: seg['accessPointId'],
  });
  if (!nodeAp.success) {
    throw new PortalPromoValidationError(
      'segment.networkSiteId/accessPointId deben ser strings (o null/ausente = sin filtro)',
    );
  }
  return {
    statuses: Array.isArray(seg['statuses'])
      ? (seg['statuses'] as unknown[]).filter((s): s is string => typeof s === 'string')
      : [],
    balanceMin: typeof seg['balanceMin'] === 'number' ? (seg['balanceMin'] as number) : undefined,
    balanceMax: typeof seg['balanceMax'] === 'number' ? (seg['balanceMax'] as number) : undefined,
    ...nodeAp.data,
  };
}

// ─── Create/Update schemas ───────────────────────────────────────────────────

// Acepta string ISO o Date; rechaza cualquier cosa que no parsee a una fecha válida.
const DateInputSchema = z
  .union([z.string(), z.date()])
  .transform((v) => new Date(v))
  .refine((d) => !Number.isNaN(d.getTime()), { message: 'fecha inválida' });

const PortalPromoFieldsSchema = z.object({
  title: z.string().trim().min(1).max(200),
  summary: z.string().trim().min(1).max(500),
  body: z.string().trim().min(1).max(20000),
  imageStorageKey: z.string().trim().min(1).nullish(),
  ctaLabel: z.string().trim().min(1).max(60).optional(),
  ticketAreaId: z.string().min(1).nullish(),
  startsAt: DateInputSchema,
  endsAt: DateInputSchema,
  // Ausente/null = queda en borrador.
  publishedAt: DateInputSchema.nullish(),
});

export const CreatePortalPromoSchema = PortalPromoFieldsSchema;
export type CreatePortalPromoInput = z.infer<typeof CreatePortalPromoSchema>;

// `undefined` (key ausente) = no tocar; `null` = limpiar; valor = setear —
// mismo contrato que `UpdatePortalPromoData` (ver el port).
export const UpdatePortalPromoSchema = PortalPromoFieldsSchema.partial().extend({
  archivedAt: DateInputSchema.nullish(),
});
export type UpdatePortalPromoInput = z.infer<typeof UpdatePortalPromoSchema>;

// ─── audience-preview ────────────────────────────────────────────────────────

export interface AudiencePreviewDto {
  /** Clientes que matchean el segmento (vía `listSegmentRecipients`). */
  segmentCount: number;
  /** De esos, cuántos tienen `PortalAccount` — el único número que refleja a
   *  quién le llega DE VERDAD. */
  withAppCount: number;
}
