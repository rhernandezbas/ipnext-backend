import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { PortalLogin } from '@application/use-cases/portal/PortalLogin';
import { RefreshPortalSession } from '@application/use-cases/portal/RefreshPortalSession';
import { LogoutPortal } from '@application/use-cases/portal/LogoutPortal';
import { ChangePortalPassword } from '@application/use-cases/portal/ChangePortalPassword';
import { GetPortalMe } from '@application/use-cases/portal/GetPortalMe';
import { ListPortalInvoices } from '@application/use-cases/portal/ListPortalInvoices';
import { ListPortalPlans } from '@application/use-cases/portal/ListPortalPlans';
import { ListPortalTasks } from '@application/use-cases/portal/ListPortalTasks';
import { ListPortalTickets } from '@application/use-cases/portal/ListPortalTickets';
import { GetPortalTicket } from '@application/use-cases/portal/GetPortalTicket';
import { CreatePortalTicket } from '@application/use-cases/portal/CreatePortalTicket';
import { ListPortalTicketTopics } from '@application/use-cases/portal/ListPortalTicketTopics';
import { DeleteMyPortalAccount } from '@application/use-cases/portal/DeleteMyPortalAccount';
import { ListPortalTicketMessages } from '@application/use-cases/portal/ListPortalTicketMessages';
import { SendPortalTicketMessage } from '@application/use-cases/portal/SendPortalTicketMessage';
import { GetPortalTicketMessageAttachmentFile } from '@application/use-cases/portal/GetPortalTicketMessageAttachmentFile';
import { SendPortalTicketMessageSchema } from '@application/dto/portal/portalTicketMessage.dto';
import { ListPortalPromos } from '@application/use-cases/portal/ListPortalPromos';
import { GetPortalPromo } from '@application/use-cases/portal/GetPortalPromo';
import { InterestInPortalPromo } from '@application/use-cases/portal/InterestInPortalPromo';
import { DismissPortalPromo } from '@application/use-cases/portal/DismissPortalPromo';
import { ListPortalBenefits } from '@application/use-cases/portal/ListPortalBenefits';
import { RegisterPortalPushToken } from '@application/use-cases/portal/RegisterPortalPushToken';
import { UnregisterPortalPushToken } from '@application/use-cases/portal/UnregisterPortalPushToken';
import { GetPortalPushPreferences } from '@application/use-cases/portal/GetPortalPushPreferences';
import { UpdatePortalPushPreferences } from '@application/use-cases/portal/UpdatePortalPushPreferences';
import { RegisterPortalPushTokenSchema, UnregisterPortalPushTokenSchema, UpdatePortalPushPreferencesSchema } from '@application/dto/portal/portalPush.dto';
import { ListPortalNotifications } from '@application/use-cases/portal/ListPortalNotifications';
import { GetPortalNotificationsUnreadCount } from '@application/use-cases/portal/GetPortalNotificationsUnreadCount';
import { MarkPortalNotificationsRead } from '@application/use-cases/portal/MarkPortalNotificationsRead';
import { MarkAllPortalNotificationsRead } from '@application/use-cases/portal/MarkAllPortalNotificationsRead';
import { MarkPortalNotificationsReadSchema } from '@application/dto/portal/portalNotification.dto';
import {
  InvalidPortalCredentialsError,
  InvalidPortalRefreshTokenError,
  PortalRefreshTokenReusedError,
  InvalidCurrentPortalPasswordError,
  PortalPasswordTooShortError,
  PortalAccountNotFoundError,
  PortalTicketValidationError,
  PortalContractRequiredError,
  PortalContractNotFoundError,
  PortalTicketTopicNotFoundError,
} from '@domain/errors/portal.errors';
import { WifiContractNotFoundError, WifiNotEligibleError, WifiValidationError } from '@domain/errors/wifi';
import { EquipmentContractNotFoundError, EquipmentNotEligibleError } from '@domain/errors/equipment';
import {
  createPortalLoginRateLimiter,
  createPortalLoginIpRateLimiter,
  createPortalGeneralRateLimiter,
  createPortalTicketCreateRateLimiter,
  createPortalTicketMessageSendRateLimiter,
  createPortalWifiUpdateRateLimiter,
  createPortalEquipmentRebootRateLimiter,
} from '../middleware/rateLimiters';
import { parsePagination } from '../parsePagination';
import { createTicketMessageUploadMiddleware } from './ticketMessageUpload';
import { GetPortalWifiStatus } from '@application/use-cases/wifi/GetPortalWifiStatus';
import { UpdatePortalWifiBand } from '@application/use-cases/wifi/UpdatePortalWifiBand';
import { ListPortalWifiDevices } from '@application/use-cases/wifi/ListPortalWifiDevices';
import { UpdatePortalWifiBandSchema } from '@application/dto/wifi.dto';
import { GetPortalEquipmentStatus } from '@application/use-cases/equipment/GetPortalEquipmentStatus';
import { RebootPortalEquipment } from '@application/use-cases/equipment/RebootPortalEquipment';

