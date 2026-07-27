import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import type { CreateAssistantProfile } from '@application/use-cases/assistant/CreateAssistantProfile';
import type { UpdateAssistantProfile } from '@application/use-cases/assistant/UpdateAssistantProfile';
import type { GetAssistantConfig } from '@application/use-cases/assistant/GetAssistantConfig';
import type { CreateAssistantIntent } from '@application/use-cases/assistant/CreateAssistantIntent';
import type { UpdateAssistantIntent } from '@application/use-cases/assistant/UpdateAssistantIntent';
import type { DeleteAssistantIntent } from '@application/use-cases/assistant/DeleteAssistantIntent';
import type { ListAssistantCatalogs } from '@application/use-cases/assistant/ListAssistantCatalogs';
import type { ListAssistantRuns } from '@application/use-cases/assistant/ListAssistantRuns';
import type { PermissionAction, RbacModuleCode } from '@domain/entities/rbac';

/** Factory que expone `app.ts` (inyección DIP-limpia, molde `alerts.routes`). */
type RequirePerm = (module: RbacModuleCode, action: PermissionAction) => RequestHandler;

export interface AssistantRouterDeps {
  createProfile: CreateAssistantProfile;
  updateProfile: UpdateAssistantProfile;
  getConfig: GetAssistantConfig;
  createIntent: CreateAssistantIntent;
  updateIntent: UpdateAssistantIntent;
  deleteIntent: DeleteAssistantIntent;
  listCatalogs: ListAssistantCatalogs;
  listRuns: ListAssistantRuns;
  auth: RequestHandler;
  requirePerm: RequirePerm;
}

/**
 * ai-assistant-multiagent — API de CONFIGURACIÓN del asistente.
 *
 * ⚠️ Este router NO expone ningún camino para CREAR fuentes de datos ni acciones (frontera R5
 * del proposal): los catálogos son read-only + toggle. Cada fuente es una puerta a la base;
 * definirlas por formulario sería una inyección con formulario bonito. Componer comportamiento
 * (intenciones) sí es libre y sin deploy — fabricar piezas nuevas requiere código y review.
 *
 * Permisos en las DOS capas (regla innegociable del workflow): acá el guard granular
 * `assistant:read` / `assistant:manage`; en el FE, `RequirePermission assistant.read` +
 * `Can assistant.manage`. Los namespaces son distintos (colon vs punto) — no asumir equivalencia.
 */

const CreateProfileSchema = z.object({
  areaId: z.string().min(1),
  persona: z.string().max(5000).optional(),
  handoffMessage: z.string().max(2000).optional(),
  model: z.string().min(1).max(120).optional(),
  classifierModel: z.string().min(1).max(120).nullable().optional(),
  timeoutMs: z.number().int().min(1000).max(120000).optional(),
});

const UpdateProfileSchema = z.object({
  enabled: z.boolean().optional(),
  persona: z.string().max(5000).optional(),
  handoffMessage: z.string().max(2000).optional(),
  model: z.string().min(1).max(120).optional(),
  classifierModel: z.string().min(1).max(120).nullable().optional(),
  timeoutMs: z.number().int().min(1000).max(120000).optional(),
  enabledActions: z.array(z.string().min(1)).max(32).optional(),
});

const CreateIntentSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().min(1).max(2000),
  examples: z.array(z.string().min(1).max(500)).max(50).optional(),
  enabled: z.boolean().optional(),
  dataSourceKeys: z.array(z.string().min(1)).max(32).optional(),
  responseGuide: z.string().max(5000).optional(),
  actionKey: z.string().min(1),
});

const UpdateIntentSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().min(1).max(2000).optional(),
  examples: z.array(z.string().min(1).max(500)).max(50).optional(),
  enabled: z.boolean().optional(),
  dataSourceKeys: z.array(z.string().min(1)).max(32).optional(),
  responseGuide: z.string().max(5000).optional(),
  actionKey: z.string().min(1).optional(),
});

/**
 * OBS-1 — filtros del historial de corridas. `outcome` es un enum CERRADO: el tablero necesita
 * poder aislar `rejected_numbers` (alucinaciones de plata atajadas) y `handoff` (veces que el
 * bot se calló pudiendo hablar), que son las dos métricas que dicen si el asistente se está
 * degradando.
 */
