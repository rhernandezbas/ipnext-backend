import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import type { AuthProvider } from '@domain/ports/AuthProvider';
import type { SessionRepository } from '@domain/ports/SessionRepository';
import { createAuthMiddleware } from '../middleware/authMiddleware';
import { DomainError } from '@domain/errors/index';
import type { GetTeamsLiveStatus } from '@application/use-cases/GetTeamsLiveStatus';
import type { GetTeamDailyJourney } from '@application/use-cases/GetTeamDailyJourney';
import type { AuditServiceOrderPresence } from '@application/use-cases/AuditServiceOrderPresence';
import type { ListSuspiciousClosures } from '@application/use-cases/ListSuspiciousClosures';

/**
 * Ubicación y auditoría de presencia de las cuadrillas (change iclass-gps-audit).
 *
 *   GET /live                          — mapa en vivo   (technicians.location_read)
 *   GET /:login/journey?day=…          — jornada        (read si es reciente, audit si es histórica)
 *   GET /audit/service-order/:code     — veredicto      (technicians.location_audit)
 *   GET /audit/suspicious-closures     — pre-filtro     (technicians.location_audit)
 *
 * Montar en /api/technicians.
 *
 * ## Por qué la jornada tiene un gate DINÁMICO (review adversarial, hallazgo 3.1)
 *
 * La versión anterior ponía `/:login/journey` entero bajo `location_read` (el permiso de
 * despacho). Como acepta cualquier fecha y la retención propia es de 12 meses, un usuario
 * de despacho podía pedir `/live` (roster completo con todos los logins) e iterar 365 días
 * por persona, reconstruyendo **horarios de entrada y salida de cada empleado durante un
 * año**. Eso es exactamente lo que la separación de permisos venía a impedir.
 *
 * Ahora: la jornada RECIENTE (hoy/ayer) —que es la que despacho necesita para operar— va
 * con `location_read`; cualquier día anterior exige `location_audit`.
 *
 * Las rutas `/audit/...` se registran ANTES de `/:login/...` para que el catch-all de
 * login no se trague "audit".
 */

export interface TechnicianLocationRouterDeps {
  getTeamsLiveStatus: GetTeamsLiveStatus;
  getTeamDailyJourney: GetTeamDailyJourney;
  auditServiceOrderPresence: AuditServiceOrderPresence;
  listSuspiciousClosures: ListSuspiciousClosures;
  requireLocationRead: RequestHandler;
  requireLocationAudit: RequestHandler;
  /**
   * Opcional SÓLO para tests de ruta, que inyectan guards ya resueltos. En producción
   * SIEMPRE se pasa: sin autenticación `req.user` no existe.
   */
  authProvider?: AuthProvider;
  /**
   * Necesario para que la REVOCACIÓN DE SESIÓN funcione (hallazgo 3.2). Sin él,
   * `createAuthMiddleware` cae a un chequeo legacy de JWT a secas: se revoca la sesión de
   * un ex-empleado y sigue viendo el GPS de todas las cuadrillas hasta 8 horas. Los ~30
   * montajes del repo lo pasan; éste era la única excepción.
   */
  sessionRepo?: SessionRepository;
  now?: () => Date;
}

/** "yyyy-MM-dd" — día calendario argentino. */
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Días hacia atrás que despacho puede ver con el permiso operativo (hoy y ayer). */
const OPERATIONAL_JOURNEY_DAYS = 1;

/**
 * Rango máximo del barrido de cierres.
 *
 * Antes eran 30 días. Esa cota se puso como límite de SEGURIDAD (que un solo GET no
 * tumbara la integración IClass entera), nunca como límite de usabilidad — y medido en
 * producción quedó demostrado que el rango permitido no era el rango que responde:
 *
 *   7 días  → 504, y React Query reintenta: ~2 min de spinner antes del error
 *   3 días  → 200 OK en 60-90 s
 *   1 día   → 200 OK, rápido
 *
 * Con ~16 OS/día y un `getServiceOrderHistory` EN SERIE por orden, el costo es lineal:
 * ~1,5 s por orden. 3 días ≈ 48 órdenes ≈ 72 s; 7 días ≈ 112 órdenes ≈ 168 s, por encima
 * del timeout del gateway. Permitir un rango que SIEMPRE devuelve 504 no es permisividad,
 * es una trampa: el auditor espera dos minutos para no recibir nada.
 *
 * 3 es el mayor valor con evidencia medida de responder 200. La cota de seguridad sigue
 * cumpliéndose — es más estricta, no menos.
 */
const MAX_AUDIT_RANGE_DAYS = 3;

