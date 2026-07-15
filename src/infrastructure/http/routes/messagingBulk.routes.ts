/**
 * messaging-bulk (F2, Batch 7, T7.1) — router `/api/messaging/bulk` (envío
 * masivo por template WhatsApp). Molde `messaging.routes.ts` (factory + perms
 * interface, auth aplicada POR RUTA). Cada handler async envuelve en
 * try/catch → next(err) (lección 504, ROB-1) — el `errorHandler` global mapea
 * los `DomainError` tipados vía `statusMap` (fuente única de verdad).
 *
 * Prefijo `/api/messaging/bulk` — el SPEC manda (tasks.md contradicción #1: el
 * design.md original proponía `/api/messaging/campaigns`, pero el spec fija
 * `/api/messaging/bulk/{templates,segment/preview,campaigns}` en TPL-1/
 * RBAC-1/RBAC-2/HIST-1/HIST-2 — `sdd-verify` valida contra el spec). Este
 * router se monta relativo a `/api/messaging/bulk` en `app.ts` (T7.3), así que
 * las rutas de acá abajo son relativas a ESE prefijo (`/templates`, no
 * `/bulk/templates`).
 */
import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { ListTemplates } from '@application/use-cases/messaging/ListTemplates';
import { PreviewCampaignSegment } from '@application/use-cases/messaging/PreviewCampaignSegment';
import { ListSegmentRecipients } from '@application/use-cases/messaging/ListSegmentRecipients';
import { CreateCampaign } from '@application/use-cases/messaging/CreateCampaign';
import { GetCampaign } from '@application/use-cases/messaging/GetCampaign';
import { ListCampaigns } from '@application/use-cases/messaging/ListCampaigns';
import type { CampaignRunner } from '@infrastructure/scheduling/CampaignRunner';
import type { PreviewSegmentInput, ListSegmentRecipientsInput, CreateCampaignInput } from '@application/dto/messaging-bulk.dto';
import type { CampaignSegment, CampaignVariableSpec, CampaignRecipientStatus } from '@domain/entities/campaign';
import { InvalidManualRecipientsError } from '@domain/errors/messaging-bulk';

/** Per-route permission guards (messaging.bulk / messaging.templates — RBAC-1/2). */
export interface MessagingBulkRoutePerms {
  bulk: RequestHandler;
  templates: RequestHandler;
}

/**
 * fix-be #7 molde (`messaging.routes.ts`) — Express tipa una query key repetida
 * (`?x=a&x=b`) como `string[]`, no `string`. Toma el PRIMER valor, mismo
 * criterio que el resto del repo para params single-value.
 */
function firstQueryValue(v: unknown): string | undefined {
  if (Array.isArray(v)) return typeof v[0] === 'string' ? v[0] : undefined;
  return typeof v === 'string' ? v : undefined;
}

/** FIX-16 — parsea un query-param numérico opcional (`undefined`/NaN → undefined). */
function parseOptionalInt(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isNaN(n) ? undefined : n;
}

/** FIX-16 — normaliza `statuses` de la query (`?statuses=a&statuses=b`, o single). */
function queryStatuses(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((s): s is string => typeof s === 'string');
  return typeof v === 'string' ? [v] : [];
}

/**
 * manual-recipients (MAN-1) — parsea `manualClientIds` del body. FIX-4 (fail-loud,
 * coherente con MAN-3): NO se descartan elementos no-string en silencio.
 *  - AUSENTE (`undefined`) → `[]` (campaña solo-segmento, válido).
 *  - PRESENTE pero NO array, o array con algún elemento no-string → 400 explícito
 *    (`InvalidManualRecipientsError` → VALIDATION_ERROR). Un id que viaje como
 *    number desaparecería mudo — contradice la filosofía fail-loud del feature.
 * Los strings vacíos/whitespace NO son "id malo": son normalización (el use case
 * los limpia con trim vía `normalizeManualClientIds`), no error de contrato.
 */
function toManualClientIds(raw: unknown): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new InvalidManualRecipientsError('manualClientIds debe ser un array de strings');
  }
  for (const el of raw) {
    if (typeof el !== 'string') {
      throw new InvalidManualRecipientsError('manualClientIds solo admite ids string (elemento no-string recibido)');
    }
  }
  return raw as string[];
}

/**
 * FIX-8 — mapea el `segment` del body a un `CampaignSegment` FIEL, sin inventar un
 * default "todos". Normaliza `statuses` a array y preserva `balanceMin/Max`. Un
 * body sin `segment` (o con `statuses` ausente) queda `{statuses:[]}` — que el
 * use case RECHAZA (UnfilteredSegmentError) en vez de resolver a toda la base.
 */