const ListRunsQuerySchema = z.object({
  areaId: z.string().min(1).optional(),
  outcome: z
    .enum(['replied', 'handoff', 'noop', 'rejected_numbers', 'error'])
    .optional(),
  subjectId: z.string().min(1).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

/** Envuelve un handler async para que un rejection llegue al errorHandler y no cuelgue. */
function asyncHandler(
  fn: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

/**
 * Valida con `safeParse` y responde 400 — convención del repo (`alerts.routes.ts:530`).
 *
 * NO se usa `.parse()`: lanza un `ZodError` que el `errorHandler` NO mapea, así que un body
 * inválido terminaría en **500**. Lo cazó `assistant.routes.test.ts` — un test de ruta con el
 * use case real, exactamente el hueco que los tests por capa no ven.
 *
 * Devuelve `null` cuando ya respondió; el caller corta.
 */
function parseOr400<T>(
  schema: z.ZodType<T>,
  payload: unknown,
  res: Response,
): T | null {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
    return null;
  }
  return parsed.data;
}

export function createAssistantRouter(deps: AssistantRouterDeps): Router {
  const router = Router();
  const readPerm = deps.requirePerm('assistant', 'read');
  const managePerm = deps.requirePerm('assistant', 'manage');

  // ── Catálogos (CFG-3) — read-only. Llenan los checkboxes del editor. ──────
  router.get(
    '/catalogs',
    deps.auth,
    readPerm,
    asyncHandler(async (_req, res) => {
      res.json({ data: await deps.listCatalogs.execute() });
    }),
  );

  // ── Auditoría (OBS-1) — "¿por qué el bot dijo, o calló, eso?" ────────────
  router.get(
    '/runs',
    deps.auth,
    readPerm,
    asyncHandler(async (req, res) => {
      const query = parseOr400(ListRunsQuerySchema, req.query, res);
      if (!query) return;
      res.json({ data: await deps.listRuns.execute(query) });
    }),
  );

  // ── Perfiles ─────────────────────────────────────────────────────────────
  router.get(
    '/profiles',
    deps.auth,
    readPerm,
    asyncHandler(async (_req, res) => {
      res.json({ data: await deps.getConfig.list() });
    }),
  );

  /**
   * Búsqueda por área: 200 con `data:null` cuando el área no tiene perfil. NO es 404 —
   * "esta área no tiene agente" es el estado NORMAL de la mayoría de las áreas, y un 404
   * obligaría al FE a tratar lo esperable como error.
   */
  router.get(
    '/profiles/by-area/:areaId',
    deps.auth,
    readPerm,
    asyncHandler(async (req, res) => {
      res.json({ data: await deps.getConfig.getByAreaId(req.params.areaId) });
    }),
  );

  router.get(
    '/profiles/:id',
    deps.auth,
    readPerm,
    asyncHandler(async (req, res) => {
      res.json({ data: await deps.getConfig.getById(req.params.id) });
    }),
  );

  router.post(
    '/profiles',
    deps.auth,
    managePerm,
    asyncHandler(async (req, res) => {
      const body = parseOr400(CreateProfileSchema, req.body, res);
      if (!body) return;
      res.status(201).json({ data: await deps.createProfile.execute(body) });
    }),
  );

  router.patch(
    '/profiles/:id',
    deps.auth,
    managePerm,
    asyncHandler(async (req, res) => {
      const body = parseOr400(UpdateProfileSchema, req.body, res);
      if (!body) return;
      res.json({ data: await deps.updateProfile.execute(req.params.id, body) });
    }),
  );

  // ── Intenciones (CFG-2) — el corazón de "configurable sin deploy" ────────
  router.post(
    '/profiles/:profileId/intents',
    deps.auth,
    managePerm,
    asyncHandler(async (req, res) => {
      const body = parseOr400(CreateIntentSchema, req.body, res);
      if (!body) return;
      const intent = await deps.createIntent.execute({ ...body, profileId: req.params.profileId });
      res.status(201).json({ data: intent });
    }),
  );

  router.patch(
    '/intents/:id',
    deps.auth,
    managePerm,
    asyncHandler(async (req, res) => {
      const body = parseOr400(UpdateIntentSchema, req.body, res);
      if (!body) return;
      res.json({ data: await deps.updateIntent.execute(req.params.id, body) });
    }),
  );

  router.delete(
    '/intents/:id',
    deps.auth,
    managePerm,
    asyncHandler(async (req, res) => {
      await deps.deleteIntent.execute(req.params.id);
      res.status(204).send();
    }),
  );

  return router;
}
