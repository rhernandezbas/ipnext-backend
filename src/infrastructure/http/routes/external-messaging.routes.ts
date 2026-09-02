/**
 * external-bulk-messaging (B4a/B4b, design.md D0/D7) — router de la key
 * DEDICADA (`config.externalMessaging.apiKey`, montado en app.ts ANTES del
 * `/api/external/v1` global, COMP-1): `validate`/`send` del flujo M2M de 2
 * pasos + `campaigns/:id` (polling) + admin de templates (D4.f, D7.d — CERO
 * use case nuevo, reusa `ListTemplates`/`GetTemplate`/`CreateTemplate`/
 * `SubmitTemplateForApproval` tal cual). `DeleteTemplate` NO se inyecta acá
 * (D4.f): no alcanza con no registrar la ruta, la dependencia tampoco entra.
 *
 * Auth (AUTH-1..3) la aplica el MOUNT (`createApiKeyMiddleware`), no este
 * router. El kill-switch (KS-1) para `validate`/`send` vive DENTRO de esos use
 * cases; las 4 rutas de templates NO tienen flag-gate propio (D4.f, CERO
 * lógica nueva) — por eso el router lo chequea ACÁ, ANTES de tocar el
 * proveedor (D7.d, TPL-0).
 *
 * `parseOr400` (zod `safeParse`, NUNCA `.parse()`) — molde `assistant.routes.ts`:
 * un `ZodError` sin capturar no está mapeado en `errorHandler` → 500 en vez de
 * 400 (la "lección obligatoria" de D11).
 */
import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { z } from 'zod';
import type { ValidateExternalBulk } from '@application/use-cases/messaging/ValidateExternalBulk';
import type { SendExternalBulk } from '@application/use-cases/messaging/SendExternalBulk';
import type { GetExternalBulkCampaign } from '@application/use-cases/messaging/GetExternalBulkCampaign';
import type { ListTemplates } from '@application/use-cases/messaging/ListTemplates';
import type { GetTemplate } from '@application/use-cases/messaging/GetTemplate';
import type { CreateTemplate } from '@application/use-cases/messaging/CreateTemplate';
import type { SubmitTemplateForApproval } from '@application/use-cases/messaging/SubmitTemplateForApproval';
import type { FeatureFlagRepository } from '@domain/ports/FeatureFlagRepository';
import type { CreateTemplateInput as CreateTemplateHttpInput, SubmitTemplateInput } from '@application/dto/messaging-templates.dto';
import { CampaignRunnerBusyError, FeatureExternalBulkDisabledError } from '@domain/errors/external-bulk-messaging';

const FEATURE_FLAG_KEY = 'messaging-external-bulk-enabled';

/** Molde `assistant.routes.ts` — `safeParse`, NUNCA `.parse()` (D11). Devuelve `null` cuando ya respondió. */
function parseOr400<T>(schema: z.ZodType<T>, payload: unknown, res: Response): T | null {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
    return null;
  }
  return parsed.data;
}

const VariablesRecordSchema = z.record(z.string(), z.string());

const ValidateRecipientSchema = z.object({
  phone: z.string(),
  name: z.string().optional(),
  variables: VariablesRecordSchema.optional(),
});

// VAL-1 — la regla "templateRef O templateName" y "recipients no vacío" son
// de NEGOCIO (las exige el use case, `assertValidShape`); acá solo se
// validan TIPOS, para que un body con tipos equivocados nunca reviente un
// `.trim()`/`.map()` con un TypeError sin mapear (500).
const ValidateBodySchema = z.object({
  templateRef: z.string().optional(),
  templateName: z.string().optional(),
  variables: VariablesRecordSchema.optional(),
  chatwootLabel: z.string().optional(),
  recipients: z.array(ValidateRecipientSchema),
});

// SEND-1 — `previewId` va en el body; `Idempotency-Key` va por HEADER (nunca
// en el body, molde `SendTemplateMessage`) y se lee aparte, más abajo.
const SendBodySchema = z.object({
  previewId: z.string(),
});

