/**
 * pppoe.routes.ts — rutas HTTP para gestión de PPPoE.
 *
 * Endpoints:
 *   GET    /api/contracts/:contractId/pppoe      pppoe.read
 *   POST   /api/contracts/:contractId/pppoe      pppoe.manage
 *   PATCH  /api/pppoe/:id                         pppoe.manage
 *   POST   /api/pppoe/:id/move                    pppoe.manage
 *   DELETE /api/pppoe/:id                         pppoe.manage  (baja soft)
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
 *   zod invalid           → 422
 */
import { Router, Request, Response, RequestHandler } from 'express';
import { AuthProvider } from '@domain/ports/AuthProvider';
import type { SessionRepository } from '@domain/ports/SessionRepository';
import type { RbacModuleCode, PermissionAction } from '@domain/entities/rbac';
import { createAuthMiddleware } from '../middleware/authMiddleware';
import { ListPppoeByContract } from '@application/use-cases/ListPppoeByContract';
import { CreatePppoeService } from '@application/use-cases/CreatePppoeService';
import { UpdatePppoeService } from '@application/use-cases/UpdatePppoeService';
import { MovePppoeServiceToRouter } from '@application/use-cases/MovePppoeServiceToRouter';
import { DeactivatePppoeService } from '@application/use-cases/DeactivatePppoeService';
import { EnforcePppoeService } from '@application/use-cases/EnforcePppoeService';
import { PreviewEnforcement } from '@application/use-cases/PreviewEnforcement';
import type { ServiceCutRunner } from '@infrastructure/scheduling/ServiceCutRunner';
import type { ServiceCutBatchRepository } from '@domain/ports/ServiceCutBatchRepository';
import {
  CreatePppoeBodySchema,
  UpdatePppoeBodySchema,
  MovePppoeBodySchema,
  EnforcePppoeBodySchema,
  EnforceBulkBodySchema,
  toPppoeServiceDto,
  toServiceCutBatchDto,
} from '@application/dto/pppoe.dto';
import {
  RouterUnreachableError,
  OrchestratorUnreachableError,
  OrchestratorRejectedError,
  PppoeUsernameTakenError,
  PppoeProfileRequiredError,
  PppoeServiceNotFoundError,
  NasNotFoundError,
} from '@domain/errors/pppoe';

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
): Router {
  const router = Router();
  // STATEFUL en prod (sessionRepo presente): una sesión revocada NO puede cortar servicio.
  // El corte es el endpoint más destructivo del módulo — el guard de revocación es innegociable.
  const auth     = createAuthMiddleware(authProvider, sessionRepo);
  const canRead   = requirePerm('pppoe', 'read');
  const canManage = requirePerm('pppoe', 'manage');
  const canCut    = requirePerm('pppoe', 'cut');

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
    async (req: Request, res: Response): Promise<void> => {
      const parsed = CreatePppoeBodySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(422).json({ code: 'VALIDATION_ERROR', details: parsed.error.issues });
        return;
      }
      try {
        const service = await createPppoeService.execute({
          contractId: req.params['contractId'] as string,
          ...parsed.data,
        });
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
        // Alta en NAS RADIUS sin profile → el plan/grupo es obligatorio.
        if (err instanceof PppoeProfileRequiredError) {
          res.status(422).json({ code: err.code, error: err.message });
          return;
        }
        if (err instanceof NasNotFoundError) {
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
          id: req.params['id'] as string,
          action: parsed.data.action,
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
        throw err;
      }
    },
  );

  // ── POST /pppoe/:id/move ────────────────────────────────────────────────────
  // Sub-recurso /move montado ANTES de que cualquier catch-all /:id lo sombree.
  router.post(
    '/pppoe/:id/move',
    auth,
    canManage,
    async (req: Request, res: Response): Promise<void> => {
      const parsed = MovePppoeBodySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(422).json({ code: 'VALIDATION_ERROR', details: parsed.error.issues });
        return;
      }
      try {
        const service = await movePppoeServiceToRouter.execute({
          id: req.params['id'] as string,
          nasId: parsed.data.nasId,
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
        throw err;
      }
    },
  );

  // ── DELETE /pppoe/:id ───────────────────────────────────────────────────────
  router.delete(
    '/pppoe/:id',
    auth,
    canManage,
    async (req: Request, res: Response): Promise<void> => {
      try {
        await deactivatePppoeService.execute(req.params['id'] as string);
        res.status(204).send();
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
        throw err;
      }
    },
  );

  return router;
}