/** Content-Disposition inline seguro (RFC 5987) — molde `newsMedia.routes.ts`. */
function contentDisposition(filename: string): string {
  const asciiFallback = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  return `inline; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export interface PortalRouterDeps {
  portalLogin: PortalLogin;
  refreshPortalSession: RefreshPortalSession;
  logoutPortal: LogoutPortal;
  changePortalPassword: ChangePortalPassword;
  /** `createPortalAuthMiddleware(tokenService, accounts)` — guards `/auth/change-password` only. */
  portalAuthMiddleware: RequestHandler;
  /** `createPortalKillSwitchMiddleware(settingsRepo)` — applied to the WHOLE router, login included. */
  killSwitch: RequestHandler;
  /** Defaults to `createPortalLoginRateLimiter()` when omitted. */
  loginRateLimiter?: RequestHandler;
  /** H3b (fix wave) — per-IP ceiling for `/auth/login`, mounted IN ADDITION to
   * the (IP+dni) limiter (a dni-rotating sweep otherwise gets a fresh bucket
   * per attempt). Defaults to `createPortalLoginIpRateLimiter()` when omitted. */
  loginIpRateLimiter?: RequestHandler;
  /** Defaults to `createPortalGeneralRateLimiter()` when omitted. */
  generalRateLimiter?: RequestHandler;

  // ── Fase 4/5/6 (self-service + borrado) — TODOS opcionales: cuando faltan,
  // la ruta correspondiente simplemente no se monta (back-compat con el wiring
  // de F2, que solo pasa los deps de auth). Fase 7 los inyecta desde app.ts.
  getPortalMe?: GetPortalMe;
  listPortalInvoices?: ListPortalInvoices;
  listPortalPlans?: ListPortalPlans;
  listPortalTasks?: ListPortalTasks;
  listPortalTickets?: ListPortalTickets;
  getPortalTicket?: GetPortalTicket;
  createPortalTicket?: CreatePortalTicket;
  /** portal-ticket-topic — `GET /ticket-topics`, el catálogo que alimenta el selector de `POST /tickets`. */
  listPortalTicketTopics?: ListPortalTicketTopics;
  deleteMyPortalAccount?: DeleteMyPortalAccount;
  /** Defaults to `createPortalTicketCreateRateLimiter()` when omitted. Applied
   * ONLY to `POST /tickets`, on top of `generalRateLimiter`. */
  ticketCreateRateLimiter?: RequestHandler;

  // ── portal-ticket-messaging (v2.B) — mensajería interna de un reclamo ──────
  listPortalTicketMessages?: ListPortalTicketMessages;
  sendPortalTicketMessage?: SendPortalTicketMessage;
  getPortalTicketMessageAttachmentFile?: GetPortalTicketMessageAttachmentFile;
  /** Defaults to `createPortalTicketMessageSendRateLimiter()` when omitted.
   * Applied ONLY a `POST /tickets/:number/messages`, además de `generalRateLimiter`. */
  ticketMessageSendRateLimiter?: RequestHandler;

  // ── portal-promos — promociones en la app de clientes ──────────────────────
  listPortalPromos?: ListPortalPromos;
  getPortalPromo?: GetPortalPromo;
  interestInPortalPromo?: InterestInPortalPromo;
  dismissPortalPromo?: DismissPortalPromo;

  // ── portal-benefits — pestaña Catálogo (Disponibles/Activados) ─────────────
  listPortalBenefits?: ListPortalBenefits;

  // ── portal-push-notifications — registro de dispositivos + preferencias ────
  registerPortalPushToken?: RegisterPortalPushToken;
  unregisterPortalPushToken?: UnregisterPortalPushToken;
  getPortalPushPreferences?: GetPortalPushPreferences;
  updatePortalPushPreferences?: UpdatePortalPushPreferences;

  // ── portal-notification-inbox — buzón de avisos (respaldo del push) ────────
  listPortalNotifications?: ListPortalNotifications;
  getPortalNotificationsUnreadCount?: GetPortalNotificationsUnreadCount;
  markPortalNotificationsRead?: MarkPortalNotificationsRead;
  markAllPortalNotificationsRead?: MarkAllPortalNotificationsRead;

  // ── wifi-self-service (F0) — "Mi WiFi": elegibilidad + cambio de SSID/pass ──
  getPortalWifiStatus?: GetPortalWifiStatus;
  updatePortalWifiBand?: UpdatePortalWifiBand;
  listPortalWifiDevices?: ListPortalWifiDevices;
  /** Defaults to `createPortalWifiUpdateRateLimiter()` when omitted. Applied
   * ONLY to `PUT /wifi/:contractId` — cada escritura reinicia la radio. */
  wifiUpdateRateLimiter?: RequestHandler;

  // ── portal-equipment-reboot — "Reiniciar mi equipo" (extiende wifi-self-service) ──
  getPortalEquipmentStatus?: GetPortalEquipmentStatus;
  rebootPortalEquipment?: RebootPortalEquipment;
  /** Defaults to `createPortalEquipmentRebootRateLimiter()` when omitted (2/hora
   * por cuenta). Applied ONLY to `POST /equipment/:contractId/reboot` — cada
   * reinicio corta el servicio ~2 minutos. */
  equipmentRebootRateLimiter?: RequestHandler;
}

/**
 * portal.routes — customer-portal-api (Fase 2, task 2.6).
 *
 * `/api/portal/auth/{login,refresh,logout,change-password}`.
 *
 * Mount order per route (DEVIATION from design.md §4's literal "kill-switch → rate
 * limit → auth" for the ONE authenticated route on this router):
 *   - `/auth/login`:            killSwitch → loginIpRateLimiter (IP sola, H3b) → loginRateLimiter (IP+dni) → handler
 *   - `/auth/refresh`:          killSwitch → generalRateLimiter (IP, no account yet) → handler
 *   - `/auth/logout`:           killSwitch → generalRateLimiter (IP, no account yet) → handler
 *   - `/auth/change-password`:  killSwitch → portalAuthMiddleware → generalRateLimiter (BY ACCOUNT) → handler
 *
 * The design doc's "rate limit before auth" phrasing describes the GENERAL shape;
 * `change-password` is the only endpoint on this router that's authenticated, and
 * the general limiter is explicitly required to be "por cuenta" (portal-auth spec
 * "Rate limiting del login") — that's only possible once `portalAuthMiddleware` has
 * resolved `req.portalAccountId`. Putting auth first here does not weaken anything:
 * `createPortalGeneralRateLimiter`'s keyGenerator ALSO falls back to IP when no
 * account is set, so mounting it before OR after auth is always safe — this order
 * is simply the one that actually delivers per-account keying where the spec asks
 * for it.
 */
export function createPortalRouter(deps: PortalRouterDeps): Router {
  const router = Router();
  const loginRateLimiter = deps.loginRateLimiter ?? createPortalLoginRateLimiter();
  const loginIpRateLimiter = deps.loginIpRateLimiter ?? createPortalLoginIpRateLimiter();
  const generalRateLimiter = deps.generalRateLimiter ?? createPortalGeneralRateLimiter();

  // portal-auth spec "Kill-switch global del portal": in front of EVERY route on
  // this router, login included — a disabled portal must 503 before credentials
  // are ever evaluated.
  router.use(deps.killSwitch);

  // H3b — orden: primero el techo por IP (barato, corta el barrido de DNIs),
  // después el (IP+dni) que protege a cada cuenta puntual.
  router.post('/auth/login', loginIpRateLimiter, loginRateLimiter, async (req: Request, res: Response): Promise<void> => {
    const { dni, password } = (req.body ?? {}) as { dni?: unknown; password?: unknown };
    if (typeof dni !== 'string' || !dni || typeof password !== 'string' || !password) {
      res.status(400).json({ error: 'dni y password son requeridos', code: 'VALIDATION_ERROR' });
      return;
    }
    try {
      const result = await deps.portalLogin.execute({ dni, password });
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof InvalidPortalCredentialsError) {
        res.status(401).json({ error: err.message, code: err.code });
      } else {
        // L6 (fix wave): loguear SIEMPRE antes del 500 — sin esto un bug de
        // Prisma en prod era invisible (el catch se tragaba el error).
        console.error('[portal] unexpected error on POST /auth/login', err);
        res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
      }
    }
  });

  router.post('/auth/refresh', generalRateLimiter, async (req: Request, res: Response): Promise<void> => {
    const { refreshToken } = (req.body ?? {}) as { refreshToken?: unknown };
    if (typeof refreshToken !== 'string' || !refreshToken) {
      res.status(400).json({ error: 'refreshToken es requerido', code: 'VALIDATION_ERROR' });
      return;
    }
    try {
      const result = await deps.refreshPortalSession.execute(refreshToken);
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof PortalRefreshTokenReusedError || err instanceof InvalidPortalRefreshTokenError) {
        // L3 (fix wave): body GENERICO E IDENTICO para reusado/invalido/expirado
        // — el code distinto de PortalRefreshTokenReusedError confirmaba a un
        // atacante que su token robado FUE valido (y que ya gatillo la
        // revocacion masiva). La distincion queda solo server-side:
        if (err instanceof PortalRefreshTokenReusedError) {
          console.warn('[portal] refresh token reuse detected — all sessions of the account were revoked');
        }
        res.status(401).json({ error: 'Refresh token inválido o expirado', code: 'INVALID_PORTAL_REFRESH_TOKEN' });
      } else {
        // L6 (fix wave): loguear SIEMPRE antes del 500 (ver /auth/login).
        console.error('[portal] unexpected error on POST /auth/refresh', err);
        res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
      }
    }
  });

  router.post('/auth/logout', generalRateLimiter, async (req: Request, res: Response): Promise<void> => {
    const { refreshToken, pushToken } = (req.body ?? {}) as { refreshToken?: unknown; pushToken?: unknown };
    if (typeof refreshToken === 'string' && refreshToken) {
      try {
        // portal-push-notifications — `pushToken` OPCIONAL: la app lo manda
        // cuando quiere desregistrar SU token de este dispositivo en el MISMO
        // viaje que el logout (ver el docblock de `LogoutPortal.execute`).
        await deps.logoutPortal.execute(refreshToken, typeof pushToken === 'string' && pushToken ? pushToken : undefined);
      } catch {
        // best-effort — logout must never fail loudly on an already-dead token.
      }
    }
    res.status(204).send();
  });

  router.post(
    '/auth/change-password',
    deps.portalAuthMiddleware,
    generalRateLimiter,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      const { currentPassword, newPassword } = (req.body ?? {}) as { currentPassword?: unknown; newPassword?: unknown };
      if (typeof currentPassword !== 'string' || !currentPassword || typeof newPassword !== 'string' || !newPassword) {
        res.status(400).json({ error: 'currentPassword y newPassword son requeridos', code: 'VALIDATION_ERROR' });
        return;
      }
      const accountId = req.portalAccountId;
      if (!accountId) {
        // Defensive — portalAuthMiddleware always sets this before calling next().
        res.status(401).json({ error: 'Authentication required', code: 'UNAUTHORIZED' });
        return;
      }
      try {
        await deps.changePortalPassword.execute({ accountId, currentPassword, newPassword });
        res.status(200).json({ ok: true });
      } catch (err) {
        if (err instanceof InvalidCurrentPortalPasswordError) {
          res.status(401).json({ error: err.message, code: err.code });
        } else if (err instanceof PortalPasswordTooShortError) {
          res.status(400).json({ error: err.message, code: err.code });
        } else if (err instanceof PortalAccountNotFoundError) {
          res.status(404).json({ error: err.message, code: err.code });
        } else {
          next(err);
        }
      }
    },
  );

  // ── Fase 4/5/6 — self-service + borrado de cuenta ──────────────────────────
  // Todas detrás de killSwitch (router.use de arriba) + portalAuthMiddleware +
  // generalRateLimiter (por cuenta) — mismo orden que /auth/change-password.
  // `req.portalClientId` es la ÚNICA fuente del clientId (anti-IDOR
  // estructural, portal-self-service spec "Anclaje al cliente del token") —
  // ningún handler de acá abajo lee un clientId de params/query/body.

  const ticketCreateRateLimiter = deps.ticketCreateRateLimiter ?? createPortalTicketCreateRateLimiter();
  const ticketMessageSendRateLimiter = deps.ticketMessageSendRateLimiter ?? createPortalTicketMessageSendRateLimiter();
  const uploadTicketMessageFiles = createTicketMessageUploadMiddleware();
  const wifiUpdateRateLimiter = deps.wifiUpdateRateLimiter ?? createPortalWifiUpdateRateLimiter();
  const equipmentRebootRateLimiter = deps.equipmentRebootRateLimiter ?? createPortalEquipmentRebootRateLimiter();

  /**
   * F7 (fix wave, v2.B) — `ListPortalTickets.toDto` hace UN `countUnread` por
   * ticket (N+1 deliberado, ver el docblock de ese use case): con el cap
   * general del portal (`MAX_PAGE_LIMIT=100`, parsePagination.ts) un
   * pull-to-refresh podía disparar hasta 100 COUNT por request. En vez de
   * agregar una query `group by` al port SOLO para esta ruta ahora mismo, se
   * elige bajar el techo EFECTIVO de esta ruta puntual a 25 (el mismo valor
   * que ya es el default de página) — un cliente de "mis tickets" rara vez
   * tiene más que un puñado de reclamos abiertos; si necesita más, pagina por
   * `page`. `/invoices` y el resto de las rutas paginadas del portal siguen
   * en el cap general de 100 (no hacen N+1).
   */
  const PORTAL_TICKETS_LIST_MAX_LIMIT = 25;

  function requireClientId(req: Request, res: Response): string | undefined {
    const clientId = req.portalClientId;
    if (!clientId) {
      // Defensivo — portalAuthMiddleware siempre lo setea antes de next().
      res.status(401).json({ error: 'Authentication required', code: 'UNAUTHORIZED' });
      return undefined;
    }
    return clientId;
  }

  if (deps.getPortalMe) {
    const getPortalMe = deps.getPortalMe;
    router.get(
      '/me',
      deps.portalAuthMiddleware,
      generalRateLimiter,
      async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const clientId = requireClientId(req, res);
        if (!clientId) return;
        try {
          const result = await getPortalMe.execute(clientId);
          res.status(200).json(result);
        } catch (err) {
          next(err);
        }
      },
    );
  }

  if (deps.listPortalInvoices) {
    const listPortalInvoices = deps.listPortalInvoices;
    router.get(
      '/invoices',
      deps.portalAuthMiddleware,
      generalRateLimiter,
      async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const clientId = requireClientId(req, res);
        if (!clientId) return;
        try {
          // M2 — parseo estricto compartido (entero >=1, cap 100): basura => default.
          const { page, limit } = parsePagination(req.query);
          const result = await listPortalInvoices.execute(clientId, { page, limit });
          res.status(200).json(result);
        } catch (err) {
          next(err);
        }
      },
    );
  }

  if (deps.listPortalPlans) {
    const listPortalPlans = deps.listPortalPlans;
    router.get(
      '/plans',
      deps.portalAuthMiddleware,
      generalRateLimiter,
      async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const clientId = requireClientId(req, res);
        if (!clientId) return;
        try {
          const result = await listPortalPlans.execute(clientId);
          // M6 — contrato de envelope unificado: TODAS las colecciones del
          // portal viajan como {data: [...]} (las paginadas ya lo hacian).
          res.status(200).json({ data: result });
        } catch (err) {
          next(err);
        }
      },
    );
  }

  if (deps.listPortalTasks) {
    const listPortalTasks = deps.listPortalTasks;
    router.get(
      '/tasks',
      deps.portalAuthMiddleware,
      generalRateLimiter,
      async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const clientId = requireClientId(req, res);
        if (!clientId) return;
        try {
          const result = await listPortalTasks.execute(clientId);
          // M6 — mismo envelope {data} que el resto de las colecciones del portal.
          res.status(200).json({ data: result });
        } catch (err) {
          next(err);
        }
      },
    );
  }

  // portal-ticket-topic — catálogo de tópicos que el cliente puede elegir al
  // abrir un reclamo. Ruta ESTÁTICA (`/ticket-topics`), sin colisión posible
  // con `/tickets/:number` (segmento distinto) — igual se monta ANTES de
  // `/tickets` por el mismo criterio "literal antes que :param" del resto del
  // archivo.
  if (deps.listPortalTicketTopics) {
    const listPortalTicketTopics = deps.listPortalTicketTopics;
    router.get(
      '/ticket-topics',
      deps.portalAuthMiddleware,
      generalRateLimiter,
      async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const clientId = requireClientId(req, res);
        if (!clientId) return;
        try {
          const result = await listPortalTicketTopics.execute();
          // M6 — mismo envelope {data} que el resto de las colecciones del portal.
          res.status(200).json({ data: result });
        } catch (err) {
          next(err);
        }
      },
    );
  }

  if (deps.listPortalTickets) {
    const listPortalTickets = deps.listPortalTickets;
    router.get(
      '/tickets',
      deps.portalAuthMiddleware,
      generalRateLimiter,
      async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const clientId = requireClientId(req, res);
        if (!clientId) return;
        try {
          // M2 — parseo estricto compartido (entero >=1, cap 100): basura => default.
          const { page, limit } = parsePagination(req.query);
          // F7 — segundo cap, MÁS BAJO, propio de esta ruta (ver nota de
          // PORTAL_TICKETS_LIST_MAX_LIMIT arriba): el N+1 de unreadCount hace
          // que el tamaño de página importe acá de un modo que no aplica al
          // resto de las rutas paginadas del portal.
          const cappedLimit = limit === undefined ? undefined : Math.min(limit, PORTAL_TICKETS_LIST_MAX_LIMIT);
          const result = await listPortalTickets.execute(clientId, { page, limit: cappedLimit });
          res.status(200).json(result);
        } catch (err) {
          next(err);
        }
      },
    );
  }

  // POST /tickets montado ANTES de GET /tickets/:id — mismo router, sin
  // colisión real (métodos distintos), pero mantiene el patrón "rutas
  // estáticas antes que :id" del resto del repo (tickets.routes.ts).
  if (deps.createPortalTicket) {
    const createPortalTicket = deps.createPortalTicket;
    router.post(
      '/tickets',
      deps.portalAuthMiddleware,
      generalRateLimiter,
      ticketCreateRateLimiter,
      async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const clientId = requireClientId(req, res);
        if (!clientId) return;
        const { subject, description, contractId, topicId } = (req.body ?? {}) as {
          subject?: unknown;
          description?: unknown;
          contractId?: unknown;
          topicId?: unknown;
        };
        if (typeof subject !== 'string' || typeof description !== 'string') {
          res.status(400).json({ error: 'subject y description son requeridos', code: 'VALIDATION_ERROR' });
          return;
        }
        // v2.A (portal-ticket-contract) — contractId es opcional EN EL BODY (la
        // obligatoriedad condicional al cliente-con-contratos la resuelve el
        // use case, ver CreatePortalTicket); acá solo se valida el TIPO.
        if (contractId !== undefined && contractId !== null && typeof contractId !== 'string') {
          res.status(400).json({ error: 'contractId inválido', code: 'VALIDATION_ERROR' });
          return;
        }
        // portal-ticket-topic — topicId es opcional EN EL BODY (ausente/null/''
        // = camino "Otro / no sé", ver CreatePortalTicket); acá solo se valida
        // el TIPO, mismo criterio que contractId arriba.
        if (topicId !== undefined && topicId !== null && typeof topicId !== 'string') {
          res.status(400).json({ error: 'topicId inválido', code: 'VALIDATION_ERROR' });
          return;
        }
        try {
          const result = await createPortalTicket.execute(clientId, { subject, description, contractId, topicId });
          res.status(201).json(result);
        } catch (err) {
          if (err instanceof PortalContractRequiredError) {
            res.status(400).json({ error: err.message, code: err.code });
          } else if (err instanceof PortalContractNotFoundError) {
            // v2.A — 404 indistinguible: mismo status y body para "no existe"
            // y "es de otro cliente" (nunca se filtra cuál de los dos pasó).
            res.status(404).json({ error: err.message, code: err.code });
          } else if (err instanceof PortalTicketTopicNotFoundError) {
            // portal-ticket-topic — 404 indistinguible: mismo status y body
            // para "no existe" y "es un área interna" (NOC/GigaRed) — nunca se
            // filtra cuál de los dos pasó.
            res.status(404).json({ error: err.message, code: err.code });
          } else if (err instanceof PortalTicketValidationError) {
            res.status(400).json({ error: err.message, code: err.code });
          } else {
            next(err);
          }
        }
      },
    );
  }

  if (deps.getPortalTicket) {
    const getPortalTicket = deps.getPortalTicket;
    router.get(
      // C3 (fix wave) — el detalle se navega por el `number` publico del DTO
      // (Ticket.sequenceNumber), NUNCA por el UUID interno que el portal no expone.
      '/tickets/:number',
      deps.portalAuthMiddleware,
      generalRateLimiter,
      async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const clientId = requireClientId(req, res);
        if (!clientId) return;
        // Parseo ESTRICTO y CANÓNICO: entero positivo SIN ceros a la izquierda
        // (re-review: '01'/'007' eran alias de la misma URL — cada ticket tiene
        // UNA sola representacion), dentro del rango Int de Postgres
        // (sequenceNumber es Int) — cualquier otra cosa es 400, no un lookup ni
        // un 500.
        const raw = req.params['number'] as string;
        const ticketNumber = /^[1-9]\d*$/.test(raw) ? Number(raw) : NaN;
        if (!Number.isSafeInteger(ticketNumber) || ticketNumber < 1 || ticketNumber > 2_147_483_647) {
          res.status(400).json({ error: 'El número de ticket debe ser un entero positivo', code: 'VALIDATION_ERROR' });
          return;
        }
        try {
          const result = await getPortalTicket.execute(clientId, ticketNumber);
          if (!result) {
            // portal-self-service spec "Ticket ajeno por id": 404 IDÉNTICO al de
            // un id inexistente — nunca se distingue "no existe" de "es de otro".
            res.status(404).json({ error: 'Ticket not found', code: 'TICKET_NOT_FOUND' });
            return;
          }
          res.status(200).json(result);
        } catch (err) {
          next(err);
        }
      },
    );
  }

  // ── portal-ticket-messaging (v2.B) ──────────────────────────────────────────
  // Rutas de LITERAL primero (`/attachments/...` = 4 segmentos) antes que las
  // que empiezan con `:number` (mismo criterio anti-shadowing que
  // `ticketMessages.routes.ts` lado admin) — no es estrictamente necesario acá
  // (Express desambigua por método + nº de segmentos igual), pero mantiene la
  // convención de "literal antes que :param" del resto del archivo.
  if (deps.getPortalTicketMessageAttachmentFile) {
    const getAttachmentFile = deps.getPortalTicketMessageAttachmentFile;
    router.get(
      '/tickets/:number/messages/attachments/:attachmentId/file',
      deps.portalAuthMiddleware,
      generalRateLimiter,
      async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const clientId = requireClientId(req, res);
        if (!clientId) return;
        const raw = req.params['number'] as string;
        const ticketNumber = /^[1-9]\d*$/.test(raw) ? Number(raw) : NaN;
        if (!Number.isSafeInteger(ticketNumber) || ticketNumber < 1 || ticketNumber > 2_147_483_647) {
          res.status(400).json({ error: 'El número de ticket debe ser un entero positivo', code: 'VALIDATION_ERROR' });
          return;
        }
        try {
          const file = await getAttachmentFile.execute(clientId, ticketNumber, req.params['attachmentId'] as string);
          if (!file) {
            // spec "Adjunto de un reclamo ajeno": 404 indistinguible — no existe,
            // es de otro ticket, o es un adjunto interno (nunca se filtra cuál).
            res.status(404).json({ error: 'Attachment not found', code: 'TICKET_MESSAGE_ATTACHMENT_NOT_FOUND' });
            return;
          }
          res.setHeader('Content-Type', file.mimeType);
          res.setHeader('Content-Disposition', contentDisposition(file.filename));
          res.send(file.buffer);
        } catch (err) {
          next(err);
        }
      },
    );
  }

  if (deps.listPortalTicketMessages) {
    const listMessages = deps.listPortalTicketMessages;
    router.get(
      '/tickets/:number/messages',
      deps.portalAuthMiddleware,
      generalRateLimiter,
      async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const clientId = requireClientId(req, res);
        if (!clientId) return;
        const raw = req.params['number'] as string;
        const ticketNumber = /^[1-9]\d*$/.test(raw) ? Number(raw) : NaN;
        if (!Number.isSafeInteger(ticketNumber) || ticketNumber < 1 || ticketNumber > 2_147_483_647) {
          res.status(400).json({ error: 'El número de ticket debe ser un entero positivo', code: 'VALIDATION_ERROR' });
          return;
        }
        try {
          const result = await listMessages.execute(clientId, ticketNumber);
          if (!result) {
            // portal-self-service C3 spec, mismo contrato que GET /tickets/:number.
            res.status(404).json({ error: 'Ticket not found', code: 'TICKET_NOT_FOUND' });
            return;
          }
          // M6 (convención existente) — envelope {data} para colecciones del portal.
          res.status(200).json({ data: result });
        } catch (err) {
          next(err);
        }
      },
    );
  }

  if (deps.sendPortalTicketMessage) {
    const sendMessage = deps.sendPortalTicketMessage;
    router.post(
      '/tickets/:number/messages',
      deps.portalAuthMiddleware,
      generalRateLimiter,
      ticketMessageSendRateLimiter,
      uploadTicketMessageFiles,
      async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const clientId = requireClientId(req, res);
        if (!clientId) return;
        const accountId = req.portalAccountId;
        if (!accountId) {
          res.status(401).json({ error: 'Authentication required', code: 'UNAUTHORIZED' });
          return;
        }
        const raw = req.params['number'] as string;
        const ticketNumber = /^[1-9]\d*$/.test(raw) ? Number(raw) : NaN;
        if (!Number.isSafeInteger(ticketNumber) || ticketNumber < 1 || ticketNumber > 2_147_483_647) {
          res.status(400).json({ error: 'El número de ticket debe ser un entero positivo', code: 'VALIDATION_ERROR' });
          return;
        }
        const parsed = SendPortalTicketMessageSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
          return;
        }
        const files = (req.files as Express.Multer.File[] | undefined) ?? [];
        try {
          const result = await sendMessage.execute(clientId, accountId, ticketNumber, {
            body: parsed.data.body,
            files: files.map((f) => ({ buffer: f.buffer, originalName: f.originalname, mimeType: f.mimetype })),
          });
          if (!result) {
            res.status(404).json({ error: 'Ticket not found', code: 'TICKET_NOT_FOUND' });
            return;
          }
          res.status(201).json(result);
        } catch (err) {
          next(err);
        }
      },
    );
  }

  if (deps.deleteMyPortalAccount) {
    const deleteMyPortalAccount = deps.deleteMyPortalAccount;
    router.delete(
      '/account',
      deps.portalAuthMiddleware,
      generalRateLimiter,
      async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const { password } = (req.body ?? {}) as { password?: unknown };
        if (typeof password !== 'string' || !password) {
          res.status(400).json({ error: 'password es requerida', code: 'VALIDATION_ERROR' });
          return;
        }
        const accountId = req.portalAccountId;
        if (!accountId) {
          res.status(401).json({ error: 'Authentication required', code: 'UNAUTHORIZED' });
          return;
        }
        try {
          await deleteMyPortalAccount.execute({ accountId, password });
          res.status(204).send();
        } catch (err) {
          if (err instanceof InvalidCurrentPortalPasswordError) {
            res.status(401).json({ error: err.message, code: err.code });
          } else if (err instanceof PortalAccountNotFoundError) {
            res.status(404).json({ error: err.message, code: err.code });
          } else {
            next(err);
          }
        }
      },
    );
  }

  // ── portal-promos — promociones en la app de clientes ──────────────────────
  // Estáticas antes que `:id` (mismo criterio que el resto del archivo);
  // `:id/interest` y `:id/dismiss` son sub-paths, sin colisión posible.
  if (deps.listPortalPromos) {
    const listPortalPromos = deps.listPortalPromos;
    router.get(
      '/promos',
      deps.portalAuthMiddleware,
      generalRateLimiter,
      async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const clientId = requireClientId(req, res);
        if (!clientId) return;
        try {
          const result = await listPortalPromos.execute(clientId);
          // M6 — mismo envelope {data} que el resto de las colecciones del portal.
          res.status(200).json({ data: result });
        } catch (err) {
          next(err);
        }
      },
    );
  }

  if (deps.getPortalPromo) {
    const getPortalPromo = deps.getPortalPromo;
    router.get(
      '/promos/:id',
      deps.portalAuthMiddleware,
      generalRateLimiter,
      async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const clientId = requireClientId(req, res);
        if (!clientId) return;
        try {
          const result = await getPortalPromo.execute(clientId, req.params['id'] as string);
          if (!result) {
            // Re-chequeo de TODAS las condiciones (portal-promos design) —
            // 404 indistinguible: no existe, borrador, archivada, fuera de
            // ventana, otro segmento, o ya respondida.
            res.status(404).json({ error: 'Promo not found', code: 'PORTAL_PROMO_NOT_FOUND' });
            return;
          }
          res.status(200).json(result);
        } catch (err) {
          next(err);
        }
      },
    );
  }

  if (deps.interestInPortalPromo) {
    const interestInPortalPromo = deps.interestInPortalPromo;
    router.post(
      '/promos/:id/interest',
      deps.portalAuthMiddleware,
      generalRateLimiter,
      async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const clientId = requireClientId(req, res);
        if (!clientId) return;
        const { contractId } = (req.body ?? {}) as { contractId?: unknown };
        if (contractId !== undefined && contractId !== null && typeof contractId !== 'string') {
          res.status(400).json({ error: 'contractId inválido', code: 'VALIDATION_ERROR' });
          return;
        }
        try {
          const result = await interestInPortalPromo.execute(clientId, req.params['id'] as string, { contractId });
          if (!result) {
            res.status(404).json({ error: 'Promo not found', code: 'PORTAL_PROMO_NOT_FOUND' });
            return;
          }
          // IDEMPOTENTE — 201 la primera vez que crea el ticket, 200 cuando
          // ya existía (mismo ticketNumber, ningún ticket nuevo).
          res.status(result.created ? 201 : 200).json({ ticketNumber: result.ticketNumber });
        } catch (err) {
          if (err instanceof PortalContractRequiredError) {
            res.status(400).json({ error: err.message, code: err.code });
          } else if (err instanceof PortalContractNotFoundError) {
            res.status(404).json({ error: err.message, code: err.code });
          } else {
            next(err);
          }
        }
      },
    );
  }

  if (deps.dismissPortalPromo) {
    const dismissPortalPromo = deps.dismissPortalPromo;
    router.post(
      '/promos/:id/dismiss',
      deps.portalAuthMiddleware,
      generalRateLimiter,
      async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const clientId = requireClientId(req, res);
        if (!clientId) return;
        try {
          const ok = await dismissPortalPromo.execute(clientId, req.params['id'] as string);
          if (!ok) {
            res.status(404).json({ error: 'Promo not found', code: 'PORTAL_PROMO_NOT_FOUND' });
            return;
          }
          res.status(204).send();
        } catch (err) {
          next(err);
        }
      },
    );
  }

  // ── portal-benefits — pestaña Catálogo (Disponibles/Activados) ─────────────
  // Ruta estática (`/benefits`), sin colisión con `/promos*`. Devuelve el
  // objeto compuesto TAL CUAL (sin envelope `{data}`) — no es una colección,
  // es un recurso con dos colecciones adentro, mismo criterio que `GET /me`.
  if (deps.listPortalBenefits) {
    const listPortalBenefits = deps.listPortalBenefits;
    router.get(
      '/benefits',
      deps.portalAuthMiddleware,
      generalRateLimiter,
      async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const clientId = requireClientId(req, res);
        if (!clientId) return;
        try {
          const result = await listPortalBenefits.execute(clientId);
          res.status(200).json(result);
        } catch (err) {
          next(err);
        }
      },
    );
  }

  // ── portal-push-notifications — registro de dispositivos + preferencias ────
  // Estáticas, sin colisión con ningún `:param` del archivo.

  if (deps.registerPortalPushToken) {
    const registerPortalPushToken = deps.registerPortalPushToken;
    router.post(
      '/push/register',
      deps.portalAuthMiddleware,
      generalRateLimiter,
      async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const accountId = req.portalAccountId;
        if (!accountId) {
          res.status(401).json({ error: 'Authentication required', code: 'UNAUTHORIZED' });
          return;
        }
        const parsed = RegisterPortalPushTokenSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
          return;
        }
        try {
          await registerPortalPushToken.execute(accountId, parsed.data);
          res.status(204).send();
        } catch (err) {
          next(err);
        }
      },
    );
  }

  if (deps.unregisterPortalPushToken) {
    const unregisterPortalPushToken = deps.unregisterPortalPushToken;
    router.delete(
      '/push/register',
      deps.portalAuthMiddleware,
      generalRateLimiter,
      async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const accountId = req.portalAccountId;
        if (!accountId) {
          res.status(401).json({ error: 'Authentication required', code: 'UNAUTHORIZED' });
          return;
        }
        const parsed = UnregisterPortalPushTokenSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
          return;
        }
        try {
          // Idempotente y anti-enumeración: 204 SIEMPRE, exista el token o
          // pertenezca a otra cuenta — mismo criterio que `LogoutPortal`.
          await unregisterPortalPushToken.execute(accountId, parsed.data.token);
          res.status(204).send();
        } catch (err) {
          next(err);
        }
      },
    );
  }

  if (deps.getPortalPushPreferences) {
    const getPortalPushPreferences = deps.getPortalPushPreferences;
    router.get(
      '/push/preferences',
      deps.portalAuthMiddleware,
      generalRateLimiter,
      async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const accountId = req.portalAccountId;
        if (!accountId) {
          res.status(401).json({ error: 'Authentication required', code: 'UNAUTHORIZED' });
          return;
        }
        try {
          const result = await getPortalPushPreferences.execute(accountId);
          res.status(200).json(result);
        } catch (err) {
          next(err);
        }
      },
    );
  }

  if (deps.updatePortalPushPreferences) {
    const updatePortalPushPreferences = deps.updatePortalPushPreferences;
    router.put(
      '/push/preferences',
      deps.portalAuthMiddleware,
      generalRateLimiter,
      async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const accountId = req.portalAccountId;
        if (!accountId) {
          res.status(401).json({ error: 'Authentication required', code: 'UNAUTHORIZED' });
          return;
        }
        const parsed = UpdatePortalPushPreferencesSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
          return;
        }
        const appVersionHeader = req.header('X-App-Version');
        const appVersion = typeof appVersionHeader === 'string' && appVersionHeader.trim() ? appVersionHeader.trim() : null;
        try {
          const result = await updatePortalPushPreferences.execute(accountId, parsed.data, appVersion);
          res.status(200).json(result);
        } catch (err) {
          next(err);
        }
      },
    );
  }

  // ── portal-notification-inbox — buzón de avisos ─────────────────────────────
  // Feedback probando el push real: "se mandó la notificación pero no
  // persiste en ningún lado de la app, por lo cual la persona puede abrirla
  // sin leerla" — este bloque expone el buzón que `SendPushServiceAlert`
  // llena por cuenta (con o sin token). Estáticas, sin colisión con ningún
  // `:param` de este router (no hay `/notifications/:id`).

  if (deps.listPortalNotifications) {
    const listPortalNotifications = deps.listPortalNotifications;
    router.get(
      '/notifications',
      deps.portalAuthMiddleware,
      generalRateLimiter,
      async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const accountId = req.portalAccountId;
        if (!accountId) {
          res.status(401).json({ error: 'Authentication required', code: 'UNAUTHORIZED' });
          return;
        }
        try {
          // M2 — parseo estricto compartido (entero >=1, cap 100): basura => default.
          const { page, limit } = parsePagination(req.query);
          const result = await listPortalNotifications.execute(accountId, { page, limit });
          res.status(200).json(result);
        } catch (err) {
          next(err);
        }
      },
    );
  }

  if (deps.getPortalNotificationsUnreadCount) {
    const getPortalNotificationsUnreadCount = deps.getPortalNotificationsUnreadCount;
    router.get(
      '/notifications/unread-count',
      deps.portalAuthMiddleware,
      generalRateLimiter,
      async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const accountId = req.portalAccountId;
        if (!accountId) {
          res.status(401).json({ error: 'Authentication required', code: 'UNAUTHORIZED' });
          return;
        }
        try {
          const result = await getPortalNotificationsUnreadCount.execute(accountId);
          res.status(200).json(result);
        } catch (err) {
          next(err);
        }
      },
    );
  }

  if (deps.markPortalNotificationsRead) {
    const markPortalNotificationsRead = deps.markPortalNotificationsRead;
    router.post(
      '/notifications/read',
      deps.portalAuthMiddleware,
      generalRateLimiter,
      async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const accountId = req.portalAccountId;
        if (!accountId) {
          res.status(401).json({ error: 'Authentication required', code: 'UNAUTHORIZED' });
          return;
        }
        const parsed = MarkPortalNotificationsReadSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
          return;
        }
        try {
          // Anti-IDOR: `markRead` filtra por `accountId` — un id ajeno en el
          // array se ignora en silencio (ver el docblock del port).
          await markPortalNotificationsRead.execute(accountId, parsed.data.ids);
          res.status(204).send();
        } catch (err) {
          next(err);
        }
      },
    );
  }

  if (deps.markAllPortalNotificationsRead) {
    const markAllPortalNotificationsRead = deps.markAllPortalNotificationsRead;
    router.post(
      '/notifications/read-all',
      deps.portalAuthMiddleware,
      generalRateLimiter,
      async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const accountId = req.portalAccountId;
        if (!accountId) {
          res.status(401).json({ error: 'Authentication required', code: 'UNAUTHORIZED' });
          return;
        }
        try {
          await markAllPortalNotificationsRead.execute(accountId);
          res.status(204).send();
        } catch (err) {
          next(err);
        }
      },
    );
  }

  // ── wifi-self-service (F0) — "Mi WiFi" ──────────────────────────────────────
  // `contractId` viene por PARAM pero se verifica SIEMPRE contra `req.portalClientId`
  // dentro de `ResolveWifiEligibility` (anti-IDOR estructural, mismo criterio que
  // el resto del portal): 404 indistinguible entre "no existe" y "es de otro cliente".
  // `not_configured`/`no_onu`/`no_tr069`/`no_wifi_ports` son ESTADOS NORMALES (200),
  // nunca errores — la app decide qué mostrar (proposal.md F0).

  if (deps.getPortalWifiStatus) {
    const getPortalWifiStatus = deps.getPortalWifiStatus;
    router.get(
      '/wifi/:contractId',
      deps.portalAuthMiddleware,
      generalRateLimiter,
      async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const clientId = requireClientId(req, res);
        if (!clientId) return;
        try {
          const result = await getPortalWifiStatus.execute(clientId, req.params['contractId'] as string);
          res.status(200).json(result);
        } catch (err) {
          if (err instanceof WifiContractNotFoundError) {
            res.status(404).json({ error: err.message, code: err.code });
            return;
          }
          next(err);
        }
      },
    );
  }

  if (deps.updatePortalWifiBand) {
    const updatePortalWifiBand = deps.updatePortalWifiBand;
    router.put(
      '/wifi/:contractId',
      deps.portalAuthMiddleware,
      generalRateLimiter,
      wifiUpdateRateLimiter,
      async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const clientId = requireClientId(req, res);
        if (!clientId) return;
        const parsed = UpdatePortalWifiBandSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
          return;
        }
        try {
          await updatePortalWifiBand.execute(clientId, req.params['contractId'] as string, parsed.data);
          res.status(200).json({ applied: true });
        } catch (err) {
          if (err instanceof WifiContractNotFoundError) {
            res.status(404).json({ error: err.message, code: err.code });
            return;
          }
          if (err instanceof WifiValidationError) {
            res.status(400).json({ error: err.message, code: err.code });
            return;
          }
          if (err instanceof WifiNotEligibleError) {
            // Re-verificación (proposal regla 2): la ONU dejó de ser elegible
            // entre el GET y este PUT — 409, el request está bien formado pero
            // el ESTADO actual no lo permite.
            res.status(409).json({ error: err.message, code: err.code, reason: err.reason });
            return;
          }
          next(err);
        }
      },
    );
  }

  if (deps.listPortalWifiDevices) {
    const listPortalWifiDevices = deps.listPortalWifiDevices;
    router.get(
      '/wifi/:contractId/devices',
      deps.portalAuthMiddleware,
      generalRateLimiter,
      async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const clientId = requireClientId(req, res);
        if (!clientId) return;
        try {
          const result = await listPortalWifiDevices.execute(clientId, req.params['contractId'] as string);
          res.status(200).json(result);
        } catch (err) {
          if (err instanceof WifiContractNotFoundError) {
            res.status(404).json({ error: err.message, code: err.code });
            return;
          }
          next(err);
        }
      },
    );
  }

  // ── portal-equipment-reboot — "Reiniciar mi equipo" ─────────────────────────
  // Extiende wifi-self-service (F0), NO lo duplica: reusa `ResolveEquipmentRebootEligibility`,
  // que a su vez reusa el MISMO `WifiManagementPort.getOnuWifiStatus` (cache 60s)
  // que "Mi WiFi" — pero la elegibilidad es MÁS AMPLIA (sin exigir TR-069 ni
  // puertos WiFi, ver el docblock del resolver). `contractId` por PARAM,
  // verificado SIEMPRE contra `req.portalClientId` (anti-IDOR estructural,
  // mismo criterio que `/wifi/:contractId`): 404 indistinguible entre "no
  // existe" y "es de otro cliente". `not_configured`/`no_onu` son ESTADOS
  // NORMALES (200), nunca errores.

  if (deps.getPortalEquipmentStatus) {
    const getPortalEquipmentStatus = deps.getPortalEquipmentStatus;
    router.get(
      '/equipment/:contractId',
      deps.portalAuthMiddleware,
      generalRateLimiter,
      async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const clientId = requireClientId(req, res);
        if (!clientId) return;
        try {
          const result = await getPortalEquipmentStatus.execute(clientId, req.params['contractId'] as string);
          res.status(200).json(result);
        } catch (err) {
          if (err instanceof EquipmentContractNotFoundError) {
            res.status(404).json({ error: err.message, code: err.code });
            return;
          }
          next(err);
        }
      },
    );
  }

  if (deps.rebootPortalEquipment) {
    const rebootPortalEquipment = deps.rebootPortalEquipment;
    router.post(
      '/equipment/:contractId/reboot',
      deps.portalAuthMiddleware,
      generalRateLimiter,
      equipmentRebootRateLimiter,
      async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const clientId = requireClientId(req, res);
        if (!clientId) return;
        try {
          // REGLA DURA (docblock de `RebootPortalEquipment`): re-verifica la
          // elegibilidad ENTERA antes de disparar el reinicio — nunca confía
          // en un estado leído en un GET anterior.
          await rebootPortalEquipment.execute(clientId, req.params['contractId'] as string);
          res.status(202).json({ accepted: true });
        } catch (err) {
          if (err instanceof EquipmentContractNotFoundError) {
            res.status(404).json({ error: err.message, code: err.code });
            return;
          }
          if (err instanceof EquipmentNotEligibleError) {
            // La ONU dejó de ser elegible entre el GET y este POST — 409: el
            // request está bien formado, pero el ESTADO actual no lo permite.
            res.status(409).json({ error: err.message, code: err.code, reason: err.reason });
            return;
          }
          next(err);
        }
      },
    );
  }

  return router;
}