const CreateTemplateBodySchema = z.object({
  friendlyName: z.string(),
  language: z.string(),
  body: z.string(),
  category: z.string().optional(),
  variables: z.array(z.string()).optional(),
});

// fix wave F3 (S3, smoke en vivo) — `name` pasa a OPCIONAL: si no vino, el
// handler lo resuelve del propio template (`friendlyName`, vía `GetTemplate`,
// ya inyectado). `category` sigue siendo obligatorio (la validación de ENUM
// vive en `SubmitTemplateForApproval`, D7.d).
const SubmitTemplateBodySchema = z.object({
  name: z.string().optional(),
  category: z.string(),
});

export interface ExternalMessagingRouterDeps {
  validateExternalBulk: ValidateExternalBulk;
  sendExternalBulk: SendExternalBulk;
  getExternalBulkCampaign: GetExternalBulkCampaign;
  listTemplates: ListTemplates;
  getTemplate: GetTemplate;
  createTemplate: CreateTemplate;
  submitTemplate: SubmitTemplateForApproval;
  /** TPL-0 — kill-switch gate para las 4 rutas de templates (D4.f, sin use case propio). */
  featureFlags: FeatureFlagRepository;
  /**
   * fix wave F1 (finding F7) — rate limiter de ESCRITURA, aplicado SOLO a los
   * POST. Antes vivia en el mount (`app.use(prefix, limiter, router)`), asi que
   * cubria TODO el prefijo, incluido `GET /campaigns/:id`: el contrato SEND-8
   * le pide al caller M2M que poleé ese endpoint tras un 409, y con 30 req/60s
   * por IP el propio poll consumia el presupuesto y se auto-429aba. Los GET
   * (status + templates) quedan sin limite acá — su costo es una lectura, no un
   * envio. `undefined` (tests de router aislado) = sin limite.
   */
  writeRateLimiter?: RequestHandler;
}

