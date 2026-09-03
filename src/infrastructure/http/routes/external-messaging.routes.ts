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
import type { GetMessagingCredit } from '@application/use-cases/messaging/GetMessagingCredit';
import type { ListChatwootLabels } from '@application/use-cases/messaging/ListChatwootLabels';
import type { CreateChatwootLabel } from '@application/use-cases/messaging/CreateChatwootLabel';
import type { CreateTemplateInput as CreateTemplateHttpInput, SubmitTemplateInput } from '@application/dto/messaging-templates.dto';
import type { ValidateExternalBulkInput } from '@application/dto/external-bulk-messaging.dto';
import { normalizeLabelTitle } from '@application/use-cases/messaging/normalizeLabelTitle';
import {
  CampaignRunnerBusyError,
  FeatureExternalBulkDisabledError,
  InsufficientCreditError,
} from '@domain/errors/external-bulk-messaging';
import { ChatwootUnavailableError } from '@domain/errors/messaging';
import { InvalidChatwootLabelError } from '@domain/errors/messaging-bulk';
import type { ChatwootLabelDto } from '@domain/ports/ChatwootGateway';

const FEATURE_FLAG_KEY = 'messaging-external-bulk-enabled';

/**
 * external-labels (design.md D4) — default hexadecimal cuando `POST .../labels`
 * no manda `color`. Es el azul default de Chatwoot (NO el naranja de marca de
 * IPNEXT: el label vive en el inbox de Chatwoot, no en una pieza de IPNEXT).
 */
const DEFAULT_LABEL_COLOR = '#1f93ff';

// fix wave F1 (finding 2) — `normalizeLabelTitle` se MUDÓ a
// `@application/use-cases/messaging/normalizeLabelTitle.ts` (helper
// COMPARTIDO): `ValidateExternalBulk`/`SendExternalBulk` necesitan la MISMA
// regla para resolver el `chatwootLabel` del caller contra el catálogo, o el
// round-trip create→validate queda roto (un título recién creado no matchea
// contra sí mismo). Ver el comentario del archivo nuevo para el detalle.

/**
 * fix wave F1 (finding 3a) — charset que Chatwoot acepta para un título de
 * label: letras/números unicode, `_` y `-` (el `-` que introduce
 * `normalizeLabelTitle` en cada run de whitespace YA cumple esto). Cualquier
 * otro carácter (emoji, puntuación, `#`, `/`, etc.) hoy llegaba HASTA
 * `createAccountLabel`, que lo envuelve en `ChatwootUnavailableError` (503) —
 * un error de INPUT del caller disfrazado de "Chatwoot está caído". Se
 * rechaza ACÁ, en la ruta, con un 400 accionable, ANTES de tocar el
 * proveedor.
 */
const LABEL_TITLE_CHARSET = /^[\p{L}\p{N}_-]+$/u;

/** fix wave F1 (finding 3a) — devuelve los caracteres que rompen `LABEL_TITLE_CHARSET`, sin duplicados, en orden de aparición. */
function findInvalidLabelChars(normalizedTitle: string): string[] {
  const invalid: string[] = [];
  for (const ch of normalizedTitle) {
    if (!LABEL_TITLE_CHARSET.test(ch) && !invalid.includes(ch)) invalid.push(ch);
  }
  return invalid;
}

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
  // fix wave F1 (finding 1) — `.nullable()` sumado a `.optional()`. Antes SOLO
  // `.optional()`: un `chatwootLabel: null` explícito (JSON válido, tipo
  // NINGUNO de los declarados) reventaba el Zod → 400 `VALIDATION_ERROR`, no
  // el 422 `CHATWOOT_LABEL_REQUIRED` de negocio que `assertValidShape` emite
  // para ausente/vacío/whitespace (D1: la obligatoriedad es de NEGOCIO, vive
  // en el use case, nunca en el Zod). `null` es un valor de tipo LEGÍTIMO acá
  // — el Zod solo valida forma, no la regla de negocio.
  chatwootLabel: z.string().nullable().optional(),
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

