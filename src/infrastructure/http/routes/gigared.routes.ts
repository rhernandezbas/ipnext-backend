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
import type { GigaredConfigRepository } from '@domain/ports/GigaredConfigRepository';
import type { FeatureFlagRepository } from '@domain/ports/FeatureFlagRepository';
import type { ListAccountsFilter } from '@domain/ports/GigaredPort';
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
}

/**
 * Gigared TV router (#47). Mount: app.use('/api/gigared', createAuthMiddleware(...), router).
 * Order (D2): /config (GET/PUT, tv.manage) → router.use(gigaredReady) → the rest (read + granular ops #50).
 * Errors are caught BY INSTANCE here so each maps to its pinned status (pattern uisp.routes.ts).
 */
export function createGigaredRouter(deps: GigaredRouterDeps): Router {
  const router = Router();

  // ---- /config — always accessible (no gigaredReady gate) ------------------
  router.get('/config', deps.requireManage, async (_req, res, next): Promise<void> => {
    try {
      res.json(await deps.getConfig.execute());
    } catch (err) {
      if (!sendGigaredError(res, err)) next(err);
    }
  });

  router.put('/config', deps.requireManage, async (req, res, next): Promise<void> => {
    const parsed = updateGigaredConfigSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid config payload', code: 'VALIDATION_ERROR' });
      return;
    }
    try {
      res.json(await deps.updateConfig.execute(parsed.data));
    } catch (err) {
      if (!sendGigaredError(res, err)) next(err);
    }
  });

  // ---- probe: GET /summary — key required, flag EXEMPT (M1) -----------------
  // Lets the operator validate the API key with the flag OFF ("test connection").
  router.get('/summary', deps.gigaredProbeReady, deps.requireRead, async (_req, res, next): Promise<void> => {
    try {
      res.json(await deps.getSummary.execute());
    } catch (err) {
      if (!sendGigaredError(res, err)) next(err);
    }
  });

  // ---- everything below requires the integration to be fully ready (key + flag) ----
  router.use(deps.gigaredReady);

  router.get('/accounts', deps.requireRead, async (req, res, next): Promise<void> => {
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
      if (!sendGigaredError(res, err)) next(err);
    }
  });

  router.get('/customers/:id/account', deps.requireRead, async (req, res, next): Promise<void> => {
    try {
      res.json(await deps.getCustomerAccount.execute(req.params['id'] as string));
    } catch (err) {
      if (!sendGigaredError(res, err)) next(err);
    }
  });

  router.post('/customers/:id/link', deps.requireLink, async (req, res, next): Promise<void> => {
    try {
      const body = req.body as { cic?: unknown; contractId?: unknown };
      const cic = String(body.cic ?? '');
      // contractId optional (47f): present → reconcile the local TV slot in that contract.
      const contractId = typeof body.contractId === 'string' && body.contractId !== '' ? body.contractId : undefined;
      const result = await deps.linkCustomerToCic.execute(req.params['id'] as string, cic, contractId);
      // local:'failed' mirrors AddTvService → 207 (link kept, retry = re-POST). Else 200.
      res.status(result.local === 'failed' ? 207 : 200).json(result);
    } catch (err) {
      if (!sendGigaredError(res, err)) next(err);
    }
  });

  router.post('/customers/:id/register', deps.requireRegister, async (req, res, next): Promise<void> => {
    try {
      const b = req.body as {
        firstName: string; lastName: string; email: string; cic: string;
        password?: unknown; sendActivationEmail?: boolean; contractId?: unknown;
      };
      // #70 rework — el body YA NO acepta password. Se genera SERVER-SIDE en el use case a partir
      // del grClienteId del cliente (helper determinístico `ip{grClienteId}` padded del #65). Si el
      // FE viejo todavía manda `password`, se IGNORA acá con un strip silencioso (tolerancia durante
      // la ventana de deploy: no rompemos su request, solo no la usamos). Sin grClienteId el use case
      // sube GrClientIdRequiredError → 422 GR_CLIENT_ID_REQUIRED.
      void b.password; // descartada a propósito: no se lee ni se reenvía a Gigared.
      // #65 — el correo del alta es ficticio: el checkbox de activación viene SIEMPRE inactivo
      // por default (no se envía email). El operador puede forzarlo a true explícitamente.
      const contractId =
        typeof b.contractId === 'string' && b.contractId !== '' ? b.contractId : undefined;
      const account = await deps.registerAccount.execute(req.params['id'] as string, {
        firstName: b.firstName,
        lastName: b.lastName,
        email: b.email,
        cic: b.cic,
        sendActivationEmail: b.sendActivationEmail ?? false,
        ...(contractId ? { contractId } : {}),
      });
      res.status(201).json(account);
    } catch (err) {
      if (!sendGigaredError(res, err)) next(err);
    }
  });

  // #65 — cambiar la contraseña de la cuenta de TV. Body { contractId, password }.
  // #65 fix wave H1 (SEGURIDAD): el `cic` NO viaja en el body — un operador no puede targetear
  // la cuenta de OTRO cliente. El use case resuelve la cuenta del cliente por use_internal_id y
  // usa SU cic (cuenta sin vincular → 404 TV_NOT_LINKED). Guard tv.register. El use case valida
  // CUA antes de tocar Gigared (400 VALIDATION_ERROR); un rechazo del partner sube RFC 9457 (#47g).
  router.post('/customers/:id/tv-password', deps.requireRegister, async (req, res, next): Promise<void> => {
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
      if (!sendGigaredError(res, err)) next(err);
    }
  });

  // #65 fix wave H3 (SEGURIDAD) — superficie dedicada para las credenciales de Gigared Play.
  // Reemplaza la fuga donde tvPassword salía por GET /:id/contracts y por los responses de
  // add/update service. Guard tv.register (mismo que el cambio de password). Sin fila TV → 404.
  router.get('/customers/:id/tv-credentials', deps.requireRegister, async (req, res, next): Promise<void> => {
    try {
      const result = await deps.getTvCredentials.execute(req.params['id'] as string);
      res.json(result);
    } catch (err) {
      if (!sendGigaredError(res, err)) next(err);
    }
  });

  router.post('/customers/:id/services', deps.requirePacks, async (req, res, next): Promise<void> => {
    try {
      const b = req.body as { serviceId: string; contractId: string };
      const result = await deps.addTvService.execute(req.params['id'] as string, {
        serviceId: b.serviceId,
        contractId: b.contractId,
      });
      res.status(result.local === 'failed' ? 207 : 200).json(result);
    } catch (err) {
      if (!sendGigaredError(res, err)) next(err);
    }
  });

  router.delete('/customers/:id/services/:serviceId', deps.requirePacks, async (req, res, next): Promise<void> => {
    try {
      const contractId = String(req.query['contractId'] ?? '');
      const result = await deps.removeTvService.execute(req.params['id'] as string, {
        serviceId: req.params['serviceId'] as string,
        contractId,
      });
      res.status(result.local === 'failed' ? 207 : 200).json(result);
    } catch (err) {
      if (!sendGigaredError(res, err)) next(err);
    }
  });

  router.put('/customers/:id/ott', deps.requireOtt, async (req, res, next): Promise<void> => {
    try {
      const enabled = Boolean((req.body as { enabled?: unknown }).enabled);
      await deps.setOttStatus.execute(req.params['id'] as string, enabled);
      res.json({ ok: true });
    } catch (err) {
      if (!sendGigaredError(res, err)) next(err);
    }
  });

  // #47k / #64 / #72 — dar de baja TV completa. Body { contractId }. tv.cancel (#50).
  // 200 si todo OK; 207 si algún paso falló — retry idempotente.
  // Criterio 207:
  //   - failed.length > 0: al menos un DELETE de pack falló
  //   - local === 'failed': el reconcile local no pudo sincronizar
  //   - !ottDisabled: el OTT disable falló (falla REAL; el adapter ya absorbe "ya deshabilitada" como éxito)
  //   - renewAttempted && renew === null: había algo que renovar pero el renew (best-effort) falló
  //     Cuando renewAttempted=false (cuenta ya pelada), se omite este check → evita 207 permanente.
  //   #72: `unlinked` ya no existe — el partner no tiene primitive de unlink (HTTP 400 siempre).
  //   El estado "sin TV" se persiste localmente (Client.tvCancelledAt). No factoriza en el 207.
  router.post('/customers/:id/cancel', deps.requireCancel, async (req, res, next): Promise<void> => {
    try {
      const contractId = String((req.body as { contractId?: unknown }).contractId ?? '');
      const result = await deps.cancelTv.execute(req.params['id'] as string, { contractId });
      const partial =
        result.failed.length > 0 ||
        result.local === 'failed' ||
        !result.ottDisabled ||
        (result.renewAttempted && result.renew === null);
      res.status(partial ? 207 : 200).json(result);
    } catch (err) {
      if (!sendGigaredError(res, err)) next(err);
    }
  });

  return router;
}
