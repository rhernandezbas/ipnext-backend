import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import type { GetGigaredConfig } from '@application/use-cases/gigared/GetGigaredConfig';
import type { UpdateGigaredConfig } from '@application/use-cases/gigared/UpdateGigaredConfig';
import type { GetGigaredSummary } from '@application/use-cases/gigared/GetGigaredSummary';
import type { ListGigaredAccounts } from '@application/use-cases/gigared/ListGigaredAccounts';
import type { GetGigaredCustomerAccount } from '@application/use-cases/gigared/GetGigaredCustomerAccount';
import type { LinkCustomerToCic } from '@application/use-cases/gigared/LinkCustomerToCic';
import type { RegisterGigaredAccount } from '@application/use-cases/gigared/RegisterGigaredAccount';
import type { AddTvService } from '@application/use-cases/gigared/AddTvService';
import type { RemoveTvService } from '@application/use-cases/gigared/RemoveTvService';
import type { SetOttStatus } from '@application/use-cases/gigared/SetOttStatus';
import type { CancelTv } from '@application/use-cases/gigared/CancelTv';
import type { ChangeTvPassword } from '@application/use-cases/gigared/ChangeTvPassword';
import type { GetTvCredentials } from '@application/use-cases/gigared/GetTvCredentials';
import type { ListTvActivationHistory } from '@application/use-cases/gigared/ListTvActivationHistory';
import type { GigaredConfigRepository } from '@domain/ports/GigaredConfigRepository';
import type { FeatureFlagRepository } from '@domain/ports/FeatureFlagRepository';
import type { ListAccountsFilter } from '@domain/ports/GigaredPort';
import type { ClientTvCancelStatusRepository } from '@domain/ports/ClientTvCancelStatusRepository';
import type { CancelTvJobRunner } from '@infrastructure/scheduling/CancelTvJobRunner';
import type { CustomerLookup, ContractLookup } from '@application/use-cases/gigared/lookups';
import { GIGARED_FLAG } from '@application/use-cases/gigared/GetGigaredConfig';
import { updateGigaredConfigSchema } from '@application/dto/gigared.dto';
import {
  GigaredNotConfiguredError,
  GigaredUnavailableError,
  GigaredAuthError,
  GigaredNotFoundError,
  GigaredRejectedError,
  GigaredInvalidPasswordError,
  TvCatalogMissingError,
  TvNotLinkedError,
  CicNotFoundError,
  CicAlreadyLinkedError,
  GrClientIdRequiredError,
  GrContractIdRequiredError,
  NoCicAvailableError,
} from '@domain/errors/gigared';
import { ClientNotFoundError } from '@domain/errors';
import { ContractNotFoundError } from '@domain/errors/contractServices';

/**
 * Readiness middleware (M1). Two gating levels, both built from the same repos:
 *
 *  - apiKey is required ALWAYS (key === '' → 503), so the "test connection" probe still
 *    validates the key. This is the floor for EVERY gated route, flag ON or OFF.
 *  - the FLAG gates everything EXCEPT /config and GET /summary. /summary is the probe:
 *    with the flag OFF but a key set it must answer (200) so the operator can validate the
 *    key before turning the integration on. Pass { requireFlag: false } for the probe route.
 *
 * Defense-in-depth: GigaredClient also throws if the key is empty at call time, covering the
 * race between this check and the outbound request.
 */
