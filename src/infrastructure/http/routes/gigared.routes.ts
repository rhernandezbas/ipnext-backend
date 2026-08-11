import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import type { GetGigaredConfig } from '@application/use-cases/gigared/GetGigaredConfig';
import type { UpdateGigaredConfig } from '@application/use-cases/gigared/UpdateGigaredConfig';
import type { GetGigaredSummary } from '@application/use-cases/gigared/GetGigaredSummary';
import type { ListGigaredAccounts } from '@application/use-cases/gigared/ListGigaredAccounts';
import type { GetGigaredCustomerAccount } from '@application/use-cases/gigared/GetGigaredCustomerAccount';
import type { LinkCustomerToCic } from '@application/use-cases/gigared/LinkCustomerToCic';
import type { AddTvService } from '@application/use-cases/gigared/AddTvService';
import type { RemoveTvService } from '@application/use-cases/gigared/RemoveTvService';
import type { SetOttStatus } from '@application/use-cases/gigared/SetOttStatus';
import type { CancelTv } from '@application/use-cases/gigared/CancelTv';
import type { TransferTvToCustomer } from '@application/use-cases/gigared/TransferTvToCustomer';
import type { ChangeTvPassword } from '@application/use-cases/gigared/ChangeTvPassword';
import type { GetTvCredentials } from '@application/use-cases/gigared/GetTvCredentials';
import type { ListTvActivationHistory } from '@application/use-cases/gigared/ListTvActivationHistory';
import type { GigaredConfigRepository } from '@domain/ports/GigaredConfigRepository';
import type { FeatureFlagRepository } from '@domain/ports/FeatureFlagRepository';
import type { ListAccountsFilter } from '@domain/ports/GigaredPort';
import type { ClientTvCancelStatusRepository } from '@domain/ports/ClientTvCancelStatusRepository';
import type { ClientTvRegisterStatusRepository } from '@domain/ports/ClientTvRegisterStatusRepository';
import type { CancelTvJobRunner } from '@infrastructure/scheduling/CancelTvJobRunner';
import type { RegisterTvJobRunner } from '@infrastructure/scheduling/RegisterTvJobRunner';
import { isTvRegisterJobActive, TV_REGISTER_JOB_TTL_MS } from '@domain/gigared/tvRegisterJob';
import { deterministicTvPassword, isValidGigaredPassword } from '@infrastructure/security/gigaredPassword';
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
  TvAlreadyLinkedError,
  CicNotFoundError,
  CicAlreadyLinkedError,
  GrClientIdRequiredError,
  GrContractIdRequiredError,
  NoCicAvailableError,
  TvPoolPoisonedError,
  TvIdentityStampUnverifiedError,
  TvEmailOwnedByOtherError,
  TvPoolUnavailableError,
  TvNoUsableCicError,
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
/**
 * gigared-tv-cic-reuse (T3.2) — EXPORTADA para poder testear el mapeo código→status
 * directamente. Es el contrato de wire con el frontend; dejarlo sólo ejercitado de refilón
 * end-to-end fue lo que dejó el branch de `TvPoolPoisonedError` sin test propio.
 */