// external-labels (LBL-2, design.md Interfaces/Contracts) — `.strict()` ⇒
// `description` (o cualquier extra) → 400: el modelo de label NO lo soporta
// (`ChatwootLabelDto` es `{title,color}`), y el repo prefiere fail-loud a
// descartarlo en silencio.
// fix wave F1 (finding 4) — `.min(1).max(100)`. Sin tope, un `title` de miles
// de caracteres viajaba HASTA `createAccountLabel` (una llamada real a
// Chatwoot) antes de fallar por cualquier motivo — un caller M2M mal
// comportado gastaba una request al proveedor por un input que nunca iba a
// servir. 100 es el mismo límite que Chatwoot aplica del lado del server para
// el nombre de un label (documentado acá, no en el spec del proveedor).
const CreateLabelBodySchema = z
  .object({
    title: z.string().min(1).max(100),
    color: z.string().regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/).optional(),
  })
  .strict();

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
  /** twilio-credit-guard (D5.a) — alimenta `GET /credit` (CRED-1/CRED-2). */
  getMessagingCredit: GetMessagingCredit;
  /** external-labels (LBL-1) — reuso TAL CUAL del use case admin (`ListChatwootLabels.ts`). */
  listChatwootLabels: ListChatwootLabels;
  /** external-labels (LBL-2) — reuso TAL CUAL del use case admin (`CreateChatwootLabel.ts`). */
  createChatwootLabel: CreateChatwootLabel;
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
      // external-labels-required (D1) — `ValidateBodySchema.chatwootLabel`
      // se queda `.nullable().optional()` A PROPÓSITO: el Zod solo valida
      // TIPO (un `chatwootLabel:42` sigue 400); `null`/ausente/`''` son
      // valores de tipo LEGÍTIMOS que el Zod deja pasar sin opinar — la
      // OBLIGATORIEDAD (ausente, vacío o whitespace ⇒ 422) es una regla de
      // NEGOCIO que vive dentro de `assertValidShape` (D1: la obligatoriedad
      // nunca vive en el Zod). El cast bridgea el gap intencional entre el
      // wire (opcional/nullable) y el DTO del use case (obligatorio).
      const result = await deps.validateExternalBulk.execute(body as ValidateExternalBulkInput);
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
      // twilio-credit-guard (D5.b) — el `errorHandler` global solo serializa
      // `{error, code}` de un DomainError: el `details` del 422 se arma ACÁ,
      // mismo criterio que el bloque de arriba. `CreditUnavailableError` (503)
      // no necesita nada extra — `{error, code}` del statusMap alcanzan.
      if (err instanceof InsufficientCreditError) {
        res.status(422).json({
          error: err.message,
          code: err.code,
          details: { available: err.available, estimatedCost: err.estimatedCost, currency: err.currency },
        });
        return;
      }
      next(err);
    }
  });

  // ─── GET /credit (twilio-credit-guard D5.a, CRED-1/CRED-2) — ruta HERMANA
  // de GET /campaigns/:id, sin writeRateLimiter (es una lectura). Kill-switch
  // explícito ANTES de tocar Twilio, mismo molde que las rutas de templates. ──
  router.get('/credit', async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!(await isFeatureEnabled())) throw new FeatureExternalBulkDisabledError();
      const result = await deps.getMessagingCredit.execute();
      res.status(200).json(result);
    } catch (err) {
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

  // ─── external-labels (LBL-1..LBL-5, design.md D2/D3/D4) — catálogo de labels
  // de Chatwoot vía la API Externa. CERO use case nuevo (reusa `ListChatwootLabels`/
  // `CreateChatwootLabel` tal cual, molde TPL-0..TPL-5). Registradas ANTES del
  // catch-all. ────────────────────────────────────────────────────────────────

  /**
   * `ListChatwootLabels`/`CreateChatwootLabel` (admin, reusados TAL CUAL) NO
   * envuelven las fallas del gateway — en producción `HttpChatwootGateway.call()`
   * ya lo hace (TODO error de axios → `ChatwootUnavailableError`), pero un
   * fake/adapter que no envuelva puede dejar pasar un Error crudo. Mismo
   * criterio fail-closed que `ValidateExternalBulk.assertLabelExists` — nunca
   * un 500 opaco por una lectura del catálogo caída.
   */
  async function listLabelsOrUnavailable(): Promise<ChatwootLabelDto[]> {
    try {
      return await deps.listChatwootLabels.execute();
    } catch {
      throw new ChatwootUnavailableError();
    }
  }

  // GET /labels (LBL-1) — lectura, sin writeLimit (molde GET /templates, GET /credit).
  router.get('/labels', async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!(await isFeatureEnabled())) throw new FeatureExternalBulkDisabledError();
      const data = await listLabelsOrUnavailable();
      res.status(200).json({ data });
    } catch (err) {
      next(err);
    }
  });

  // POST /labels (LBL-2/LBL-3, design.md D2/D3/D4) — writeLimit, kill-switch,
  // normalización, default de color, pre-chequeo de duplicado IDEMPOTENTE
  // (decisión del orquestador 2026-09-03: 200 {...existingLabel, created:false}
  // en vez de un 409 — la creación NUNCA falla por "ya existe").
  router.post('/labels', writeLimit, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!(await isFeatureEnabled())) throw new FeatureExternalBulkDisabledError();
      const body = parseOr400(CreateLabelBodySchema, req.body, res);
      if (body === null) return;
      const normalizedTitle = normalizeLabelTitle(body.title);
      const color = body.color ?? DEFAULT_LABEL_COLOR;

      // fix wave F1 (finding 3a) — charset de Chatwoot, chequeado DESPUÉS de
      // normalizar (el `-` que introduce `normalizeLabelTitle` es válido) y
      // ANTES de tocar el catálogo/Chatwoot. Sin esto, un título con un
      // carácter no soportado (emoji, `#`, `/`, etc.) llegaba hasta
      // `createAccountLabel`, que envuelve CUALQUIER error de axios en
      // `ChatwootUnavailableError` (503) — un input inválido del caller
      // disfrazado de "el proveedor está caído".
      const invalidChars = findInvalidLabelChars(normalizedTitle);
      if (invalidChars.length > 0) {
        res.status(400).json({
          error: `title contains characters not supported by Chatwoot labels: ${invalidChars.join(', ')} (only letters, numbers, "_" and "-" are allowed)`,
          code: 'VALIDATION_ERROR',
        });
        return;
      }

      // D3 — pre-chequeo contra el catálogo VIVO, por título normalizado.
      const catalog = await listLabelsOrUnavailable();
      const existing = catalog.find((l) => l.title === normalizedTitle);
      if (existing) {
        res.status(200).json({ ...existing, created: false });
        return;
      }

      let created: ChatwootLabelDto;
      try {
        created = await deps.createChatwootLabel.execute({ title: normalizedTitle, color });
      } catch (err) {
        // `InvalidChatwootLabelError` (title vacío tras normalizar) es un 400
        // legítimo — NUNCA se re-envuelve.
        if (err instanceof InvalidChatwootLabelError) throw err;

        // fix wave F1 (finding 3b) — TOCTOU entre el pre-chequeo (arriba) y
        // este `create`: si OTRO request creó el MISMO título normalizado en
        // el medio, `createAccountLabel` puede fallar del lado de Chatwoot
        // (constraint de unicidad, 4xx que el port no discrimina, D3). Antes
        // de declarar 503, se re-lista el catálogo UNA vez — si el título YA
        // existe ahora, la respuesta es la MISMA idempotente que el
        // pre-chequeo (200, `created:false`): la carrera la ganó otro
        // request, pero el resultado que el caller quería (el label existe)
        // ya está. Si el catálogo sigue sin tenerlo (o el re-listado también
        // falla), la causa real es Chatwoot inalcanzable → 503.
        try {
          const recheck = await deps.listChatwootLabels.execute();
          const nowExisting = recheck.find((l) => l.title === normalizedTitle);
          if (nowExisting) {
            res.status(200).json({ ...nowExisting, created: false });
            return;
          }
        } catch {
          // el re-listado también falló — cae al 503 de abajo, sin re-envolver.
        }
        throw new ChatwootUnavailableError();
      }
      res.status(201).json({ ...created, created: true });
    } catch (err) {
      next(err);
    }
  });

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