function toCampaignSegment(raw: unknown): CampaignSegment {
  const seg = (raw ?? {}) as Record<string, unknown>;
  return {
    statuses: Array.isArray(seg['statuses']) ? (seg['statuses'] as unknown[]).filter((s): s is string => typeof s === 'string') : [],
    balanceMin: typeof seg['balanceMin'] === 'number' ? (seg['balanceMin'] as number) : undefined,
    balanceMax: typeof seg['balanceMax'] === 'number' ? (seg['balanceMax'] as number) : undefined,
  };
}

export function createMessagingBulkRouter(
  listTemplates: ListTemplates,
  previewCampaignSegment: PreviewCampaignSegment,
  listSegmentRecipients: ListSegmentRecipients,
  createCampaign: CreateCampaign,
  campaignRunner: CampaignRunner,
  getCampaign: GetCampaign,
  listCampaigns: ListCampaigns,
  auth: RequestHandler,
  perms: MessagingBulkRoutePerms,
): Router {
  const router = Router();

  // ─── GET /templates (TPL-1) — RBAC-2: messaging.templates ──────────────────
  router.get(
    '/templates',
    auth,
    perms.templates,
    async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const data = await listTemplates.execute();
        res.json({ data });
      } catch (err) {
        next(err);
      }
    },
  );

  // ─── POST /segment/preview (SEG-1..SEG-5) — RBAC-1: messaging.bulk ─────────
  router.post(
    '/segment/preview',
    auth,
    perms.bulk,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const body = req.body as Record<string, unknown> | undefined;
        const input: PreviewSegmentInput = {
          statuses: Array.isArray(body?.['statuses']) ? (body!['statuses'] as string[]) : [],
          balanceMin: typeof body?.['balanceMin'] === 'number' ? (body!['balanceMin'] as number) : undefined,
          balanceMax: typeof body?.['balanceMax'] === 'number' ? (body!['balanceMax'] as number) : undefined,
          // manual-recipients (MAN-5) — el composer previsualiza la unión.
          manualClientIds: toManualClientIds(body?.['manualClientIds']),
        };
        const result = await previewCampaignSegment.execute(input);
        res.json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  // ─── GET /segment/preview (SEG-1..SEG-5, RBAC-1) ──────────────────────────────
  // FIX-16 — el spec RBAC-1 lista GET *y* POST. El preview es de solo lectura
  // (SEG-5), así que GET es el verbo semánticamente correcto; el segmento viaja
  // como query-params (`?statuses=late&statuses=blocked&balanceMin=1000`) en vez
  // de body. Misma lógica que el POST (mismo use case), solo cambia el mapeo de
  // entrada. Se mantienen AMBOS: el POST es más cómodo para el FE con un objeto
  // `segment` estructurado; el GET habilita links/bookmarks y cumple el spec.
  router.get(
    '/segment/preview',
    auth,
    perms.bulk,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const input: PreviewSegmentInput = {
          statuses: queryStatuses(req.query['statuses']),
          balanceMin: parseOptionalInt(firstQueryValue(req.query['balanceMin'])),
          balanceMax: parseOptionalInt(firstQueryValue(req.query['balanceMax'])),
        };
        const result = await previewCampaignSegment.execute(input);
        res.json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  // ─── POST /segment/recipients (v1.1, preview modal paginado) — RBAC-1 ──────
  // Molde de /segment/preview: MISMO filtrado (opt-out excluido + dedup +
  // teléfono válido), pero devuelve el set `resolved` COMPLETO paginado en vez
  // de una `sample` acotada — el modal del FE pagina server-side sobre esto.
  router.post(
    '/segment/recipients',
    auth,
    perms.bulk,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const body = req.body as Record<string, unknown> | undefined;
        const input: ListSegmentRecipientsInput = {
          statuses: Array.isArray(body?.['statuses']) ? (body!['statuses'] as string[]) : [],
          balanceMin: typeof body?.['balanceMin'] === 'number' ? (body!['balanceMin'] as number) : undefined,
          balanceMax: typeof body?.['balanceMax'] === 'number' ? (body!['balanceMax'] as number) : undefined,
          page: typeof body?.['page'] === 'number' ? (body!['page'] as number) : undefined,
          limit: typeof body?.['limit'] === 'number' ? (body!['limit'] as number) : undefined,
        };
        const result = await listSegmentRecipients.execute(input);
        res.json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  // ─── GET /segment/recipients (v1.1, deep-link opcional) — RBAC-1 ───────────
  // Mismo criterio que el GET /segment/preview (FIX-16): el segmento + la
  // página viajan como query-params para habilitar links/bookmarks al modal.
  router.get(
    '/segment/recipients',
    auth,
    perms.bulk,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const input: ListSegmentRecipientsInput = {
          statuses: queryStatuses(req.query['statuses']),
          balanceMin: parseOptionalInt(firstQueryValue(req.query['balanceMin'])),
          balanceMax: parseOptionalInt(firstQueryValue(req.query['balanceMax'])),
          page: parseOptionalInt(firstQueryValue(req.query['page'])),
          limit: parseOptionalInt(firstQueryValue(req.query['limit'])),
        };
        const result = await listSegmentRecipients.execute(input);
        res.json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  // ─── POST /campaigns (CAMP-1..CAMP-4) — RBAC-1: messaging.bulk ─────────────
  router.post(
    '/campaigns',
    auth,
    perms.bulk,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const body = req.body as Record<string, unknown> | undefined;
        const input: CreateCampaignInput = {
          name: typeof body?.['name'] === 'string' ? (body['name'] as string) : '',
          templateRef: typeof body?.['templateRef'] === 'string' ? (body['templateRef'] as string) : '',
          templateName: typeof body?.['templateName'] === 'string' ? (body['templateName'] as string) : undefined,
          // FIX-8 — NO defaultear a "todos": segmento fiel; el use case rechaza uno sin criterio.
          segment: toCampaignSegment(body?.['segment']),
          // manual-recipients (MAN-1) — lista manual PARALELA al segmento; el use
          // case dedup + valida existencia (MAN-3 fail-loud).
          manualClientIds: toManualClientIds(body?.['manualClientIds']),
          variablesMap: (body?.['variablesMap'] as CampaignVariableSpec | undefined) ?? {},
          // createdById SIEMPRE del usuario autenticado (auth, arriba) — nunca del
          // body del cliente (evita que cualquiera atribuya la campaña a otro).
          createdById: req.user?.id as string,
        };
        const result = await createCampaign.execute(input);
        res.status(201).json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  // ─── POST /campaigns/:id/send (SEND-1) — RBAC-1: messaging.bulk ────────────
  router.post(
    '/campaigns/:id/send',
    auth,
    perms.bulk,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const campaignId = req.params['id'] as string;
        const result = await campaignRunner.start(campaignId);
        if (!result.accepted) {
          // FIX-15 — el lock es GLOBAL (una campaña a la vez, CAMPAIGN_LOCK_KEY):
          // el `accepted:false` puede deberse a OTRA campaña en curso, no
          // necesariamente a ESTA. El mensaje lo refleja. `done` (escenario 2)
          // NUNCA llega acá: `campaignRunner.start` lanza
          // CampaignAlreadyFinishedError ANTES (catch → next(err) → 409 vía
          // statusMap, sin pasar por esta rama).
          res.status(409).json({
            error: 'Ya hay un envío de campañas en curso (se procesa una campaña a la vez); reintentá cuando termine',
            code: 'CAMPAIGN_SEND_IN_PROGRESS',
          });
          return;
        }
        res.status(202).json({ campaignId, accepted: true });
      } catch (err) {
        next(err);
      }
    },
  );

  // ─── GET /campaigns/:id (HIST-2/HIST-3) — RBAC-1: messaging.bulk ───────────
  router.get(
    '/campaigns/:id',
    auth,
    perms.bulk,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const { page, limit, status } = req.query as Record<string, string | undefined>;
        const includeRecipients = firstQueryValue(req.query['includeRecipients']) === 'true';
        const result = await getCampaign.execute({
          campaignId: req.params['id'] as string,
          includeRecipients,
          page: page ? Number.parseInt(page, 10) : undefined,
          limit: limit ? Number.parseInt(limit, 10) : undefined,
          status: status as CampaignRecipientStatus | undefined,
        });
        res.json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  // ─── GET /campaigns (HIST-1) — RBAC-1: messaging.bulk ───────────────────────
  router.get(
    '/campaigns',
    auth,
    perms.bulk,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const { page, limit } = req.query as Record<string, string | undefined>;
        const result = await listCampaigns.execute({
          page: page ? Number.parseInt(page, 10) : undefined,
          limit: limit ? Number.parseInt(limit, 10) : undefined,
        });
        res.json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