export function sendGigaredError(res: Response, err: unknown): boolean {
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
  // B1 (D-pool) — el pool unregistered no tiene NINGÚN CIC limpio (todos envenenados por un
  // renewCic previo, #72): condición de DATOS, no transitoria → 422, misma familia que
  // NO_CIC_AVAILABLE. Sin test standalone del branch (ejercitado end-to-end en B3).
  if (err instanceof TvPoolPoisonedError) {
    res.status(422).json({ error: err.message, code: err.code, poisonedCount: err.poisonedCount });
    return true;
  }
  // gigared-tv-cic-reuse — el LISTADO del pool falló contra el partner. Transitorio, no de
  // datos → 503 reintentable. Antes esta llamada no estaba protegida y su NotFound salía
  // como un 404 "Gigared account not found" en pleno ALTA (el bug del 2026-07-30).
  if (err instanceof TvPoolUnavailableError) {
    res.status(503).json({ error: err.message, code: err.code, detail: err.detail });
    return true;
  }
  // gigared-tv-cic-reuse — se agotaron los candidatos del reintento acotado: ningún CIC del
  // pool resultó utilizable. Condición de DATOS → 422, misma familia que TV_POOL_POISONED.
  if (err instanceof TvNoUsableCicError) {
    res.status(422).json({ error: err.message, code: err.code, attemptedCount: err.attemptedCount });
    return true;
  }
  // B1 (D-pool, part 2) — el readback post-stamp no confirmó la identidad recién estampada
  // (append-only: ya resolvía a otro dueño, o 404). El retry se auto-completa vía el recovery
  // de B2 → 503 (transitorio, a diferencia de TV_POOL_POISONED). Sin test standalone (B3).
  if (err instanceof TvIdentityStampUnverifiedError) {
    res.status(503).json({ error: err.message, code: err.code, cic: err.cic, internalId: err.internalId });
    return true;
  }
  if (err instanceof TvNotLinkedError) {
    res.status(404).json({ error: err.message, code: err.code });
    return true;
  }
  // service-transfer — el destino ya tiene TV vigente: transferirle otro CIC crearía un doble
  // vínculo irreversible (mapping append-only del CUA) → 409, espejo de CIC_ALREADY_LINKED.
  if (err instanceof TvAlreadyLinkedError) {
    res.status(409).json({ error: err.message, code: err.code, cic: err.cic });
    return true;
  }
  // B2 (D2) — el email determinístico ya está bindeado a OTRO customer (colisión genuina o
  // huérfano histórico envenenado) — el recovery NUNCA auto-toca esa cuenta. Sin test standalone
  // del branch (ejercitado end-to-end en B3), mismo criterio que B1.
  if (err instanceof TvEmailOwnedByOtherError) {
    res.status(409).json({ error: err.message, code: err.code, email: err.email, ownedByInternalId: err.ownedByInternalId });
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
  // gigared-alta-asincrona (W2) — `registerAccount` YA NO viaja acá: el alta la ejecuta
  // `registerTvRunner` en background y la ruta no invoca al use case. Una dep que el router no lee
  // es cableado muerto, y el cableado muerto es como una feature termina apagada en producción con
  // el CI en verde.
  addTvService: AddTvService;
  removeTvService: RemoveTvService;
  setOttStatus: SetOttStatus;
  cancelTv: CancelTv;
  changeTvPassword: ChangeTvPassword;
  getTvCredentials: GetTvCredentials;
  // service-transfer — transferir la TV (CIC) a otro cliente sin baja (EPIC Titularidad F1).
  transferTv: TransferTvToCustomer;
  requireRead: RequestHandler;
  // #50 — granular TV permissions (replace the generic tv.write guard).
  requireLink: RequestHandler;     // tv.link — vincular/desvincular CIC
  requireRegister: RequestHandler; // tv.register — registrar cuentas nuevas
  requirePacks: RequestHandler;    // tv.packs — agregar/quitar packs
  requireOtt: RequestHandler;      // tv.ott — habilitar/deshabilitar OTT
  requireCancel: RequestHandler;   // tv.cancel — dar de baja TV
  requireTransfer: RequestHandler; // tv.transfer — transferir la TV a otro cliente (service-transfer)
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
  // gigared-alta-asincrona (W2) — deps del ALTA asíncrona
  /** Runner que ejecuta RegisterGigaredAccount en background (fire-and-forget). */
  registerTvRunner: RegisterTvJobRunner;
  /** Repo del estado del job de alta en Client (con watchdog de huérfanos). */
  registerStatus: ClientTvRegisterStatusRepository;
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

  // service-transfer — transferir la TV (CIC) del cliente :id a otro cliente (EPIC Titularidad F1).
  // Body { targetCustomerId, targetContractId, sourceContractId? }. Guard tv.transfer.
  // Wire contract:
  //   200 → alias verificado + severing + slots locales OK
  //   207 → el partner YA transfirió pero severed=false o algún slot local falló (retry direccionado;
  //         la op partner NUNCA se revierte — no hay unlink primitive en el CUA)
  //   400 VALIDATION_ERROR · 404 CLIENT_NOT_FOUND/CONTRACT_NOT_FOUND/TV_NOT_LINKED ·
  //   409 TV_ALREADY_LINKED · 422 GIGARED_REJECTED (el alias no tomó, F0) · 502/503 upstream.
  // Errores por instancia (sendGigaredError) + fallback sendUnhandled: el handler NUNCA cuelga.
  router.post('/customers/:id/transfer-tv', deps.requireTransfer, async (req, res): Promise<void> => {
    try {
      // MEDIUM-B2 — sin body (parser no corrió / content-type ausente) req.body es undefined:
      // debe dar 400 VALIDATION_ERROR, jamás un TypeError → 500.
      const b = (req.body ?? {}) as { targetCustomerId?: unknown; targetContractId?: unknown; sourceContractId?: unknown };
      const targetCustomerId = typeof b.targetCustomerId === 'string' ? b.targetCustomerId : '';
      const targetContractId = typeof b.targetContractId === 'string' ? b.targetContractId : '';
      if (targetCustomerId === '' || targetContractId === '') {
        res.status(400).json({ error: 'targetCustomerId y targetContractId son obligatorios', code: 'VALIDATION_ERROR' });
        return;
      }
      // MEDIUM-3c — sourceContractId presente pero NO string (número, null, objeto…) → 400
      // explícito. Descartarlo en silencio mandaba el transfer-out a un contrato resuelto por
      // heurística sin que el operador se entere de que su input se ignoró.
      if (b.sourceContractId !== undefined && typeof b.sourceContractId !== 'string') {
        res.status(400).json({ error: 'sourceContractId debe ser un string', code: 'VALIDATION_ERROR' });
        return;
      }
      const sourceContractId = typeof b.sourceContractId === 'string' && b.sourceContractId !== '' ? b.sourceContractId : undefined;
      const actor = req.user ? { actorId: req.user.id, actorName: req.user.username } : { actorId: null, actorName: '' };
      const result = await deps.transferTv.execute(req.params['id'] as string, {
        targetCustomerId,
        targetContractId,
        ...(sourceContractId !== undefined ? { sourceContractId } : {}),
        actorId: actor.actorId,
        actorName: actor.actorName,
      });
      // 207 = parcial: el partner ya quedó transferido pero falta severing, el clear del flag
      // del destino (MEDIUM-2) o algún slot local. El retry es el MISMO POST (modo resume).
      const partial = !result.severed || !result.targetCleared
        || result.localSource === 'failed' || result.localTarget === 'failed';
      res.status(partial ? 207 : 200).json(result);
    } catch (err) {
      if (!sendGigaredError(res, err)) sendUnhandled(res, err, 'transfer-tv');
    }
  });

  // gigared-alta-asincrona (W2) — el ALTA de TV es ASÍNCRONA.
  //
  // Contrato de cable (FROZEN):
  //   202 { jobId, status:'pending' }                — job encolado, el runner corre en background
  //   409 { queued:false, reason:'already-running' } — ya hay un alta VIVA para este cliente
  //   400 VALIDATION_ERROR / 404 CLIENT|CONTRACT_NOT_FOUND / 422 GR_CONTRACT_ID_REQUIRED
  //       — chequeos locales, TODOS antes de encolar
  //
  // POR QUÉ dejó de ser síncrona: un alta hace hasta 17 llamadas al partner, que corta a ~10 req
  // por ventana de 60 s (medido en vivo el 2026-08-10; no manda Retry-After ni X-RateLimit-*). Con
  // un throttle honesto el alta tarda 114 s en vacío y 361 s con apenas 6 req/min de tráfico de
  // fondo — por encima del `requestTimeout` de 300 s de Node. Cuando ese timeout corta el socket el
  // handler sigue vivo, el operador ve un error y reintenta → segundo `register` → activación
  // pendiente en Gigared → cliente quemado PARA SIEMPRE (Calabria, Abello, Aceste).
  //
  // El `jobId` ES el customerId: el estado se direcciona por cliente
  // (GET /customers/:id/register/status) y hay a lo sumo un alta viva por cliente. Devolver un uuid
  // que ningún endpoint acepta sería una afordancia falsa.
  router.post('/customers/:id/register', deps.requireRegister, async (req, res): Promise<void> => {
    const customerId = req.params['id'] as string;
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

      // W2.2 — TODA validación que se resuelve SIN tocar al partner corre ANTES del 202. Un input
      // inválido tiene que seguir siendo un error inmediato y no un job que falla tres minutos
      // después: el operador no puede corregir un contractId ajeno mirando un spinner.
      //
      // Se llaman las MISMAS funciones que usa el use case (mismos lookups, mismo
      // deterministicTvPassword/isValidGigaredPassword): la regla no se reimplementa acá, sólo se
      // adelanta el call-site. El use case las vuelve a evaluar dentro del job — es su contrato y
      // no se toca.
      const customer = await deps.customerLookup.findById(customerId);
      if (!customer) throw new ClientNotFoundError(customerId);

      const contract = await deps.contractLookup.findById(contractId);
      if (!contract || contract.clientId !== customerId) throw new ContractNotFoundError(contractId);

      const grContratoId = contract.grContratoId;
      if (grContratoId == null || grContratoId === '' || !isValidGigaredPassword(deterministicTvPassword(grContratoId))) {
        throw new GrContractIdRequiredError(contractId);
      }

      // W2.3 — guard anti-doble-disparo. Es una RESERVA ATÓMICA, no un `getStatus` + `setStatus`:
      // entre esas dos llamadas hay un yield del event loop y ahí entra el segundo request. Con UNA
      // sola réplica, un doble click en el botón produce DOS `register` REALES contra el partner ⇒
      // dos activaciones pendientes ⇒ cliente quemado PARA SIEMPRE (Calabria, Abello, Aceste).
      // El port lo resuelve con un `UPDATE … WHERE` condicional del que se ramifica por el count.
      //
      // La condición incluye el WATCHDOG: un job pending/running que dejó de dar señales de vida
      // expira y deja de bloquear. Sin eso, un deploy en el momento equivocado deja al cliente sin
      // poder operar hasta que alguien edite la DB a mano — el agujero abierto de CancelTvJobRunner,
      // que este change no hereda.
      //
      // El sello vale DOS cosas: es el ancla del watchdog y es el FENCE TOKEN que el runner tiene
      // que presentar para escribir el desenlace.
      const reservadoEn = new Date();
      const reservado = await deps.registerStatus.tryReserve(customerId, reservadoEn, TV_REGISTER_JOB_TTL_MS);
      if (!reservado) {
        res.status(409).json({ queued: false, reason: 'already-running' });
        return;
      }

      // #5 BE — el actor se captura ANTES de responder (el response limpia el contexto del req).
      const actor = req.user ? { actorId: req.user.id, actorName: req.user.username } : { actorId: null, actorName: '' };
      res.status(202).json({ jobId: customerId, status: 'pending' });
      void deps.registerTvRunner.run(
        customerId,
        {
          firstName: b.firstName,
          lastName: b.lastName,
          email: b.email,
          sendActivationEmail: b.sendActivationEmail ?? false,
          contractId,
        },
        reservadoEn,
        actor,
      );
    } catch (err) {
      if (!sendGigaredError(res, err)) sendUnhandled(res, err, 'register');
    }
  });

  // gigared-alta-asincrona (W2.4) — estado del alta para el polling del FE. MISMO permiso que el
  // alta (tv.register): quien puede disparar el job puede ver cómo terminó.
  //
  //   200 { status, message, startedAt?, result? }
  //   404 CLIENT_NOT_FOUND
  //
  // `status` en el cable tiene DOS valores que no están en la columna:
  //   - 'idle'    — nunca se encoló un alta. El molde del cancel devuelve 'pending' acá, y eso hace
  //                 girar al FE sobre un job que no existe.
  //   - 'expired' — la fila dice pending/running pero el watchdog ya lo dio por muerto. Reportar
  //                 'running' sobre un proceso caído dejaría al FE girando para siempre: el mismo
  //                 bug que el watchdog arregla, mudado a la ventana del polling.
  router.get('/customers/:id/register/status', deps.requireRegister, async (req, res): Promise<void> => {
    const customerId = req.params['id'] as string;
    try {
      const customer = await deps.customerLookup.findById(customerId);
      if (!customer) throw new ClientNotFoundError(customerId);

      const row = await deps.registerStatus.getStatus(customerId);
      if (!row) {
        res.status(200).json({ status: 'idle', message: null });
        return;
      }

      const vivo = isTvRegisterJobActive(row, new Date());
      const expirado = !vivo && (row.status === 'pending' || row.status === 'running');
      const status = expirado ? 'expired' : row.status;

      // La decisión de producto es que el operador ve el error y ya, así que el mensaje del partner
      // viaja TAL CUAL: aplastarlo en un genérico le sacaría la única información con la que puede
      // decidir si reintenta o llama a Gigared.
      const errorDelJob = (row.result as { error?: string } | undefined)?.error;
      // El `code` sube al top-level: es lo que el FE usa para ramificar (TV_POOL_POISONED pide
      // llamar al admin; TV_IDENTITY_UNVERIFIED se reintenta). Cuando el alta era síncrona llegaba
      // por HTTP; enterrarlo dentro de `result` sería degradarlo en silencio.
      const codeDelJob = (row.result as { code?: string } | undefined)?.code;
      const message =
        status === 'failed'  ? (errorDelJob ?? 'El alta falló.')
        : status === 'expired' ? 'El alta se interrumpió antes de terminar. Podés reintentarla.'
        : status === 'done'    ? 'El alta se completó.'
        : status === 'running' ? 'El alta está en curso.'
        :                        'El alta está en cola.';

      const body: Record<string, unknown> = { status, message };
      if (status === 'failed' && codeDelJob !== undefined) body['code'] = codeDelJob;
      if (row.startedAt !== undefined) body['startedAt'] = row.startedAt.toISOString();
      if (row.result !== undefined) body['result'] = row.result;
      res.status(200).json(body);
    } catch (err) {
      if (!sendGigaredError(res, err)) sendUnhandled(res, err, 'register/status');
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
      // #131 PARTE B -- thread actor so reconcile can record 'reactivacion' best-effort.
      const addActor = req.user ? { actorId: req.user.id, actorName: req.user.username } : { actorId: null, actorName: '' };
      const result = await deps.addTvService.execute(req.params['id'] as string, {
        serviceId: b.serviceId,
        contractId: b.contractId,
        actorId:   addActor.actorId,
        actorName: addActor.actorName,
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
    const cancelReason = typeof (req.body as { reason?: unknown }).reason === 'string' ? (req.body as { reason: string }).reason : undefined;
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
      void deps.cancelTvRunner.run(customerId, contractId, cancelActor, cancelReason);
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