export function createGigaredReadyMiddleware(
  configRepo: GigaredConfigRepository,
  flagRepo: FeatureFlagRepository,
  opts: { requireFlag?: boolean } = {},
): RequestHandler {
  const requireFlag = opts.requireFlag ?? true;
  return async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const cfg = await configRepo.get();
      // Key required always — probe included.
      if (cfg.apiKey === '') {
        res.status(503).json({ error: 'Gigared integration is not configured', code: 'GIGARED_NOT_CONFIGURED' });
        return;
      }
      if (requireFlag) {
        const flag = await flagRepo.get(GIGARED_FLAG);
        if (!flag?.enabled) {
          res.status(503).json({ error: 'Gigared integration is not configured', code: 'GIGARED_NOT_CONFIGURED' });
          return;
        }
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * #4 — fallback for errors that sendGigaredError does not recognise (e.g. raw Prisma errors,
 * unexpected infrastructure failures). Logs the error with a gigared-scoped prefix for prod
 * visibility and returns a structured 500 so the FE errorDetail/errorCode can read them.
 * This replaces the old `next(err)` path that produced an opaque/empty 500 via errorHandler.
 */
function sendUnhandled(res: Response, err: unknown, route: string): void {
  console.error(`[gigared] ${route}: unhandled`, err);
  res.status(500).json({ error: 'Ha ocurrido un error inesperado en el servidor.', code: 'INTERNAL_ERROR' });
}

/** Map a Gigared/domain error to its FROZEN wire-contract HTTP status + body. Returns false if unhandled. */
function sendGigaredError(res: Response, err: unknown): boolean {
  if (err instanceof GigaredNotConfiguredError) {
    res.status(503).json({ error: err.message, code: err.code });
    return true;
  }
  if (err instanceof GigaredUnavailableError) {
    // #47g — surface the upstream detail (the REAL reason) when Gigared gave one.
    const body: Record<string, unknown> = { error: err.message, code: err.code };
    if (err.detail) body['detail'] = err.detail;
    res.status(503).json(body);
    return true;
  }
  if (err instanceof GigaredAuthError) {
    // #47g — surface the upstream detail (the REAL reason) when Gigared gave one.
    const body: Record<string, unknown> = { error: err.message, code: err.code };
    if (err.detail) body['detail'] = err.detail;
    res.status(502).json(body);
    return true;
  }
  if (err instanceof GigaredNotFoundError) {
    res.status(404).json({ error: err.message, code: err.code });
    return true;
  }
  if (err instanceof CicNotFoundError) {
    res.status(404).json({ error: err.message, code: err.code });
    return true;
  }
  if (err instanceof CicAlreadyLinkedError) {
    res.status(409).json({ error: err.message, code: err.code, linkedInternalId: err.linkedInternalId });
    return true;
  }
  if (err instanceof ClientNotFoundError) {
    res.status(404).json({ error: err.message, code: err.code });
    return true;
  }
  if (err instanceof ContractNotFoundError) {
    res.status(404).json({ error: err.message, code: err.code });
    return true;
  }
  if (err instanceof GigaredInvalidPasswordError) {
    res.status(400).json({ error: err.message, code: err.code });
    return true;
  }
  if (err instanceof GigaredRejectedError) {
    res.status(422).json({ error: err.message, code: err.code, title: err.title, detail: err.detail });
    return true;
  }
  if (err instanceof TvCatalogMissingError) {
    res.status(422).json({ error: err.message, code: err.code });
    return true;
  }
  // #70 — register sin grClienteId: no hay fuente para la password determinística → 422.
  if (err instanceof GrClientIdRequiredError) {
    res.status(422).json({ error: err.message, code: err.code });
    return true;
  }
  // #115 — register: el contrato no tiene grContratoId o produce una password fuera de CUA → 422.
  if (err instanceof GrContractIdRequiredError) {
    res.status(422).json({ error: err.message, code: err.code });
    return true;
  }
  // #109 — pool de CICs agotado: no hay cuenta unregistered disponible → 422.
  if (err instanceof NoCicAvailableError) {
    res.status(422).json({ error: err.message, code: err.code });
    return true;
  }
  if (err instanceof TvNotLinkedError) {
    res.status(404).json({ error: err.message, code: err.code });
    return true;
  }
  return false;
}

export interface GigaredRouterDeps {
  getConfig: GetGigaredConfig;
  updateConfig: UpdateGigaredConfig;
  getSummary: GetGigaredSummary;
  listAccounts: ListGigaredAccounts;
  getCustomerAccount: GetGigaredCustomerAccount;
  linkCustomerToCic: LinkCustomerToCic;
  registerAccount: RegisterGigaredAccount;
  addTvService: AddTvService;
  removeTvService: RemoveTvService;
  setOttStatus: SetOttStatus;
  cancelTv: CancelTv;
  changeTvPassword: ChangeTvPassword;
  getTvCredentials: GetTvCredentials;
  requireRead: RequestHandler;
  // #50 — granular TV permissions (replace the generic tv.write guard).
  requireLink: RequestHandler;     // tv.link — vincular/desvincular CIC
  requireRegister: RequestHandler; // tv.register — registrar cuentas nuevas
  requirePacks: RequestHandler;    // tv.packs — agregar/quitar packs
  requireOtt: RequestHandler;      // tv.ott — habilitar/deshabilitar OTT
  requireCancel: RequestHandler;   // tv.cancel — dar de baja TV
  requireManage: RequestHandler;
  /** Key-required + flag-required — gates every non-probe, non-config route. */
  gigaredReady: RequestHandler;
  /** Key-required only (flag exempt) — gates the GET /summary probe (M1). */
  gigaredProbeReady: RequestHandler;
  // #10/#11 — async TV-cancel deps
  /** Runner that executes CancelTv in the background (fire-and-forget). */
  cancelTvRunner: CancelTvJobRunner;
  /** Repository to read/write async cancel-job status on Client. */
  cancelStatus: ClientTvCancelStatusRepository;
  /**
   * Customer + contract lookups shared with CancelTv for fast pre-queue validation.
   * The route validates customer existence + contract ownership BEFORE queuing the job
   * (no partner call). Must be the same instances injected into the CancelTv use case.
   */
  customerLookup: CustomerLookup;
  contractLookup: ContractLookup;
  /** #5 BE — TV activation history query use case. */
  listActivationHistory: ListTvActivationHistory;
}

/**
 * Gigared TV router (#47). Mount: app.use('/api/gigared', createAuthMiddleware(...), router).
 * Order (D2): /config (GET/PUT, tv.manage) → router.use(gigaredReady) → the rest (read + granular ops #50).
 * Errors are caught BY INSTANCE here so each maps to its pinned status (pattern uisp.routes.ts).
 */
export function createGigaredRouter(deps: GigaredRouterDeps): Router {
  const router = Router();

  // ---- /config — always accessible (no gigaredReady gate) ------------------
  router.get('/config', deps.requireManage, async (_req, res): Promise<void> => {
    try {
      res.json(await deps.getConfig.execute());
    } catch (err) {
      if (!sendGigaredError(res, err)) sendUnhandled(res, err, 'config:get');
    }
  });

  router.put('/config', deps.requireManage, async (req, res): Promise<void> => {
    const parsed = updateGigaredConfigSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid config payload', code: 'VALIDATION_ERROR' });
      return;
    }
    try {
      res.json(await deps.updateConfig.execute(parsed.data));
    } catch (err) {
      if (!sendGigaredError(res, err)) sendUnhandled(res, err, 'config:put');
    }
  });

  // ---- probe: GET /summary — key required, flag EXEMPT (M1) -----------------
  // Lets the operator validate the API key with the flag OFF ("test connection").
  router.get('/summary', deps.gigaredProbeReady, deps.requireRead, async (_req, res): Promise<void> => {
    try {
      res.json(await deps.getSummary.execute());
    } catch (err) {
      if (!sendGigaredError(res, err)) sendUnhandled(res, err, 'summary');
    }
  });

  // ---- everything below requires the integration to be fully ready (key + flag) ----
  router.use(deps.gigaredReady);

  router.get('/accounts', deps.requireRead, async (req, res): Promise<void> => {
    try {
      const q = req.query;
      const filter: ListAccountsFilter = {};
      if (typeof q['email'] === 'string') filter.email = q['email'];
      if (typeof q['account_id'] === 'string') filter.accountId = q['account_id'];
      if (q['status'] === 'registered' || q['status'] === 'unregistered') filter.status = q['status'];
      if (typeof q['pagination_limit'] === 'string') filter.paginationLimit = Number(q['pagination_limit']);
      if (typeof q['pagination_offset'] === 'string') filter.paginationOffset = Number(q['pagination_offset']);
      res.json(await deps.listAccounts.execute(filter));
    } catch (err) {
      if (!sendGigaredError(res, err)) sendUnhandled(res, err, 'accounts:list');
    }
  });

  router.get('/customers/:id/account', deps.requireRead, async (req, res): Promise<void> => {
    try {
      res.json(await deps.getCustomerAccount.execute(req.params['id'] as string));
    } catch (err) {
      if (!sendGigaredError(res, err)) sendUnhandled(res, err, 'account:get');
    }
  });

  router.post('/customers/:id/link', deps.requireLink, async (req, res): Promise<void> => {
    try {
      const body = req.body as { cic?: unknown; contractId?: unknown };
      const cic = String(body.cic ?? '');
      // contractId optional (47f): present → reconcile the local TV slot in that contract.
      const contractId = typeof body.contractId === 'string' && body.contractId !== '' ? body.contractId : undefined;
      const result = await deps.linkCustomerToCic.execute(req.params['id'] as string, cic, contractId);
      // local:'failed' mirrors AddTvService → 207 (link kept, retry = re-POST). Else 200.
      res.status(result.local === 'failed' ? 207 : 200).json(result);
    } catch (err) {
      if (!sendGigaredError(res, err)) sendUnhandled(res, err, 'link');
    }
  });

  router.post('/customers/:id/register', deps.requireRegister, async (req, res): Promise<void> => {
    try {
      const b = req.body as {
        firstName: string; lastName: string; email: string;
        // #109 — `cic` ya no se acepta del FE; el CIC se asigna automáticamente del pool.
        // Se mantiene en el tipo para tolerancia de deploy (si el FE viejo lo manda, se ignora).
        cic?: string;
        password?: unknown; sendActivationEmail?: boolean; contractId?: unknown;
      };
      // #70 rework — el body YA NO acepta password. Se genera SERVER-SIDE en el use case a partir
      // del grContratoId del contrato (#115). Si el FE viejo todavía manda `password`, se IGNORA
      // acá con un strip silencioso (tolerancia durante la ventana de deploy).
      void b.password; // descartada a propósito: no se lee ni se reenvía a Gigared.
      void b.cic;      // #109 — descartada: el CIC viene del pool automático, no del FE.

      // #115 — contractId REQUERIDO: la identidad determinística de TV deriva del grContratoId del
      // contrato (no del grClienteId del cliente). Sin contractId → 400 antes de llamar al use case.
      const contractId = typeof b.contractId === 'string' && b.contractId !== '' ? b.contractId : '';
      if (contractId === '') {
        res.status(400).json({ error: 'contractId es obligatorio', code: 'VALIDATION_ERROR' });
        return;
      }

      // #5 BE — thread actor from req.user for the TV activation event recording.
      const actor = req.user ? { actorId: req.user.id, actorName: req.user.username } : { actorId: null, actorName: '' };
      const account = await deps.registerAccount.execute(req.params['id'] as string, {
        firstName: b.firstName,
        lastName: b.lastName,
        email: b.email,
        sendActivationEmail: b.sendActivationEmail ?? false,
        contractId,
        actorId:   actor.actorId,
        actorName: actor.actorName,
      });
      res.status(201).json(account);
    } catch (err) {
      if (!sendGigaredError(res, err)) sendUnhandled(res, err, 'register');
    }
  });

  // #65 — cambiar la contraseña de la cuenta de TV. Body { contractId, password }.
  // #65 fix wave H1 (SEGURIDAD): el `cic` NO viaja en el body — un operador no puede targetear
  // la cuenta de OTRO cliente. El use case resuelve la cuenta del cliente por use_internal_id y
  // usa SU cic (cuenta sin vincular → 404 TV_NOT_LINKED). Guard tv.register. El use case valida
  // CUA antes de tocar Gigared (400 VALIDATION_ERROR); un rechazo del partner sube RFC 9457 (#47g).
  router.post('/customers/:id/tv-password', deps.requireRegister, async (req, res): Promise<void> => {
    try {
      const b = req.body as { contractId?: unknown; password?: unknown };
      const contractId = String(b.contractId ?? '');
      const password = typeof b.password === 'string' ? b.password : '';
      if (contractId === '') {
        res.status(400).json({ error: 'contractId es obligatorio', code: 'VALIDATION_ERROR' });
        return;
      }
      const result = await deps.changeTvPassword.execute(req.params['id'] as string, {
        contractId,
        password,
      });
      res.json(result);
    } catch (err) {
      if (!sendGigaredError(res, err)) sendUnhandled(res, err, 'tv-password');
    }
  });

  // #65 fix wave H3 (SEGURIDAD) — superficie dedicada para las credenciales de Gigared Play.
  // Reemplaza la fuga donde tvPassword salía por GET /:id/contracts y por los responses de
  // add/update service. Guard tv.register (mismo que el cambio de password). Sin fila TV → 404.
  router.get('/customers/:id/tv-credentials', deps.requireRegister, async (req, res): Promise<void> => {
    try {
      const result = await deps.getTvCredentials.execute(req.params['id'] as string);
      res.json(result);
    } catch (err) {
      if (!sendGigaredError(res, err)) sendUnhandled(res, err, 'tv-credentials');
    }
  });

  router.post('/customers/:id/services', deps.requirePacks, async (req, res): Promise<void> => {
    try {
      const b = req.body as { serviceId: string; contractId: string };
      const result = await deps.addTvService.execute(req.params['id'] as string, {
        serviceId: b.serviceId,
        contractId: b.contractId,
      });
      res.status(result.local === 'failed' ? 207 : 200).json(result);
    } catch (err) {
      if (!sendGigaredError(res, err)) sendUnhandled(res, err, 'addService');
    }
  });

  router.delete('/customers/:id/services/:serviceId', deps.requirePacks, async (req, res): Promise<void> => {
    try {
      const contractId = String(req.query['contractId'] ?? '');
      const result = await deps.removeTvService.execute(req.params['id'] as string, {
        serviceId: req.params['serviceId'] as string,
        contractId,
      });
      res.status(result.local === 'failed' ? 207 : 200).json(result);
    } catch (err) {
      if (!sendGigaredError(res, err)) sendUnhandled(res, err, 'removeService');
    }
  });

  router.put('/customers/:id/ott', deps.requireOtt, async (req, res): Promise<void> => {
    try {
      const enabled = Boolean((req.body as { enabled?: unknown }).enabled);
      await deps.setOttStatus.execute(req.params['id'] as string, enabled);
      res.json({ ok: true });
    } catch (err) {
      if (!sendGigaredError(res, err)) sendUnhandled(res, err, 'ott');
    }
  });

  // #5 BE — TV activation history: global list with optional filters.
  // Wire contract:
  //   GET /api/gigared/customers/activation-history?actorId=&customerId=&from=&to=
  //   → 200 TvActivationEventDto[] (newest first). Gate tv.read.
  // NOTE: this route MUST be registered BEFORE /customers/:id routes to avoid `:id` capturing
  // the literal segment "activation-history" as a customerId.
  router.get('/customers/activation-history', deps.requireRead, async (req, res): Promise<void> => {
    try {
      const q = req.query;
      const filter: {
        actorId?: string;
        customerId?: string;
        from?: Date;
        to?: Date;
      } = {};
      if (typeof q['actorId'] === 'string' && q['actorId'] !== '') filter.actorId = q['actorId'];
      if (typeof q['customerId'] === 'string' && q['customerId'] !== '') filter.customerId = q['customerId'];
      if (typeof q['from'] === 'string' && q['from'] !== '') {
        const d = new Date(q['from']);
        if (!isNaN(d.getTime())) filter.from = d;
      }
      if (typeof q['to'] === 'string' && q['to'] !== '') {
        const d = new Date(q['to']);
        if (!isNaN(d.getTime())) filter.to = d;
      }
      const events = await deps.listActivationHistory.execute(filter);
      res.json(events);
    } catch (err) {
      if (!sendGigaredError(res, err)) sendUnhandled(res, err, 'activation-history:global');
    }
  });

  // #5 BE — TV activation history: per-client list.
  // Wire contract:
  //   GET /api/gigared/customers/:id/activation-history → 200 TvActivationEventDto[] (newest first).
  //   Gate tv.read.
  router.get('/customers/:id/activation-history', deps.requireRead, async (req, res): Promise<void> => {
    try {
      const clientId = req.params['id'] as string;
      const events = await deps.listActivationHistory.executeByClient(clientId);
      res.json(events);
    } catch (err) {
      if (!sendGigaredError(res, err)) sendUnhandled(res, err, 'activation-history:client');
    }
  });

  // #10/#11 — dar de baja TV (async). Body { contractId }. tv.cancel (#50).
  // Wire contract (FROZEN):
  //   202 { status:'pending' }            — job queued, runner fires in background
  //   409 { queued:false, reason:'already-running' } — concurrent run guard
  //   404 CLIENT_NOT_FOUND / CONTRACT_NOT_FOUND   — fast pre-queue checks (no partner call)
  //
  // Pre-queue fast checks: validate customer + contract ownership (DB only, no Gigared call).
  // Concurrent guard: if tvCancelStatus === 'pending' | 'running' → 409.
  // Flow: setStatus('pending') → res 202 → void runner.run() (fire-and-forget).
  // Runner transitions: pending → running → done|failed (writes result to cancelStatus).
  router.post('/customers/:id/cancel', deps.requireCancel, async (req, res): Promise<void> => {
    const customerId = req.params['id'] as string;
    const contractId = String((req.body as { contractId?: unknown }).contractId ?? '');
    try {
      // Fast pre-queue validation: customer existence + contract ownership (no Gigared call).
      // Uses the same lookups injected into CancelTv — errors are consistent.
      const customer = await deps.customerLookup.findById(customerId);
      if (!customer) throw new ClientNotFoundError(customerId);

      const contract = await deps.contractLookup.findById(contractId);
      if (!contract || contract.clientId !== customerId) throw new ContractNotFoundError(contractId);

      // Concurrent guard: pending|running → 409 (re-queue allowed for done|failed)
      const existing = await deps.cancelStatus.getStatus(customerId);
      if (existing?.status === 'pending' || existing?.status === 'running') {
        res.status(409).json({ queued: false, reason: 'already-running' });
        return;
      }

      // Queue: set pending, return 202, fire runner in background.
      // #5 BE — capture actor from req.user BEFORE responding (response clears the req context).
      const cancelActor = req.user ? { actorId: req.user.id, actorName: req.user.username } : undefined;
      await deps.cancelStatus.setStatus(customerId, { status: 'pending' });
      res.status(202).json({ status: 'pending' });
      void deps.cancelTvRunner.run(customerId, contractId, cancelActor);
    } catch (err) {
      if (!sendGigaredError(res, err)) sendUnhandled(res, err, 'cancel');
    }
  });

  // #10/#11 — GET status of the async cancel job for a customer. tv.cancel guard.
  // Wire contract:
  //   200 { status:'pending'|'running'|'done'|'failed', result?: CancelTvResult|{error}, startedAt?: ISO }
  //   404 CLIENT_NOT_FOUND — customer does not exist
  router.get('/customers/:id/cancel/status', deps.requireCancel, async (req, res): Promise<void> => {
    const customerId = req.params['id'] as string;
    try {
      // Validate customer exists
      const customer = await deps.customerLookup.findById(customerId);
      if (!customer) throw new ClientNotFoundError(customerId);

      const row = await deps.cancelStatus.getStatus(customerId);
      if (!row) {
        // No job has been queued yet — report as pending (neutral starting state).
        res.status(200).json({ status: 'pending' });
        return;
      }

      const body: Record<string, unknown> = { status: row.status };
      if (row.startedAt !== undefined) body['startedAt'] = row.startedAt.toISOString();
      if (row.result !== undefined) body['result'] = row.result;
      res.status(200).json(body);
    } catch (err) {
      if (!sendGigaredError(res, err)) sendUnhandled(res, err, 'cancel/status');
    }
  });

  return router;
}