export function createTechnicianLocationRouter(deps: TechnicianLocationRouterDeps): Router {
  const router = Router();
  const now = deps.now ?? (() => new Date());

  // Autenticación primero, CON sessionRepo para que la revocación tenga efecto.
  if (deps.authProvider) router.use(createAuthMiddleware(deps.authProvider, deps.sessionRepo));

  // ── Auditoría (technicians.location_audit) ────────────────────────────────

  router.get(
    '/audit/suspicious-closures',
    deps.requireLocationAudit,
    async (req: Request, res: Response) => {
      try {
        const from = parseArgentinaDay(req.query.from);
        const to = parseArgentinaDay(req.query.to);
        if (!from || !to) {
          res.status(400).json({ error: 'from y to son requeridos con formato yyyy-MM-dd válido' });
          return;
        }
        if (from.getTime() > to.getTime()) {
          res.status(400).json({ error: 'from no puede ser posterior a to' });
          return;
        }
        const rangeDays = (to.getTime() - from.getTime()) / 86_400_000;
        if (rangeDays > MAX_AUDIT_RANGE_DAYS) {
          // Sin esta cota, un solo GET dispara un getServiceOrderHistory por orden EN
          // SERIE y satura IClass, tumbando el closure loop y la creación de OS.
          // El mensaje dice el límite Y por qué: si sólo dijera "no puede superar N", el
          // auditor lo lee como burocracia y reintenta hasta comerse el timeout.
          res.status(400).json({
            error:
              `El rango no puede superar ${MAX_AUDIT_RANGE_DAYS} días (pedido: ${Math.round(rangeDays)}). ` +
              `El barrido consulta el histórico de cada orden contra IClass en serie; por encima de ` +
              `${MAX_AUDIT_RANGE_DAYS} días la consulta no llega a responder. Partí el período en tramos.`,
          });
          return;
        }

        let thresholdMinutes: number | undefined;
        if (req.query.thresholdMinutes !== undefined) {
          thresholdMinutes = Number(req.query.thresholdMinutes);
          if (!Number.isFinite(thresholdMinutes) || thresholdMinutes <= 0) {
            res.status(400).json({ error: 'thresholdMinutes debe ser un número positivo' });
            return;
          }
        }

        const result = await deps.listSuspiciousClosures.execute({ from, to, thresholdMinutes });
        res.json({ data: result.candidates, meta: { thresholdMinutes: result.thresholdMinutes } });
      } catch (err) {
        respondError(res, err);
      }
    },
  );

  router.get(
    '/audit/service-order/:code',
    deps.requireLocationAudit,
    async (req: Request, res: Response) => {
      try {
        const code = String(req.params.code ?? '').trim();
        if (!code) {
          res.status(400).json({ error: 'code es requerido' });
          return;
        }
        const data = await deps.auditServiceOrderPresence.execute({ serviceOrderCode: code });
        res.json({ data });
      } catch (err) {
        respondError(res, err);
      }
    },
  );

  // ── Operación / despacho (technicians.location_read) ──────────────────────

  router.get('/live', deps.requireLocationRead, async (_req: Request, res: Response) => {
    try {
      const data = await deps.getTeamsLiveStatus.execute();
      res.json({ data });
    } catch (err) {
      respondError(res, err);
    }
  });

  /**
   * Gate DINÁMICO: la jornada reciente es operativa; la histórica es auditoría.
   * Se valida el día ANTES de elegir el guard, para no filtrar por el código de estado
   * si una fecha es válida o no.
   */
  const journeyGate: RequestHandler = (req, res, next) => {
    const day = parseArgentinaDay(req.query.day);
    if (!day) {
      res.status(400).json({ error: 'day es requerido con formato yyyy-MM-dd válido' });
      return;
    }
    const todayStart = argentinaDayStart(now());
    if (day.getTime() > todayStart.getTime()) {
      res.status(400).json({ error: 'day no puede ser una fecha futura' });
      return;
    }
    const daysBack = Math.round((todayStart.getTime() - day.getTime()) / 86_400_000);
    const guard = daysBack <= OPERATIONAL_JOURNEY_DAYS ? deps.requireLocationRead : deps.requireLocationAudit;
    guard(req, res, next as NextFunction);
  };

  router.get('/:login/journey', journeyGate, async (req: Request, res: Response) => {
    try {
      const login = String(req.params.login ?? '').trim();
      if (!login) {
        res.status(400).json({ error: 'login es requerido' });
        return;
      }
      const data = await deps.getTeamDailyJourney.execute({
        teamLogin: login,
        argentinaDay: String(req.query.day),
      });
      res.json({ data });
    } catch (err) {
      respondError(res, err);
    }
  });

  return router;
}

/**
 * "yyyy-MM-dd" argentino → instante de inicio de ese día en UTC.
 * Rechaza calendarios imposibles (`2026-02-31`) en vez de dejar que `Date.UTC` desborde
 * silenciosamente a otro día — que en un endpoint de auditoría sobre PERSONAS significaría
 * servir el rastro de una fecha distinta a la pedida.
 */
function parseArgentinaDay(raw: unknown): Date | null {
  const value = String(raw ?? '').trim();
  const m = DAY_RE.exec(value);
  if (!m) return null;

  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  // El día calendario argentino arranca a las 03:00 UTC.
  const asUtc = Date.UTC(year, month - 1, day);
  const roundTrip = new Date(asUtc);
  if (
    roundTrip.getUTCFullYear() !== year ||
    roundTrip.getUTCMonth() !== month - 1 ||
    roundTrip.getUTCDate() !== day
  ) {
    return null;
  }
  return new Date(asUtc + 3 * 60 * 60 * 1000);
}

/** Inicio del día calendario argentino que contiene `instant`, en UTC. */
function argentinaDayStart(instant: Date): Date {
  const local = new Date(instant.getTime() - 3 * 60 * 60 * 1000);
  return new Date(
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) + 3 * 60 * 60 * 1000,
  );
}

/**
 * Respuesta de error SANEADA.
 *
 * Sólo los errores de DOMINIO exponen su mensaje. Todo lo demás devuelve un texto
 * genérico y se loguea aparte: los errores de Prisma incluyen la ruta absoluta del
 * filesystem del servidor y el host del datasource (hallazgo 3.4). Mismo criterio que
 * `middleware/errorHandler.ts`.
 *
 * Tampoco se re-lanza: un `throw` dentro de un handler async de Express 4 NO llega al
 * middleware de errores y deja la request colgada hasta el timeout del proxy (504).
 */
function respondError(res: Response, err: unknown): void {
  if (err instanceof DomainError) {
    res.status(502).json({ error: err.message, code: err.code });
    return;
  }
  console.error('[technician-location] error inesperado:', err);
  res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
}