export function createExternalMessagingRouter(deps: ExternalMessagingRouterDeps): Router {
  const router = Router();

  // fix wave F1 (F7) — no-op cuando no se inyecta (tests de router aislado).
  const writeLimit: RequestHandler = deps.writeRateLimiter ?? ((_req, _res, next) => next());

  /** TPL-0/D4.f — fail-safe a OFF, MISMO criterio que KS-1 dentro de los use cases. */
  async function isFeatureEnabled(): Promise<boolean> {
    try {
      return (await deps.featureFlags.get(FEATURE_FLAG_KEY))?.enabled === true;
    } catch {
      return false;
    }
  }

  // ─── POST /validate (VAL-1..VAL-10, KS-1 vive DENTRO del use case) ─────────
  router.post('/validate', writeLimit, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const body = parseOr400(ValidateBodySchema, req.body, res);
    if (body === null) return;
    try {
      const result = await deps.validateExternalBulk.execute(body);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  });

  // ─── POST /send (SEND-1..SEND-10, KS-1 vive DENTRO del use case) ───────────
  router.post('/send', writeLimit, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const body = parseOr400(SendBodySchema, req.body, res);
    if (body === null) return;
    // `Idempotency-Key` por HEADER — NUNCA `req.body.idempotencyKey`.
    const idempotencyKey = req.get('Idempotency-Key') ?? undefined;
    try {
      const result = await deps.sendExternalBulk.execute(body, idempotencyKey);
      // fix wave F1 (F3) — SEND-6 exige 200 en el REPLAY (la campaña ya
      // existía) y 202 solo cuando este request la ACEPTÓ recién. `resumed` es
      // el discriminador: el use case lo setea (true|false) únicamente en el
      // camino de GUARD-0 y lo deja ausente en un `send` fresco.
      res.status(result.resumed === undefined ? 202 : 200).json(result);
    } catch (err) {
      // SEND-8/D8 — 409 con header `Retry-After` + body `{campaignId,
      // retryAfterSeconds}`: el `errorHandler` global mapea el CÓDIGO (409),
      // pero no conoce estos 2 campos extra — se agregan acá.
      if (err instanceof CampaignRunnerBusyError) {
        res.set('Retry-After', String(err.retryAfterSeconds));
        res.status(409).json({
          error: err.message,
          code: err.code,
          campaignId: err.campaignId,
          retryAfterSeconds: err.retryAfterSeconds,
        });
        return;
      }
      next(err);
    }
  });

  // ─── GET /campaigns/:id (STATUS-1) ──────────────────────────────────────────
  router.get('/campaigns/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await deps.getExternalBulkCampaign.execute({ campaignId: req.params['id'] as string });
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  });

  // ─── Templates externos (TPL-0..TPL-5, D4.f, D7.d) — CERO use case nuevo ───

  // GET /templates (TPL-1)
  router.get('/templates', async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!(await isFeatureEnabled())) throw new FeatureExternalBulkDisabledError();
      const data = await deps.listTemplates.execute();
      res.status(200).json({ data });
    } catch (err) {
      next(err);
    }
  });

  // GET /templates/:sid (TPL-2)
  router.get('/templates/:sid', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!(await isFeatureEnabled())) throw new FeatureExternalBulkDisabledError();
      const result = await deps.getTemplate.execute(req.params['sid'] as string);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  });

  // POST /templates (TPL-3) — 201, NUNCA submite a Meta (D4.f/proposal).
  router.post('/templates', writeLimit, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!(await isFeatureEnabled())) throw new FeatureExternalBulkDisabledError();
      const body = parseOr400(CreateTemplateBodySchema, req.body, res);
      if (body === null) return;
      const created = await deps.createTemplate.execute(body as CreateTemplateHttpInput);
      res.status(201).json(created);
    } catch (err) {
      next(err);
    }
  });

  // POST /templates/:sid/submit (TPL-4) — 202, paso EXPLÍCITO y separado.
  router.post('/templates/:sid/submit', writeLimit, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!(await isFeatureEnabled())) throw new FeatureExternalBulkDisabledError();
      const body = parseOr400(SubmitTemplateBodySchema, req.body, res);
      if (body === null) return;
      const sid = req.params['sid'] as string;
      // fix wave F3 (S3) — `name` ausente → se resuelve del PROPIO template
      // (`friendlyName`). `GetTemplate` ya está inyectado (D4.f, cero use
      // case nuevo) y su `TemplateNotFoundError` (404) cubre el sid
      // inexistente ANTES de tocar `submitTemplate` — un `name` explícito
      // SIEMPRE gana, no se pisa.
      const name = body.name ?? (await deps.getTemplate.execute(sid)).friendlyName;
      await deps.submitTemplate.execute(sid, { name, category: body.category } as SubmitTemplateInput);
      res.status(202).json({ contentSid: sid, submitted: true });
    } catch (err) {
      next(err);
    }
  });

  // DELETE /templates/:sid (TPL-5) — a propósito NO REGISTRADA.
  // `deleteTemplate` ni siquiera está en `ExternalMessagingRouterDeps` (D4.f)
  // — no hay forma de invocarlo desde acá. Cae al catch-all de abajo (404).

  // ─── fix wave F3 (S2, smoke en vivo) — catch-all: SELLA el router ─────────
  // LIVE: `DELETE /templates/:sid` y `GET /campaigns/` (id vacío) — ninguna
  // ruta registrada acá — devolvían 401 UNAUTHORIZED en vez de 404. La causa
  // NO era este router: sin un catch-all propio, `next()` implícito de
  // Express seguía buscando un match y caía en el mount GLOBAL de `app.ts`
  // (`/api/external/v1`, key GLOBAL sin la key dedicada) — el 401 venía de
  // ESE middleware de auth, no de "ruta inexistente". Un caller M2M viendo
  // 401 en una ruta mal tipeada cree que su key está mal, no que el path no
  // existe. Este catch-all DEBE ser el ÚLTIMO handler del router (Express
  // matchea/ejecuta en orden de registro) para sellar el prefijo entero antes
  // de que Express siga buscando afuera. Mismo shape que el 404 global de
  // `app.ts` (`res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' })`).
  router.use((_req: Request, res: Response): void => {
    res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
  });

  return router;
}
