/**
 * pppoe.routes.ts — rutas HTTP para gestión de PPPoE.
 *
 * Endpoints:
 *   GET    /api/contracts/:contractId/pppoe      pppoe.read
 *   POST   /api/contracts/:contractId/pppoe      pppoe.manage
 *   PATCH  /api/pppoe/:id                         pppoe.manage
 *   POST   /api/pppoe/:id/move                    pppoe.manage
 *   DELETE /api/pppoe/:id                         pppoe.manage  (baja soft)
 *   --- Adopción del inventario ---
 *   GET    /api/pppoe/unassigned                  pppoe.read    (huérfanos, sin password)
 *   POST   /api/nas/:id/ingest-pppoe              pppoe.manage  (adopta el inventario del NAS)
 *   POST   /api/pppoe/:id/associate              pppoe.manage  (asocia a un contrato)
 *   DELETE /api/contracts/:contractId/pppoe/:pppoeId  pppoe.manage  (desasocia: contractId=null, sin baja)
 *   GET    /api/pppoe/:id/credentials            pppoe.manage  (revela {username, password})
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
import { TerminatePppoeService } from '@application/use-cases/TerminatePppoeService';
import { GetPppoeCallerId } from '@application/use-cases/GetPppoeCallerId';
import { EnforcePppoeService } from '@application/use-cases/EnforcePppoeService';
import { PreviewEnforcement } from '@application/use-cases/PreviewEnforcement';
import { IngestPppoeFromNas } from '@application/use-cases/IngestPppoeFromNas';
import { AssociatePppoeToContract } from '@application/use-cases/AssociatePppoeToContract';
import { GetPppoeCredentials } from '@application/use-cases/GetPppoeCredentials';
import { ListUnassignedPppoe } from '@application/use-cases/ListUnassignedPppoe';
import { DeassociatePppoeFromContract } from '@application/use-cases/DeassociatePppoeFromContract';
import type { ServiceCutRunner } from '@infrastructure/scheduling/ServiceCutRunner';
import type { ServiceCutBatchRepository } from '@domain/ports/ServiceCutBatchRepository';
import {
  CreatePppoeBodySchema,
  UpdatePppoeBodySchema,
  MovePppoeBodySchema,
  AssociatePppoeBodySchema,
  EnforcePppoeBodySchema,
  EnforceBulkBodySchema,
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
  NasNotFoundError,
} from '@domain/errors/pppoe';

const BajaBodySchema = z.object({ reason: z.string().nullish() }).optional();

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
        throw err;
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
        // Tipo de NAS sin soporte de adopción todavía (no es mikrotik_radius).
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

  return router;
}
