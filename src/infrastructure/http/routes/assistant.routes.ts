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
import type { GetAssistantProviderConfig } from '@application/use-cases/assistant/GetAssistantProviderConfig';
import type { UpdateAssistantProviderConfig } from '@application/use-cases/assistant/UpdateAssistantProviderConfig';
import type { TestAssistantConnection } from '@application/use-cases/assistant/TestAssistantConnection';
import type { GetAssistantRoutingConfig } from '@application/use-cases/assistant/GetAssistantRoutingConfig';
import type { UpdateAssistantRoutingConfig } from '@application/use-cases/assistant/UpdateAssistantRoutingConfig';
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
  getProviderConfig: GetAssistantProviderConfig;
  updateProviderConfig: UpdateAssistantProviderConfig;
  testConnection: TestAssistantConnection;
  getRoutingConfig: GetAssistantRoutingConfig;
  updateRoutingConfig: UpdateAssistantRoutingConfig;
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

/**
 * Credenciales del proveedor. `apiKey` es OPCIONAL y un valor vacío PRESERVA la guardada —
 * sin esa regla, editar la baseUrl desde el formulario guardaría la máscara como key.
 * Borrarla de verdad requiere `clearApiKey: true`, un acto explícito.
 */
/**
 * RTR-0 — el ruteo se reemplaza ENTERO, no se parchea: son dos campos y la semántica de
 * "ausente" sería ambigua (¿no lo tocaste, o lo querés en null?). `rerouteEnabled` es
 * obligatorio a propósito: inferir un default silencioso acá cambia el comportamiento del bot.
 *
 * `defaultAreaId` acepta null EXPLÍCITO — es la forma de apagar el ruteo, y tiene que ser
 * decible. Lo que NO acepta es string vacío: sería un id que no matchea con nada.
 */
const UpdateRoutingSchema = z.object({
  defaultAreaId: z.string().min(1).nullable(),
  rerouteEnabled: z.boolean(),
});

const UpdateProviderSchema = z.object({
  baseUrl: z.string().url().or(z.literal('')).optional(),
  apiKey: z.string().max(500).optional(),
  clearApiKey: z.boolean().optional(),
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

  // ── Proveedor de IA — credenciales (ENMASCARADAS al leer) ────────────────
  router.get(
    '/provider',
    deps.auth,
    readPerm,
    asyncHandler(async (_req, res) => {
      res.json({ data: await deps.getProviderConfig.execute() });
    }),
  );

  router.put(
    '/provider',
    deps.auth,
    managePerm,
    asyncHandler(async (req, res) => {
      const body = parseOr400(UpdateProviderSchema, req.body, res);
      if (!body) return;
      res.json({ data: await deps.updateProviderConfig.execute(body) });
    }),
  );

  /**
   * "Probar conexión" — la llamada al proveedor sale DEL SERVIDOR. El front sólo aprieta el
   * botón y recibe ok/error; la credencial nunca baja al navegador.
   *
   * Responde 200 incluso cuando la prueba falla: el fallo es el RESULTADO de la operación, no
   * un error del request. Un 5xx acá haría que el FE lo trate como "se rompió la app" en vez
   * de mostrar "la key no anda".
   */
  router.post(
    '/provider/test',
    deps.auth,
    managePerm,
    asyncHandler(async (_req, res) => {
      res.json({ data: await deps.testConnection.execute() });
    }),
  );

  // ── Ruteo (RTR-0) — quién atiende lo que entra SIN área ──────────────────
  /**
   * Sin `defaultAreaId` el motor hace no-op en todas las conversaciones: `Conversation.areaId`
   * entra siempre en NULL porque los agentes trabajan dentro de Chatwoot. Esta es, literalmente,
   * la perilla que decide si el asistente existe o no.
   */
  router.get(
    '/routing',
    deps.auth,
    readPerm,
    asyncHandler(async (_req, res) => {
      res.json({ data: await deps.getRoutingConfig.execute() });
    }),
  );

  router.put(
    '/routing',
    deps.auth,
    managePerm,
    asyncHandler(async (req, res) => {
      const body = parseOr400(UpdateRoutingSchema, req.body, res);
      if (!body) return;
      res.json({ data: await deps.updateRoutingConfig.execute(body) });
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
