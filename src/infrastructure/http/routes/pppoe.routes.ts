/**
 * pppoe.routes.ts — rutas HTTP para gestión de PPPoE.
 *
 * Endpoints:
 *   GET    /api/contracts/:contractId/pppoe      pppoe.read
 *   POST   /api/contracts/:contractId/pppoe      pppoe.manage
 *   PATCH  /api/pppoe/:id                         pppoe.manage
 *   POST   /api/pppoe/:id/move                    pppoe.manage  (radius-aware: IP nueva del pool cgnat del destino + kick)
 *   GET    /api/pppoe/nas-move-events             network.read  (registro visible — tab de la page de auditoria de red)
 *   DELETE /api/pppoe/:id                         pppoe.manage  (baja soft)
 *   --- Adopción del inventario ---
 *   GET    /api/pppoe/unassigned                  pppoe.read    (huérfanos, sin password)
 *   POST   /api/nas/:id/ingest-pppoe              pppoe.manage  (adopta el inventario del NAS)
 *   POST   /api/pppoe/:id/associate              pppoe.manage  (asocia a un contrato)
 *   DELETE /api/contracts/:contractId/pppoe/:pppoeId  pppoe.manage  (desasocia: contractId=null, sin baja)
 *   GET    /api/pppoe/:id/credentials            pppoe.manage  (revela {username, password})
 *   --- pppoe-bulk-select-filter (v2) ---
 *   GET    /api/pppoe/ids                         pppoe.manage  (ids del filtro activo — selección masiva; 400 FILTER_REQUIRED sin filtro)
 *   --- Fase C (cortes) ---
 *   POST   /api/pppoe/enforce/preview            pppoe.cut   (impacto, sin ejecutar)
 *   POST   /api/pppoe/enforce/bulk               pppoe.cut   (202 + jobId; 409 si hay uno en curso)
 *   GET    /api/pppoe/enforce/bulk/:id           pppoe.cut   (progreso del batch)
 *   POST   /api/pppoe/:id/enforce                pppoe.cut   (corte individual)
 *
 * Mapeo de errores:
 *   ROUTER_UNREACHABLE    → 502
 *   PPPOE_USERNAME_TAKEN  → 409
 *   PPPOE_NOT_FOUND       → 404
 *   NAS_NOT_FOUND         → 404
 *   ENFORCEMENT_IN_PROGRESS → 409
 *   BATCH_NOT_FOUND       → 404
 *   --- move (fix wave 1: via errorHandler, fuente ÚNICA — el handler solo hace next(err)) ---
 *   NO_FREE_IP            → 422
 *   NO_POOL_FOR_NAS_TYPE  → 404
 *   PPPOE_MOVE_MIXED_NAS_TYPES / PPPOE_TERMINATED / PPPOE_MOVE_PUBLIC_IP → 409
 *   ORCHESTRATOR_REJECTED → re-envía el upstreamStatus (p.ej. 409 colisión Framed-IP)
 *   desconocido           → 500 (nunca request colgada)
 *   zod invalid           → 422
 */
import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { AuthProvider } from '@domain/ports/AuthProvider';
import type { SessionRepository } from '@domain/ports/SessionRepository';
import type { RbacModuleCode, PermissionAction } from '@domain/entities/rbac';
import { createAuthMiddleware } from '../middleware/authMiddleware';
import { ListPppoeByContract } from '@application/use-cases/ListPppoeByContract';
import { CreatePppoeService } from '@application/use-cases/CreatePppoeService';
import { UpdatePppoeService } from '@application/use-cases/UpdatePppoeService';
import { MovePppoeServiceToRouter } from '@application/use-cases/MovePppoeServiceToRouter';
import { MovePppoeToNas } from '@application/use-cases/MovePppoeToNas';
import { ListPppoeNasMoveEvents } from '@application/use-cases/ListPppoeNasMoveEvents';
import { DeactivatePppoeService } from '@application/use-cases/DeactivatePppoeService';
import { TerminatePppoeService } from '@application/use-cases/TerminatePppoeService';
import { GetPppoeCallerId } from '@application/use-cases/GetPppoeCallerId';
import { PinPppoeIp } from '@application/use-cases/PinPppoeIp';
import { UnpinPppoeIp } from '@application/use-cases/UnpinPppoeIp';
import { EnforcePppoeService } from '@application/use-cases/EnforcePppoeService';
import { PreviewEnforcement } from '@application/use-cases/PreviewEnforcement';
import { IngestPppoeFromNas } from '@application/use-cases/IngestPppoeFromNas';
import { AssociatePppoeToContract } from '@application/use-cases/AssociatePppoeToContract';
import { GetPppoeCredentials } from '@application/use-cases/GetPppoeCredentials';
import { ListUnassignedPppoe } from '@application/use-cases/ListUnassignedPppoe';
import { DeassociatePppoeFromContract } from '@application/use-cases/DeassociatePppoeFromContract';
import { ListAllPppoeServices } from '@application/use-cases/ListAllPppoeServices';
// pppoe-bulk-select-filter (v2): hermano liviano de ListAllPppoeServices — solo { ids, total }.
import { ListAllPppoeServiceIds } from '@application/use-cases/ListAllPppoeServiceIds';
import { ListInternetServiceHistory } from '@application/use-cases/ListInternetServiceHistory';
import { ListInternetActivationOperators } from '@application/use-cases/ListInternetActivationOperators';
import { CreatePppoeStandalone } from '@application/use-cases/CreatePppoeStandalone';
import { RenamePppoeUsername } from '@application/use-cases/RenamePppoeUsername';
// pppoe-search-bulk-plan: bulk plan change
import { BulkChangePppoePlan } from '@application/use-cases/BulkChangePppoePlan';
import { BulkEmptyIdsError, BulkTooLargeError, PlanNotFoundForBulkError } from '@domain/errors/pppoe-bulk';
import type { ServiceCutRunner } from '@infrastructure/scheduling/ServiceCutRunner';
import type { ServiceCutBatchRepository } from '@domain/ports/ServiceCutBatchRepository';
import {
  CreatePppoeBodySchema,
  UpdatePppoeBodySchema,
  MovePppoeBodySchema,
  AssociatePppoeBodySchema,
  EnforcePppoeBodySchema,
  EnforceBulkBodySchema,
  CreatePppoeStandaloneBodySchema,
  RenamePppoeBodySchema,
  BulkChangePlanBodySchema,
  toPppoeServiceDto,
  toServiceCutBatchDto,
} from '@application/dto/pppoe.dto';
import { z } from 'zod';

/** Extrae actor del request autenticado (seteado por authMiddleware). */
function actorOf(req: Request): { actorId: string | null; actorName: string } {
  return {
    actorId:   req.user?.id ?? null,
    actorName: req.user?.username ?? '',
  };
}

import {
  RouterUnreachableError,
  OrchestratorUnreachableError,
  OrchestratorRejectedError,
  PppoeUsernameTakenError,
  PppoeProfileRequiredError,
  PppoeServiceNotFoundError,
  PppoeAlreadyAssociatedError,
  PppoeContractAlreadyHasServiceError,
  PppoeIngestNotSupportedError,
  PppoeRenameNasNotSupportedError,
  PppoePendingInstallError,
  NasNotFoundError,
  InvalidIpFormatError,
  IpAlreadyTakenError,
  NasNoPoolError,
} from '@domain/errors/pppoe';

const BajaBodySchema = z.object({ reason: z.string().nullish() }).optional();
/** pppoe-pool-ip: body de POST /pppoe/:id/pin-ip — la IP fija a pinear. */
const PinIpBodySchema = z.object({ ip: z.string().min(1) });

type RequirePerm = (module: RbacModuleCode, action: PermissionAction) => RequestHandler;

export function createPppoeRouter(
  authProvider: AuthProvider,
  sessionRepo: SessionRepository | undefined,
  requirePerm: RequirePerm,
  listPppoeByContract: ListPppoeByContract,
  createPppoeService: CreatePppoeService,
  updatePppoeService: UpdatePppoeService,
  movePppoeServiceToRouter: MovePppoeServiceToRouter,
  deactivatePppoeService: DeactivatePppoeService,
  enforcePppoeService: EnforcePppoeService,
  previewEnforcement: PreviewEnforcement,
  serviceCutRunner: ServiceCutRunner,
  serviceCutBatchRepo: ServiceCutBatchRepository,
  ingestPppoeFromNas: IngestPppoeFromNas,
  associatePppoeToContract: AssociatePppoeToContract,
  getPppoeCredentials: GetPppoeCredentials,
  listUnassignedPppoe: ListUnassignedPppoe,
  deassociatePppoeFromContract: DeassociatePppoeFromContract,
  terminatePppoeService?: TerminatePppoeService,
  getPppoeCallerId?: GetPppoeCallerId,
  listAllPppoeServices?: ListAllPppoeServices,
  listInternetServiceHistory?: ListInternetServiceHistory,
  listInternetActivationOperators?: ListInternetActivationOperators,
  pinPppoeIp?: PinPppoeIp,
  unpinPppoeIp?: UnpinPppoeIp,
  /** pppoe-full-management: Crea PPPoE standalone (contrato opcional). POST /api/pppoe. */
  createPppoeStandalone?: CreatePppoeStandalone,
  /** pppoe-full-management: Renombra PPPoE (create-then-delete seguro). POST /api/pppoe/:id/rename. */
  renamePppoeUsername?: RenamePppoeUsername,
  /**
   * pppoe-move-nas W1: move radius-aware (reasigna IP CGNAT del destino + kick). Cuando está
   * wired, POST /pppoe/:id/move usa ESTE use case; sin él cae al legacy (back-compat, patrón
   * terminatePppoeService ?? deactivatePppoeService). En prod SIEMPRE viene wired (composition test).
   */
  movePppoeToNas?: MovePppoeToNas,
  /** pppoe-move-nas W1: registro visible de movimientos. GET /api/pppoe/nas-move-events (network.read). */
  listPppoeNasMoveEvents?: ListPppoeNasMoveEvents,
  /** pppoe-search-bulk-plan: Cambia el plan de N PPPoE en bulk. POST /pppoe/bulk/change-plan. */
  bulkChangePppoePlan?: BulkChangePppoePlan,
  /**
   * pppoe-bulk-select-filter (v2): ids del filtro activo, para la selección masiva del bulk.
   * GET /pppoe/ids (gate pppoe.manage). Sin este wired, la ruta no se monta (back-compat de
   * fixtures viejas; en prod SIEMPRE viene wired — composition test, lección W6).
   */
  listAllPppoeServiceIds?: ListAllPppoeServiceIds,
): Router {
  const router = Router();
  // STATEFUL en prod (sessionRepo presente): una sesión revocada NO puede cortar servicio.
  // El corte es el endpoint más destructivo del módulo — el guard de revocación es innegociable.
  const auth     = createAuthMiddleware(authProvider, sessionRepo);
  const canRead   = requirePerm('pppoe', 'read');
  const canManage = requirePerm('pppoe', 'manage');
  const canCut    = requirePerm('pppoe', 'cut');
  // review FE W1: el listado de movimientos vive como tab de la page de auditoria de red,
  // cuyos tabs vecinos (radius/events, ne8000/audit, auth-failures) gatean network.read.
  // Gatearlo pppoe.read dejaba el tab "visible pero muerto" (403) para un NOC con network.read.
  const canNetworkRead = requirePerm('network', 'read');

  // ── GET /contracts/:contractId/pppoe ────────────────────────────────────────
  router.get(
    '/contracts/:contractId/pppoe',
    auth,
    canRead,
    async (req: Request, res: Response): Promise<void> => {
      const services = await listPppoeByContract.execute(req.params['contractId'] as string);
      res.json(services.map(toPppoeServiceDto));
    },
  );

  // ── POST /contracts/:contractId/pppoe ───────────────────────────────────────
  router.post(
    '/contracts/:contractId/pppoe',
    auth,
    canManage,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      const parsed = CreatePppoeBodySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(422).json({ code: 'VALIDATION_ERROR', details: parsed.error.issues });
        return;
      }
      try {
        const service = await createPppoeService.execute({
          contractId: req.params['contractId'] as string,
          ...parsed.data,
          // pppoe-preprovision (S1.1): nasId ausente/null = pre-provision "pendiente de instalacion".
          nasId: parsed.data.nasId ?? null,
        }, actorOf(req));
        res.status(201).json(toPppoeServiceDto(service));
      } catch (err) {
        // NAS RADIUS caído (red/timeout/5xx) → mismo trato que el router caído.
        if (err instanceof RouterUnreachableError || err instanceof OrchestratorUnreachableError) {
          res.status(502).json({ code: err.code, error: err.message });
          return;
        }
        // El orchestrator RECHAZÓ el alta (4xx) — p.ej. usuario duplicado (409). Reenviamos su status.
        if (err instanceof OrchestratorRejectedError) {
          res.status(err.upstreamStatus).json({ code: err.code, error: err.message });
          return;
        }
        if (err instanceof PppoeUsernameTakenError) {
          res.status(409).json({ code: err.code, error: err.message });
          return;
        }
        // El contrato ya tiene un PPPoE activo → 409.
        if (err instanceof PppoeContractAlreadyHasServiceError) {
          res.status(409).json({ code: err.code, error: err.message });
          return;
        }
        // Alta en NAS RADIUS sin profile → el plan/grupo es obligatorio.
        if (err instanceof PppoeProfileRequiredError) {
          res.status(422).json({ code: err.code, error: err.message });
          return;
        }
        if (err instanceof NasNotFoundError) {
          res.status(404).json({ code: err.code, error: err.message });
          return;
        }
        // pppoe-preprovision (S1.4): el allocator server-side puede fallar (NO_POOL_FOR_NAS_TYPE
        // 404 / NO_FREE_IP 422) -> errorHandler (fuente unica). NUNCA re-lanzar: en Express 4 un
        // throw async no llega al errorHandler y la request queda COLGADA.
        next(err);
      }
    },
  );

  // ════════════════════════════════════════════════════════════════════════════
  // Adopción del inventario PPPoE — ingest + associate + reveal + unassigned.
  // /pppoe/unassigned (literal) va ANTES de cualquier /pppoe/:id para no ser sombreada.
  // ════════════════════════════════════════════════════════════════════════════

  // ── GET /pppoe/unassigned — huérfanos (contractId=null), DTO SIN password ────
  router.get(
    '/pppoe/unassigned',
    auth,
    canRead,
    async (_req: Request, res: Response): Promise<void> => {
      const orphans = await listUnassignedPppoe.execute();
      res.json(orphans.map(toPppoeServiceDto));
    },
  );

  // ════════════════════════════════════════════════════════════════════════════
  // internet-history — vista GLOBAL de servicios de internet (espejo de la página de TV).
  // Rutas LITERALES /pppoe y /pppoe/activation-history montadas ANTES de cualquier
  // /pppoe/:id para que el catch-all no las sombree.
  // ════════════════════════════════════════════════════════════════════════════

  // ── GET /pppoe/activation-history — historial GLOBAL de eventos de INTERNET ──
  // Espejo de GET /api/gigared/customers/activation-history. Filtros: actorId, customerId/clientId, from, to.
  if (listInternetServiceHistory) {
    router.get(
      '/pppoe/activation-history',
      auth,
      canRead,
      async (req: Request, res: Response): Promise<void> => {
        const q = req.query;
        const filter: { actorId?: string; customerId?: string; clientId?: string; from?: Date; to?: Date } = {};
        if (typeof q['actorId'] === 'string' && q['actorId'] !== '') filter.actorId = q['actorId'];
        if (typeof q['customerId'] === 'string' && q['customerId'] !== '') filter.customerId = q['customerId'];
        if (typeof q['clientId'] === 'string' && q['clientId'] !== '') filter.clientId = q['clientId'];
        if (typeof q['from'] === 'string' && q['from'] !== '') {
          const d = new Date(q['from']);
          if (!isNaN(d.getTime())) filter.from = d;
        }
        if (typeof q['to'] === 'string' && q['to'] !== '') {
          const d = new Date(q['to']);
          if (!isNaN(d.getTime())) filter.to = d;
        }
        const events = await listInternetServiceHistory.execute(filter);
        res.json(events);
      },
    );
  }

  // ── GET /pppoe/activation-history/operators — operadores DISTINCT de eventos INTERNET ──
  // Para el <select> de operadores del historial (gate pppoe.read, sin admin/rbac).
  if (listInternetActivationOperators) {
    router.get('/pppoe/activation-history/operators', auth, canRead, async (_req, res) => {
      const operators = await listInternetActivationOperators.execute();
      res.json(operators);
    });
  }

  // ── GET /pppoe/nas-move-events — registro VISIBLE de movimientos de NAS (pppoe-move-nas W1) ──
  // LITERAL, montada ANTES de cualquier /pppoe/:id para no ser sombreada por el catch-all.
  // Wire contract D6 punto 3: { items: [{id, username, fromNas, toNas, fromIp, toIp, trigger,
  // outcome, reason, actorName, createdAt}], total, page, limit }. Gate network.read.
  if (listPppoeNasMoveEvents) {
    router.get(
      '/pppoe/nas-move-events',
      auth,
      canNetworkRead,
      // fix wave 1 (ajuste 1): handler async SIEMPRE con try/catch → next(err). Sin él, un fallo
      // del use case era un unhandledRejection y la request quedaba COLGADA (Express 4).
      async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
          const q = req.query;
          const filter: { page?: number; limit?: number; outcome?: string; trigger?: string; username?: string } = {};
          if (typeof q['outcome']  === 'string' && q['outcome']  !== '') filter.outcome  = q['outcome'];
          if (typeof q['trigger']  === 'string' && q['trigger']  !== '') filter.trigger  = q['trigger'];
          if (typeof q['username'] === 'string' && q['username'] !== '') filter.username = q['username'];
          if (typeof q['page'] === 'string' && q['page'] !== '') {
            const n = parseInt(q['page'], 10);
            if (!isNaN(n) && n > 0) filter.page = n;
          }
          if (typeof q['limit'] === 'string' && q['limit'] !== '') {
            const n = parseInt(q['limit'], 10);
            if (!isNaN(n) && n > 0) filter.limit = n;
          }
          const page = await listPppoeNasMoveEvents.execute(filter);
          res.json(page);
        } catch (err) {
          next(err);
        }
      },
    );
  }

  // ── GET /pppoe — lista GLOBAL paginada de servicios de internet (DTO SIN password) ──
  // Filtros: search (cliente o username), status, nasId. Paginación: page/limit (limit≤100).
  if (listAllPppoeServices) {
    router.get(
      '/pppoe',
      auth,
      canRead,
      async (req: Request, res: Response): Promise<void> => {
        const q = req.query;
        const filter: {
          search?: string; status?: string; nasId?: string; page?: number; limit?: number;
          includeUnassigned?: boolean; pending?: boolean;
        } = {};
        if (typeof q['search'] === 'string' && q['search'] !== '') filter.search = q['search'];
        if (typeof q['status'] === 'string' && q['status'] !== '') filter.status = q['status'];
        if (typeof q['nasId']  === 'string' && q['nasId']  !== '') filter.nasId  = q['nasId'];
        if (typeof q['page']   === 'string' && q['page']   !== '') {
          const n = parseInt(q['page'], 10);
          if (!isNaN(n) && n > 0) filter.page = n;
        }
        if (typeof q['limit'] === 'string' && q['limit'] !== '') {
          const n = parseInt(q['limit'], 10);
          if (!isNaN(n) && n > 0) filter.limit = n;
        }
        // pppoe-full-management: incluir huérfanos (contractId=null) cuando se pide explícitamente.
        if (q['includeUnassigned'] === 'true') filter.includeUnassigned = true;
        // pppoe-preprovision D6.7: chip "Pendientes" server-side (nasId IS NULL, paginación correcta).
        if (q['pending'] === 'true') filter.pending = true;
        const page = await listAllPppoeServices.execute(filter);
        res.json(page);
      },
    );
  }

  // ── GET /pppoe/ids — ids del filtro activo (pppoe-bulk-select-filter v2) ─────────────
  // Mismos filtros que GET /pppoe (search/status/nasId/includeUnassigned), SIN page/limit.
  // Precondición: AL MENOS UNO de {search, status, nasId} presente → si no, 400
  // FILTER_REQUIRED (el endpoint existe para SELECCIÓN FILTRADA, nunca "todo el sistema"
  // — includeUnassigned es un toggle de scope, NO cuenta como filtro de narrowing).
  // Gate pppoe.manage (NO pppoe.read): existe exclusivamente para alimentar el bulk
  // POST /pppoe/bulk/change-plan — gatearlo en read filtraría una afordancia de bulk-
  // selection a usuarios read-only.
  // Catch async EXPLÍCITO → next(err) (sin express-async-errors, un throw async cuelga
  // la request en Express 4).
  if (listAllPppoeServiceIds) {
    router.get(
      '/pppoe/ids',
      auth,
      canManage,
      async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
          const q = req.query;
          const filter: {
            search?: string; status?: string; nasId?: string;
            includeUnassigned?: boolean; pending?: boolean;
          } = {};
          if (typeof q['search'] === 'string' && q['search'] !== '') filter.search = q['search'];
          if (typeof q['status'] === 'string' && q['status'] !== '') filter.status = q['status'];
          if (typeof q['nasId']  === 'string' && q['nasId']  !== '') filter.nasId  = q['nasId'];
          if (q['includeUnassigned'] === 'true') filter.includeUnassigned = true;
          // pppoe-preprovision D6.7: pending=true SÍ cuenta como filtro de narrowing (recorta
          // a los nasId IS NULL — un subconjunto chico), a diferencia de includeUnassigned que
          // solo AMPLÍA el scope. Habilita bulk sobre el chip "Pendientes" con paridad list↔ids.
          if (q['pending'] === 'true') filter.pending = true;

          if (!filter.search && !filter.status && !filter.nasId && !filter.pending) {
            res.status(400).json({
              code: 'FILTER_REQUIRED',
              error: 'GET /pppoe/ids requiere al menos un filtro (search, status, nasId o pending)',
            });
            return;
          }

          const result = await listAllPppoeServiceIds.execute(filter);
          res.json(result);
        } catch (err) {
          next(err);
        }
      },
    );
  }

  // ── POST /pppoe — crea PPPoE standalone con contrato opcional (pppoe-full-management) ──
  // LITERAL, montada ANTES de cualquier /pppoe/:id para no ser sombreada. Gate pppoe.manage.
  if (createPppoeStandalone) {
    router.post(
      '/pppoe',
      auth,
      canManage,
      async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const parsed = CreatePppoeStandaloneBodySchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(422).json({ code: 'VALIDATION_ERROR', details: parsed.error.issues });
          return;
        }
        try {
          // W3 fix: forwardear el actor para que el evento 'activated' lleve el nombre del operador.
          // pppoe-preprovision (S1.1): nasId ausente/null = pre-provision "pendiente de instalacion".
          const service = await createPppoeStandalone.execute(
            { ...parsed.data, nasId: parsed.data.nasId ?? null },
            actorOf(req),
          );
          res.status(201).json(toPppoeServiceDto(service));
        } catch (err) {
          if (err instanceof PppoeUsernameTakenError) {
            res.status(409).json({ code: err.code, error: err.message });
            return;
          }
          // W2 fix: contrato ya tiene PPPoE activo → 409 (no 400, que es el fallback del errorHandler).
          // En Express 4 los async handlers necesitan captura explícita — throw err no llega al errorHandler.
          if (err instanceof PppoeContractAlreadyHasServiceError) {
            res.status(409).json({ code: err.code, error: err.message });
            return;
          }
          if (err instanceof NasNotFoundError) {
            res.status(404).json({ code: err.code, error: err.message });
            return;
          }
          if (err instanceof OrchestratorRejectedError) {
            res.status(err.upstreamStatus).json({ code: err.code, error: err.message });
            return;
          }
          if (err instanceof RouterUnreachableError) {
            res.status(502).json({ code: err.code, error: err.message });
            return;
          }
          if (err instanceof OrchestratorUnreachableError) {
            res.status(502).json({ code: err.code, error: err.message });
            return;
          }
          // pppoe-preprovision (S1.4): fallos del allocator server-side -> errorHandler
          // (fuente unica). NUNCA re-lanzar: en Express 4 la request quedaria colgada.
          next(err);
        }
      },
    );
  }

  // ── POST /nas/:id/ingest-pppoe — adopta el inventario del NAS (huérfanos) ─────
  router.post(
    '/nas/:id/ingest-pppoe',
    auth,
    canManage,
    async (req: Request, res: Response): Promise<void> => {
      try {
        const result = await ingestPppoeFromNas.execute(req.params['id'] as string);
        res.json(result);
      } catch (err) {
        // RADIUS/orchestrator inalcanzable (red/timeout/5xx) → 502.
        if (err instanceof OrchestratorUnreachableError) {
          res.status(502).json({ code: err.code, error: err.message });
          return;
        }
        if (err instanceof NasNotFoundError) {
          res.status(404).json({ code: err.code, error: err.message });
          return;
        }
        // Tipo de NAS sin soporte de adopción todavía (no es radius_orchestrator).
        if (err instanceof PppoeIngestNotSupportedError) {
          res.status(422).json({ code: err.code, error: err.message });
          return;
        }
        throw err;
      }
    },
  );

  // ── POST /pppoe/:id/associate — asocia un huérfano a un contrato ─────────────
  router.post(
    '/pppoe/:id/associate',
    auth,
    canManage,
    async (req: Request, res: Response): Promise<void> => {
      const parsed = AssociatePppoeBodySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(422).json({ code: 'VALIDATION_ERROR', details: parsed.error.issues });
        return;
      }
      try {
        const service = await associatePppoeToContract.execute(req.params['id'] as string, parsed.data.contractId, actorOf(req));
        res.json(toPppoeServiceDto(service));
      } catch (err) {
        if (err instanceof PppoeServiceNotFoundError) {
          res.status(404).json({ code: err.code, error: err.message });
          return;
        }
        // Ya asociado a OTRO contrato → 409 (mover requiere desasociar primero).
        if (err instanceof PppoeAlreadyAssociatedError) {
          res.status(409).json({ code: err.code, error: err.message });
          return;
        }
        // El contrato ya tiene un PPPoE activo → 409.
        if (err instanceof PppoeContractAlreadyHasServiceError) {
          res.status(409).json({ code: err.code, error: err.message });
          return;
        }
        throw err;
      }
    },
  );

  // ── DELETE /contracts/:contractId/pppoe/:pppoeId — desasocia sin tocar el secret ─
  router.delete(
    '/contracts/:contractId/pppoe/:pppoeId',
    auth,
    canManage,
    async (req: Request, res: Response): Promise<void> => {
      const body = BajaBodySchema.safeParse(req.body);
      const reason = body.success ? (body.data?.reason ?? null) : null;
      const { actorId, actorName } = actorOf(req);
      try {
        const service = await deassociatePppoeFromContract.execute(
          req.params['pppoeId'] as string,
          req.params['contractId'] as string,
          { reason, actorId, actorName },
        );
        res.json(toPppoeServiceDto(service));
      } catch (err) {
        if (err instanceof PppoeServiceNotFoundError) {
          res.status(404).json({ code: err.code, error: err.message });
          return;
        }
        throw err;
      }
    },
  );

  // ── GET /pppoe/:id/credentials — revela {username, password} (pppoe.manage) ──
  // Superficie DEDICADA y gated; espeja el patrón de /customers/:id/tv-credentials.
  // El PppoeServiceDto NUNCA expone password: la clave SOLO sale por acá.
  router.get(
    '/pppoe/:id/credentials',
    auth,
    canManage,
    async (req: Request, res: Response): Promise<void> => {
      try {
        const creds = await getPppoeCredentials.execute(req.params['id'] as string);
        res.json(creds);
      } catch (err) {
        if (err instanceof PppoeServiceNotFoundError) {
          res.status(404).json({ code: err.code, error: err.message });
          return;
        }
        throw err;
      }
    },
  );

  // ════════════════════════════════════════════════════════════════════════════
  // Fase C — enforcement (cortes). Las rutas literales /pppoe/enforce/* van ANTES
  // de cualquier /pppoe/:id para que el catch-all no se las trague.
  // ════════════════════════════════════════════════════════════════════════════

  // ── POST /pppoe/enforce/preview — impacto del corte SIN ejecutar ─────────────
  router.post(
    '/pppoe/enforce/preview',
    auth,
    canCut,
    async (req: Request, res: Response): Promise<void> => {
      const parsed = EnforceBulkBodySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(422).json({ code: 'VALIDATION_ERROR', details: parsed.error.issues });
        return;
      }
      const result = await previewEnforcement.execute({ action: parsed.data.action, target: parsed.data.target });
      res.json({ total: result.total, byRouter: result.byRouter, sample: result.sample });
    },
  );

  // ── POST /pppoe/enforce/bulk — dispara el batch on-demand (202 + jobId) ───────
  router.post(
    '/pppoe/enforce/bulk',
    auth,
    canCut,
    async (req: Request, res: Response): Promise<void> => {
      const parsed = EnforceBulkBodySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(422).json({ code: 'VALIDATION_ERROR', details: parsed.error.issues });
        return;
      }
      // Resolver candidatos (mismo filtro que el preview: solo los que la acción cambiaría).
      const preview = await previewEnforcement.execute({ action: parsed.data.action, target: parsed.data.target });
      const started = await serviceCutRunner.start(parsed.data.action, preview.pppoeIds);
      if (!started.accepted) {
        res.status(409).json({ code: 'ENFORCEMENT_IN_PROGRESS', error: 'Ya hay un corte masivo en curso' });
        return;
      }
      res.status(202).json({ jobId: started.batchId, total: preview.total });
    },
  );

  // ── GET /pppoe/enforce/bulk/:id — progreso del batch ─────────────────────────
  router.get(
    '/pppoe/enforce/bulk/:id',
    auth,
    canCut,
    async (req: Request, res: Response): Promise<void> => {
      const batch = await serviceCutBatchRepo.findById(req.params['id'] as string);
      if (!batch) {
        res.status(404).json({ code: 'BATCH_NOT_FOUND', error: 'Batch de corte no encontrado' });
        return;
      }
      res.json(toServiceCutBatchDto(batch));
    },
  );

  // ── POST /pppoe/:id/enforce — corte individual ───────────────────────────────
  router.post(
    '/pppoe/:id/enforce',
    auth,
    canCut,
    async (req: Request, res: Response): Promise<void> => {
      const parsed = EnforcePppoeBodySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(422).json({ code: 'VALIDATION_ERROR', details: parsed.error.issues });
        return;
      }
      try {
        const service = await enforcePppoeService.execute({
          id:     req.params['id'] as string,
          action: parsed.data.action,
          reason: parsed.data.reason ?? null,
          ...actorOf(req),
        });
        res.json(toPppoeServiceDto(service));
      } catch (err) {
        // Backend de corte inalcanzable (MK-directo o RADIUS/orchestrator) → 502.
        if (err instanceof RouterUnreachableError || err instanceof OrchestratorUnreachableError) {
          res.status(502).json({ code: err.code, error: err.message });
          return;
        }
        if (err instanceof PppoeServiceNotFoundError) {
          res.status(404).json({ code: err.code, error: err.message });
          return;
        }
        if (err instanceof NasNotFoundError) {
          res.status(404).json({ code: err.code, error: err.message });
          return;
        }
        // pppoe-preprovision (S4.2): pendiente de instalacion -> 409 tipado (wire contract).
        if (err instanceof PppoePendingInstallError) {
          res.status(409).json({ code: err.code, error: err.message });
          return;
        }
        throw err;
      }
    },
  );

  // ── PATCH /pppoe/:id ────────────────────────────────────────────────────────
  router.patch(
    '/pppoe/:id',
    auth,
    canManage,
    async (req: Request, res: Response): Promise<void> => {
      const parsed = UpdatePppoeBodySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(422).json({ code: 'VALIDATION_ERROR', details: parsed.error.issues });
        return;
      }
      try {
        const service = await updatePppoeService.execute({
          id: req.params['id'] as string,
          ...parsed.data,
          ...actorOf(req),
        });
        res.json(toPppoeServiceDto(service));
      } catch (err) {
        if (err instanceof RouterUnreachableError) {
          res.status(502).json({ code: err.code, error: err.message });
          return;
        }
        if (err instanceof PppoeServiceNotFoundError) {
          res.status(404).json({ code: err.code, error: err.message });
          return;
        }
        if (err instanceof NasNotFoundError) {
          res.status(404).json({ code: err.code, error: err.message });
          return;
        }
        // pppoe-preprovision (REQ-PRE-4): pendiente de instalacion -> 409 tipado, no editable.
        if (err instanceof PppoePendingInstallError) {
          res.status(409).json({ code: err.code, error: err.message });
          return;
        }
        throw err;
      }
    },
  );

  // ── POST /pppoe/:id/move ────────────────────────────────────────────────────
  // Sub-recurso /move montado ANTES de que cualquier catch-all /:id lo sombree.
  // pppoe-move-nas W1: cablea el NUEVO MovePppoeToNas (radius-aware, body {nasId, force?}).
  // Si no está wired cae al legacy (back-compat de fixtures viejas; en prod SIEMPRE viene wired).
  // fix wave 1 (ajuste 1): el handler termina en next(err) — en Express 4 un `throw` async NO
  // llega al errorHandler y la request queda COLGADA (unhandledRejection). El errorHandler es la
  // fuente ÚNICA del mapeo code→status: 502 unreachable · 404 not-found/NO_POOL_FOR_NAS_TYPE ·
  // 422 NO_FREE_IP · 409 mixto/terminated/pública-sin-force · 500 desconocidos.
  router.post(
    '/pppoe/:id/move',
    auth,
    canManage,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      const parsed = MovePppoeBodySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(422).json({ code: 'VALIDATION_ERROR', details: parsed.error.issues });
        return;
      }
      try {
        const service = movePppoeToNas
          ? await movePppoeToNas.execute(
              {
                id: req.params['id'] as string,
                nasId: parsed.data.nasId,
                force: parsed.data.force,
                trigger: 'manual',
              },
              actorOf(req),
            )
          : await movePppoeServiceToRouter.execute({
              id: req.params['id'] as string,
              nasId: parsed.data.nasId,
            });
        res.json(toPppoeServiceDto(service));
      } catch (err) {
        // El orchestrator RECHAZÓ el move (4xx) — p.ej. colisión de Framed-IP persistente tras el
        // retry (S1.6). Reenviamos su status (patrón de la ruta create).
        if (err instanceof OrchestratorRejectedError) {
          res.status(err.upstreamStatus).json({ code: err.code, error: err.message });
          return;
        }
        // Resto → errorHandler (fuente única). NUNCA `throw`: la request quedaría colgada.
        next(err);
      }
    },
  );

  // ── POST /pppoe/:id/rename — renombra PPPoE (create-then-delete, pppoe-full-management) ──
  // Montado ANTES de DELETE /pppoe/:id (distinto verbo, pero evitamos ambigüedad). Gate pppoe.manage.
  if (renamePppoeUsername) {
    router.post(
      '/pppoe/:id/rename',
      auth,
      canManage,
      async (req: Request, res: Response): Promise<void> => {
        const parsed = RenamePppoeBodySchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(422).json({ code: 'VALIDATION_ERROR', details: parsed.error.issues });
          return;
        }
        try {
          const result = await renamePppoeUsername.execute({
            id: req.params['id'] as string,
            newUsername: parsed.data.newUsername,
          });
          res.json(result);
        } catch (err) {
          if (err instanceof PppoeServiceNotFoundError) {
            res.status(404).json({ code: err.code, error: err.message });
            return;
          }
          if (err instanceof PppoeUsernameTakenError) {
            res.status(409).json({ code: err.code, error: err.message });
            return;
          }
          // fix-wave-2: NAS inválido/incorrecto → 404 o 422 (misma lógica que standalone).
          if (err instanceof NasNotFoundError) {
            res.status(404).json({ code: err.code, error: err.message });
            return;
          }
          if (err instanceof PppoeRenameNasNotSupportedError) {
            res.status(422).json({ code: err.code, error: err.message });
            return;
          }
          if (err instanceof PppoeProfileRequiredError) {
            res.status(422).json({ code: err.code, error: err.message });
            return;
          }
          if (err instanceof OrchestratorUnreachableError) {
            res.status(502).json({ code: err.code, error: err.message });
            return;
          }
          if (err instanceof OrchestratorRejectedError) {
            res.status(err.upstreamStatus).json({ code: err.code, error: err.message });
            return;
          }
          // pppoe-preprovision (REQ-PRE-4): pendiente de instalacion -> 409 tipado.
          if (err instanceof PppoePendingInstallError) {
            res.status(409).json({ code: err.code, error: err.message });
            return;
          }
          throw err;
        }
      },
    );
  }

  // ── DELETE /pppoe/:id — baja HARD (terminate): borra del RADIUS, libera IP ──
  // Usa TerminatePppoeService si está wired (pppoe-terminate-callerid); cae a
  // DeactivatePppoeService por back-compat si no está inyectado.
  router.delete(
    '/pppoe/:id',
    auth,
    canManage,
    async (req: Request, res: Response): Promise<void> => {
      const body = BajaBodySchema.safeParse(req.body);
      const reason = body.success ? (body.data?.reason ?? null) : null;
      const { actorId, actorName } = actorOf(req);
      const handler = terminatePppoeService ?? deactivatePppoeService;
      try {
        await handler.execute(req.params['id'] as string, { reason, actorId, actorName });
        res.status(204).send();
      } catch (err) {
        if (err instanceof RouterUnreachableError || err instanceof OrchestratorUnreachableError) {
          res.status(502).json({ code: err.code, error: err.message });
          return;
        }
        if (err instanceof PppoeServiceNotFoundError) {
          res.status(404).json({ code: err.code, error: err.message });
          return;
        }
        if (err instanceof NasNotFoundError) {
          res.status(404).json({ code: err.code, error: err.message });
          return;
        }
        // pppoe-preprovision: el fallback deactivate rechaza pendientes con 409 tipado
        // (el terminate wired en prod SI los borra del RADIUS central).
        if (err instanceof PppoePendingInstallError) {
          res.status(409).json({ code: err.code, error: err.message });
          return;
        }
        throw err;
      }
    },
  );

  // ── GET /pppoe/:id/caller-id — MAC del CPE desde la sesión RADIUS activa ───
  // Gated pppoe.read. Llama orchestrator.listSessions y extrae el callerId.
  // GET /pppoe/:id/caller-id y DELETE /pppoe/:id no se pisan (distinto verbo); para GET, Express
  // matchea el path literal más largo primero.
  if (getPppoeCallerId) {
    router.get(
      '/pppoe/:id/caller-id',
      auth,
      canRead,
      async (req: Request, res: Response): Promise<void> => {
        try {
          const callerId = await getPppoeCallerId.execute(req.params['id'] as string);
          res.json({ callerId });
        } catch (err) {
          if (err instanceof PppoeServiceNotFoundError) {
            res.status(404).json({ code: err.code, error: err.message });
            return;
          }
          throw err;
        }
      },
    );
  }

  // ── POST /pppoe/:id/pin-ip — pinea una IP fija (bypass del pool) (pppoe-pool-ip) ──
  if (pinPppoeIp) {
    router.post(
      '/pppoe/:id/pin-ip',
      auth,
      canManage,
      async (req: Request, res: Response): Promise<void> => {
        const parsed = PinIpBodySchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(422).json({ code: 'VALIDATION_ERROR', details: parsed.error.issues });
          return;
        }
        try {
          const service = await pinPppoeIp.execute({ pppoeId: req.params['id'] as string, ip: parsed.data.ip });
          res.json(toPppoeServiceDto(service));
        } catch (err) {
          if (err instanceof InvalidIpFormatError) {
            res.status(422).json({ code: err.code, error: err.message });
            return;
          }
          if (err instanceof IpAlreadyTakenError) {
            res.status(409).json({ code: err.code, error: err.message });
            return;
          }
          if (err instanceof PppoeServiceNotFoundError || err instanceof NasNotFoundError) {
            res.status(404).json({ code: err.code, error: err.message });
            return;
          }
          // pppoe-preprovision (REQ-PRE-4): pendiente de instalacion -> 409 tipado.
          if (err instanceof PppoePendingInstallError) {
            res.status(409).json({ code: err.code, error: err.message });
            return;
          }
          // NAS no-RADIUS (pin no soportado) y orchestrator caído → 502.
          if (err instanceof OrchestratorUnreachableError) {
            res.status(502).json({ code: err.code, error: err.message });
            return;
          }
          throw err;
        }
      },
    );
  }

  // ── POST /pppoe/:id/unpin-ip — libera la IP fija, vuelve al pool (pppoe-pool-ip) ──
  if (unpinPppoeIp) {
    router.post(
      '/pppoe/:id/unpin-ip',
      auth,
      canManage,
      async (req: Request, res: Response): Promise<void> => {
        try {
          const service = await unpinPppoeIp.execute({ pppoeId: req.params['id'] as string });
          res.json(toPppoeServiceDto(service));
        } catch (err) {
          // NAS sin poolName (no pool-mode) → 409 (no hay pool al que volver).
          if (err instanceof NasNoPoolError) {
            res.status(409).json({ code: err.code, error: err.message });
            return;
          }
          // pppoe-preprovision (REQ-PRE-4): pendiente de instalacion -> 409 tipado.
          if (err instanceof PppoePendingInstallError) {
            res.status(409).json({ code: err.code, error: err.message });
            return;
          }
          if (err instanceof PppoeServiceNotFoundError || err instanceof NasNotFoundError) {
            res.status(404).json({ code: err.code, error: err.message });
            return;
          }
          if (err instanceof OrchestratorUnreachableError) {
            res.status(502).json({ code: err.code, error: err.message });
            return;
          }
          throw err;
        }
      },
    );
  }

  // ── POST /pppoe/bulk/change-plan — bulk plan change (pppoe-search-bulk-plan) ──
  // Gate: pppoe.manage (same as PATCH /pppoe/:id). No routing ambiguity with any /pppoe/:id*
  // route: this path has 2 LITERAL segments ("bulk"/"change-plan") — Express only matches a
  // `/pppoe/:id/<subresource>` pattern when the 3rd segment is literally that subresource (e.g.
  // "move", "rename"), and there is no bare POST /pppoe/:id in this router (PATCH /pppoe/:id is
  // a different HTTP verb). Cosmetic fix-wave: the old comment here ("MUST be defined BEFORE
  // /pppoe/:id") was false — order doesn't matter for this route.
  // Best-effort: partial successes return 200 with failed[] populated.
  // Pre-flight throws (BulkEmptyIdsError, BulkTooLargeError, PlanNotFoundForBulkError) → 422.
  // W1 fix: any OTHER unexpected rejection goes to `next(err)` (NOT `throw err`) so the global
  // errorHandler can respond 500 — `throw` inside an async Express 4 handler is an unhandled
  // rejection that never sends a response (the request hangs).
  if (bulkChangePppoePlan) {
    router.post(
      '/pppoe/bulk/change-plan',
      auth,
      canManage,
      async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const parsed = BulkChangePlanBodySchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(422).json({ code: 'VALIDATION_ERROR', details: parsed.error.issues });
          return;
        }
        const { actorId, actorName } = actorOf(req);
        try {
          const result = await bulkChangePppoePlan.execute({
            ids:      parsed.data.ids,
            profile:  parsed.data.profile,
            reason:   parsed.data.reason ?? null,
            actorId,
            actorName,
          });
          res.json(result);
        } catch (err) {
          if (err instanceof BulkEmptyIdsError) {
            res.status(422).json({ code: err.code, error: err.message });
            return;
          }
          if (err instanceof BulkTooLargeError) {
            res.status(422).json({ code: err.code, error: err.message });
            return;
          }
          if (err instanceof PlanNotFoundForBulkError) {
            res.status(422).json({ code: err.code, error: err.message });
            return;
          }
          next(err);
        }
      },
    );
  }

  return router;
}
