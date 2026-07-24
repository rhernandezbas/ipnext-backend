import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { IngestAlert } from '@application/use-cases/alerts/IngestAlert';
import { ListAlerts } from '@application/use-cases/alerts/ListAlerts';
import { AcknowledgeAlert } from '@application/use-cases/alerts/AcknowledgeAlert';
import { GetAlertThresholds } from '@application/use-cases/alerts/GetAlertThresholds';
import { UpdateAlertThresholds } from '@application/use-cases/alerts/UpdateAlertThresholds';
import { toNocAlertDto } from '@application/dto/nocAlert';
import { UpdateNocAlertThresholdsSchema } from '@application/dto/nocAlertThresholds.dto';
import { NocAlert, NocAlertInput, NocAlertSeverity, NocAlertStatus } from '@domain/entities/nocAlert';
import { NocAlertListFilters } from '@domain/ports/NocAlertRepository';
import type { NocAlertEvent } from '@domain/ports/AlertEventPublisher';
import type { FeatureFlagRepository } from '@domain/ports/FeatureFlagRepository';
import { createApiKeyMiddleware, createTelegramSecretMiddleware, safeCompare } from '../middleware/apiKeyMiddleware';
import { createExternalWriteRateLimiter } from '../middleware/rateLimiters';
import type { RbacModuleCode, PermissionAction } from '@domain/entities/rbac';
import type { GrafanaWebhookSource } from '@infrastructure/adapters/grafana/GrafanaWebhookSource';
import type { AlertEventBus } from '@infrastructure/events/AlertEventBus';
import type { TelegramGateway } from '@infrastructure/adapters/telegram/TelegramGateway';

/** Factory matching `requirePerm` exported from app.ts (DIP-clean injection, molde accessPoints.routes). */
type RequirePerm = (module: RbacModuleCode, action: PermissionAction) => RequestHandler;

/**
 * F-B2/F-B3 (fix wave) — per-`alerts[]`-element outcome reported alongside
 * `data` on `POST /ingest/grafana`. `fingerprint` is absent for `skipped`
 * entries (mapping never got far enough to know one — F-B4's derivation only
 * runs once `alertname` resolved).
 */
interface GrafanaIngestElementResult {
  index: number;
  fingerprint?: string;
  status: 'ok' | 'error' | 'skipped';
  error?: string;
}

const VALID_SEVERITIES: readonly NocAlertSeverity[] = ['critical', 'warning', 'info'];
const VALID_STATUSES: readonly NocAlertStatus[] = ['firing', 'resolved'];

/** F5 (fix wave) — the same FeatureFlag key seeded ON by the noc_alert migration. */
export const NOC_ALERTS_HUB_ENABLED_FLAG = 'noc-alerts-hub-enabled';

/**
 * C — spec.md "Heartbeat keeps the connection alive through proxies" +
 * design.md (Decision: Real-time por SSE + event-bus in-memory): a comment
 * frame every 15s so the EasyPanel proxy never sees an idle connection long
 * enough to kill it.
 */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;

export interface AlertsRouterDeps {
  ingestAlert: IngestAlert;
  listAlerts: ListAlerts;
  acknowledgeAlert: AcknowledgeAlert;
  /**
   * F3 (fix wave) — spec.md "Alert ingestion endpoint auth" pide
   * `POST /api/alerts/ingest/{source}` con shared-secret POR FUENTE, no un único
   * `/ingest` con `source` leído del BODY (eso permitía spoofear: con la key de
   * fiber-collector se podía postear `source:"grafana"`). Map de fuente conocida
   * → su key. Una fuente que no está en este map → 404 (ni siquiera se compara
   * ninguna key). Key vacía para una fuente conocida → 401 (fail-closed, mismo
   * contrato que `createApiKeyMiddleware`).
   */
  ingestKeys: Record<string, string>;
  /**
   * Fase B (`noc-alert-grafana-source`) — `POST /ingest/grafana` receives
   * Grafana Alerting's OWN webhook shape (`{status, alerts: [...]}`), NOT the
   * canonical shape `parseIngestBody` below validates. `GrafanaWebhookSource`
   * owns that mapping; the route only needs `mapWebhook`. Optional so Fase A
   * fixtures/tests that never exercise `/ingest/grafana` don't need to build
   * one — if `source === 'grafana'` and this is missing, the route 500s via
   * the generic error handler (composeAlertsModule ALWAYS wires it in prod).
   */
  grafanaSource?: Pick<GrafanaWebhookSource, 'mapWebhook'>;
  /**
   * F5 (fix wave) — kill-switch de convivencia (design.md "Flags de convivencia").
   * La ingesta lee este flag EN CADA REQUEST (no cacheado) — así el toggle desde
   * el panel corta la ingesta sin deploy. Ausencia del registro (nunca seedeado)
   * se trata como HABILITADO (fail-open) porque la migración lo seedea ON por
   * default — solo un OFF explícito corta.
   */
  featureFlagRepo: FeatureFlagRepository;
  /**
   * F7 (fix wave) — inyectable para tests (limit/window chicos); en producción
   * `composeAlertsModule` no lo pasa y cae al default de `createExternalWriteRateLimiter()`.
   */
  ingestRateLimiter?: RequestHandler;
  /**
   * Fase C (`noc-alert-realtime`) — `GET /stream` subscribes to THIS concrete
   * bus (design.md "la ruta SSE se suscribe al bus, NUNCA al use-case").
   * Optional (same convivencia pattern as `grafanaSource`) so Fase A/B fixtures
   * that never exercise `/stream` don't need to build one — `composeAlertsModule`
   * ALWAYS wires it in prod, sharing the SAME instance passed as the
   * `AlertEventPublisher` to `IngestAlert`/`AcknowledgeAlert`.
   */
  eventBus?: Pick<AlertEventBus, 'subscribe'>;
  /** Test seam — overrides `DEFAULT_HEARTBEAT_INTERVAL_MS` (15s) for fast tests with a real timer. */
  heartbeatIntervalMs?: number;
  /** Session auth (`createAuthMiddleware(...)`) applied to the RBAC-guarded routes ONLY. */
  auth: RequestHandler;
  requirePerm: RequirePerm;
  /**
   * Fase D (`noc-alert-telegram`) — guards `POST /telegram/webhook`. Optional
   * (same convivencia pattern as `grafanaSource`/`eventBus`): tests that never
   * exercise the webhook don't need to build one. Falls back to
   * `createTelegramSecretMiddleware()` (reads `config.alerts.telegramWebhookSecret`
   * directly) when omitted — an unconfigured secret still fails CLOSED (401 on
   * every request), never open.
   */
  telegramWebhookAuth?: RequestHandler;
  /**
   * Fase D — used ONLY for `answerCallbackQuery` (stops Telegram's client-side
   * spinner on the button). Optional: without it the webhook still acks the
   * alert correctly, it just skips that one UX nicety.
   */
  telegramGateway?: Pick<TelegramGateway, 'answerCallbackQuery'>;
  /**
   * F1 (noc-alerts-config, `noc-alert-thresholds`) — `GET/PUT /thresholds`.
   * Optional (same convivencia pattern as `grafanaSource`/`eventBus`): test
   * fixtures that never exercise `/thresholds` don't need to build these.
   * `composeAlertsModule` ALWAYS wires both in prod. Missing at request time
   * → 500 via the generic error handler (mirrors `grafanaSource`'s guard).
   */
  getAlertThresholds?: GetAlertThresholds;
  updateAlertThresholds?: UpdateAlertThresholds;
}

/**
 * F1 (noc-alerts-config) — dual auth for `GET /thresholds`: the Rust
 * collector authenticates with THE SAME `fiberIngestKey` already used for
 * `POST /ingest/fiber-collector` (`deps.ingestKeys['fiber-collector']` —
 * reused, not a separate config key, so rotating one key never forgets the
 * other); the panel authenticates with session cookie + `monitoring.manage`.
 * spec.md "Machine read access via fiberIngestKey, read-only" + "Missing or
 * invalid API key without session is rejected" (401 when NEITHER matches).
 * `PUT` never uses this — it's session+`monitoring.manage` ONLY (see the
 * route registration below), so the machine key can never edit.
 */
function createThresholdsReadAuth(fiberKey: string, auth: RequestHandler, managePerm: RequestHandler): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (fiberKey) {
      let providedKey: string | undefined;
      const xApiKey = req.headers['x-api-key'];
      if (typeof xApiKey === 'string' && xApiKey.length > 0) {
        providedKey = xApiKey;
      } else {
        const authHeader = req.headers['authorization'];
        if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
          providedKey = authHeader.slice('Bearer '.length);
        }
      }
      if (providedKey && safeCompare(providedKey, fiberKey)) {
        next();
        return;
      }
    }
    // No valid machine key — fall back to session + monitoring.manage. A
    // missing/invalid session 401s from `auth` itself (never reaches `next`
    // with an error here since createAuthMiddleware ends the response).
    auth(req, res, (err?: unknown) => {
      if (err) {
        next(err);
        return;
      }
      managePerm(req, res, next);
    });
  };
}

/** Minimal shape of the Telegram Bot API `Update` this webhook cares about. */
interface TelegramCallbackUpdate {
  callback_query?: {
    id: string;
    data?: string;
    from?: { id: number; username?: string; first_name?: string };
  };
}

/**
 * Validates + flattens the raw ingest body into `NocAlertInput`. Returns a
 * string error message on failure (400 territory), or the input on success.
 * Fase A keeps this intentionally light — `GrafanaWebhookSource` (Fase B) owns
 * the richer per-fuente mapping/validation for the `/ingest/grafana` shim.
 *
 * F3 (fix wave): `source` is no longer read from the body — it's the PATH
 * param, authoritative. A `source` field in the body (if present) is simply
 * ignored; it can never disagree with the key that was actually checked.
 */
function parseIngestBody(body: unknown, source: string): NocAlertInput | string {
  const b = (body ?? {}) as Record<string, unknown>;
  const missing: string[] = [];
  if (typeof b['fingerprint'] !== 'string' || !b['fingerprint']) missing.push('fingerprint');
  if (typeof b['status'] !== 'string' || !VALID_STATUSES.includes(b['status'] as NocAlertStatus)) missing.push('status');
  if (typeof b['alertname'] !== 'string' || !b['alertname']) missing.push('alertname');
  if (typeof b['severity'] !== 'string' || !VALID_SEVERITIES.includes(b['severity'] as NocAlertSeverity)) missing.push('severity');
  if (typeof b['message'] !== 'string' || !b['message']) missing.push('message');

  // F1 (fix wave) — startsAt/endsAt must be a PARSEABLE ISO date, not just a
  // non-empty string. An unparseable date used to sail through this check and
  // blow up `new Date(...)` downstream in PrismaNocAlertRepository.toRow with
  // an opaque 500 instead of a clean 400.
  const startsAtRaw = b['startsAt'];
  if (typeof startsAtRaw !== 'string' || !startsAtRaw || Number.isNaN(Date.parse(startsAtRaw))) {
    missing.push('startsAt (must be a valid ISO date string)');
  }
  let endsAt: string | undefined;
  if (b['endsAt'] !== undefined) {
    if (typeof b['endsAt'] !== 'string' || Number.isNaN(Date.parse(b['endsAt'] as string))) {
      missing.push('endsAt (must be a valid ISO date string)');
    } else {
      endsAt = b['endsAt'] as string;
    }
  }

  const entity = b['entity'] as Record<string, unknown> | undefined;
  if (!entity || typeof entity['type'] !== 'string' || typeof entity['name'] !== 'string') {
    missing.push('entity.type/entity.name');
  }

  // F2 (fix wave) — metric.value / threshold must be actual numbers. Both used
  // to be cast blind (`as number`) straight into a Prisma Float column; a
  // string there blows up with an opaque 500 instead of a 400.
  const metric = b['metric'] as Record<string, unknown> | undefined;
  if (
    metric &&
    metric['value'] !== undefined &&
    (typeof metric['value'] !== 'number' || Number.isNaN(metric['value']))
  ) {
    missing.push('metric.value (must be a number)');
  }
  if (b['threshold'] !== undefined && (typeof b['threshold'] !== 'number' || Number.isNaN(b['threshold']))) {
    missing.push('threshold (must be a number)');
  }

  if (missing.length > 0) {
    return `Missing or invalid required fields: ${missing.join(', ')}`;
  }

  return {
    source,
    fingerprint: b['fingerprint'] as string,
    status: b['status'] as NocAlertStatus,
    alertname: b['alertname'] as string,
    severity: b['severity'] as NocAlertSeverity,
    entity: {
      type: (entity as Record<string, unknown>)['type'] as string,
      name: (entity as Record<string, unknown>)['name'] as string,
      ...(typeof (entity as Record<string, unknown>)['ref'] === 'string'
        ? { ref: (entity as Record<string, unknown>)['ref'] as string }
        : {}),
    },
    ...(metric
      ? { metric: { name: metric['name'] as string | undefined, value: metric['value'] as number | undefined, unit: metric['unit'] as string | undefined } }
      : {}),
    ...(typeof b['threshold'] === 'number' ? { threshold: b['threshold'] as number } : {}),
    message: b['message'] as string,
    ...(typeof b['explanation'] === 'string' ? { explanation: b['explanation'] as string } : {}),
    ...(typeof b['link'] === 'string' ? { link: b['link'] as string } : {}),
    startsAt: startsAtRaw as string,
    ...(endsAt !== undefined ? { endsAt } : {}),
  };
}

export function createAlertsRouter(deps: AlertsRouterDeps): Router {
  const { ingestAlert, listAlerts, acknowledgeAlert, ingestKeys, featureFlagRepo, grafanaSource, eventBus, auth, requirePerm, telegramGateway } = deps;
  const heartbeatIntervalMs = deps.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const telegramWebhookAuth = deps.telegramWebhookAuth ?? createTelegramSecretMiddleware();
  const router = Router();

  const readPerm = requirePerm('monitoring', 'read');
  const ackPerm = requirePerm('monitoring', 'acknowledge_alert');
  const managePerm = requirePerm('monitoring', 'manage');
  const ingestRateLimiter = deps.ingestRateLimiter ?? createExternalWriteRateLimiter();
  const thresholdsReadAuth = createThresholdsReadAuth(ingestKeys['fiber-collector'] ?? '', auth, managePerm);

  // POST /ingest/:source — per-source canonical ingestion (F3, spec.md "Alert
  // ingestion endpoint auth"). Machine-to-machine, no RBAC, no req.user. The
  // :source path param resolves WHICH key guards this request — an unknown
  // source 404s before any key comparison happens (fiber-collector's key is
  // never even considered for /ingest/grafana). Rate limiter sits AFTER the
  // key check (F7, same order as the external write surface, molde
  // externalV1.routes.ts) — a rejected key never eats into the write quota.
  router.post(
    '/ingest/:source',
    (req: Request, res: Response, next: NextFunction): void => {
      const source = req.params['source'] as string;
      const key = ingestKeys[source];
      if (key === undefined) {
        res.status(404).json({ error: `Unknown ingest source: ${source}`, code: 'UNKNOWN_INGEST_SOURCE' });
        return;
      }
      createApiKeyMiddleware(key)(req, res, next);
    },
    ingestRateLimiter,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const source = req.params['source'] as string;

        // F5 — kill-switch, read fresh per-request (no caching — toggle takes
        // effect immediately, no deploy).
        const flag = await featureFlagRepo.get(NOC_ALERTS_HUB_ENABLED_FLAG);
        if (!(flag?.enabled ?? true)) {
          res.status(503).json({ error: 'NOC alerts hub is disabled', code: 'NOC_ALERTS_HUB_DISABLED' });
          return;
        }

        // Fase B — Grafana's webhook body (`{status, alerts: [...]}`) is NOT the
        // canonical shape `parseIngestBody` validates below; it needs its own
        // mapper (`GrafanaWebhookSource`) that also fans a SINGLE webhook out
        // into N `IngestAlert.execute()` calls, one per `alerts[]` element
        // (spec.md "Grouped alerts produce N NocAlerts"). Only a malformed
        // SOBRE (no `alerts` array at all) → 400, nothing persisted.
        if (source === 'grafana') {
          if (!grafanaSource) {
            throw new Error('alerts.routes: grafanaSource dependency missing for source "grafana"');
          }
          const mapResult = grafanaSource.mapWebhook(req.body);
          if (typeof mapResult === 'string') {
            res.status(400).json({ error: mapResult, code: 'VALIDATION_ERROR' });
            return;
          }

          // F-B2/F-B3 (fix wave, HIGH — fan-out parcial) — each `alerts[]`
          // element is ingested in ISOLATION: a mapping failure (F-B3) or an
          // `ingestAlert.execute()` throw for ONE element (F-B2, e.g. a
          // transient repo error) must NEVER take down its siblings, and must
          // NEVER surface as a bare 500 with partial persistence already
          // committed underneath it. Upserts are idempotent by fingerprint —
          // a future retry of a failed/skipped element self-heals.
          const results: GrafanaIngestElementResult[] = mapResult.skipped.map((s) => ({
            index: s.index,
            status: 'skipped' as const,
            error: s.reason,
          }));

          const created: NocAlert[] = [];
          for (const { index, input } of mapResult.mapped) {
            try {
              const alert = await ingestAlert.execute(input);
              created.push(alert);
              results.push({ index, fingerprint: input.fingerprint, status: 'ok' });
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              results.push({ index, fingerprint: input.fingerprint, status: 'error', error: message });
            }
          }
          results.sort((r1, r2) => r1.index - r2.index);

          // 201 when every element made it in clean; 207 (multi-status) when
          // some were skipped/errored but at least one succeeded — never a
          // flat 500/400 that hides a partial success.
          //
          // FIX WAVE (regression from F-B2) — `created.length === 0` needs a
          // closer look before defaulting to 207: a 2xx here tells
          // Grafana/Alertmanager "delivered", and it will NEVER retry — if the
          // reason nothing persisted was a TRANSIENT failure (repo down mid
          // incident), the alert is lost in silence. Only a batch where every
          // element was `skipped` (malformed, retry wouldn't change the
          // outcome) may stay 2xx with nothing persisted.
          if (created.length === 0) {
            const hasTransientError = results.some((r) => r.status === 'error');
            if (hasTransientError) {
              res.status(503).json({ error: 'Failed to ingest all alerts in this webhook', code: 'INGEST_FAILED', results });
              return;
            }
            res.status(207).json({ data: [], results });
            return;
          }

          const hasFailures = results.some((r) => r.status !== 'ok');
          res.status(hasFailures ? 207 : 201).json({ data: created.map(toNocAlertDto), results });
          return;
        }

        const parsed = parseIngestBody(req.body, source);
        if (typeof parsed === 'string') {
          res.status(400).json({ error: parsed, code: 'VALIDATION_ERROR' });
          return;
        }
        const alert = await ingestAlert.execute(parsed);
        res.status(201).json(toNocAlertDto(alert));
      } catch (err) {
        next(err);
      }
    },
  );

  // GET /stream — SSE, Fase C (`noc-alert-realtime`). spec.md "SSE stream
  // requires session auth, not API key": SAME auth+RBAC molde as every other
  // human-facing route on this router (`auth` cookie + `monitoring.read`) —
  // NEVER `apiKeyMiddleware` (that's machine-to-machine, ingestion only).
  router.get('/stream', auth, readPerm, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // F-C1 (fix wave, MEDIUM) — este handler es async y hasta acá NO tenía
    // next/try-catch (a diferencia de sus hermanos POST /ingest, GET /,
    // POST /:id/acknowledge). Si `await featureFlagRepo.get(...)` (u otra
    // promesa del cuerpo) rechaza — DB hipa — quedaba como unhandledRejection
    // y la respuesta NUNCA se mandaba: cliente colgado hasta timeout. Envolver
    // todo el cuerpo en try/catch: si los headers todavía no se mandaron,
    // next(err) (mismo camino que el resto del router, cae en errorHandler);
    // si YA se mandaron (falla después de writeHead/flushHeaders, ej. dentro
    // de un listener), no se puede mandar JSON — solo cerrar limpio.
    try {
      // Convivencia (design.md "Flags de convivencia" — noc-alerts-hub-enabled
      // scopes "Ingesta + persistencia + panel + SSE"): same kill-switch as
      // /ingest/:source (F5), read fresh per-connection so a toggle from the
      // panel takes effect without a deploy. NOT gated by noc-alerts-telegram-send
      // — that flag only controls the Fase D OUTBOUND Telegram send, unrelated
      // to this internal stream.
      const flag = await featureFlagRepo.get(NOC_ALERTS_HUB_ENABLED_FLAG);
      if (!(flag?.enabled ?? true)) {
        res.status(503).json({ error: 'NOC alerts hub is disabled', code: 'NOC_ALERTS_HUB_DISABLED' });
        return;
      }

      if (!eventBus) {
        throw new Error('alerts.routes: eventBus dependency missing for GET /stream');
      }

      // Anti-buffering headers for the EasyPanel proxy (spec.md "Stream connection
      // with permission opens with correct SSE headers") + immediate flush — the
      // client must get headers WITHOUT waiting for the first event.
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders();

      // design.md "la ruta SSE se suscribe al bus, NUNCA al use-case" — every
      // NocAlertEvent published by IngestAlert/AcknowledgeAlert (via the SAME
      // AlertEventBus instance composeAlertsModule shares) becomes one SSE frame.
      // The frame carries BOTH the event `type` and the DTO (spec.md "Acknowledging
      // an alert... recibe un frame SSE con el evento acked y el NocAlertDto
      // actualizado") — never the raw entity.
      //
      // F-C2/F-C3 (fix wave) — guard `writable` ANTES de escribir: sobre un
      // socket ya cerrado/destruido `res.write` tira, y aunque AlertEventBus.publish
      // ya aísla ese throw por subscriber, evitarlo acá es más barato y más limpio.
      const listener = (event: NocAlertEvent): void => {
        if (res.writableEnded || !res.writable) return;
        res.write(`data: ${JSON.stringify({ type: event.type, alert: toNocAlertDto(event.alert) })}\n\n`);
      };
      const unsubscribe = eventBus.subscribe(listener);

      // spec.md "Heartbeat keeps the connection alive through proxies" — a
      // comment frame (`: ping\n\n`, no `data:` prefix so EventSource's
      // `onmessage` never fires for it) every `heartbeatIntervalMs`.
      const heartbeat = setInterval(() => {
        if (res.writableEnded || !res.writable) return;
        res.write(': ping\n\n');
      }, heartbeatIntervalMs);

      // F-C3 (fix wave, nit) — cleanup idempotente: `req.on('close')` y
      // `res.on('error')` pueden ambos disparar para la misma desconexión
      // (ej. el socket revienta con error Y luego se cierra) — sin el guard,
      // el segundo dispararía un doble unsubscribe/clearInterval.
      let cleanedUp = false;
      const cleanup = (): void => {
        if (cleanedUp) return;
        cleanedUp = true;
        clearInterval(heartbeat);
        unsubscribe();
      };

      // spec.md "Disconnecting a client unsubscribes it from the bus" (C13) —
      // no listener may outlive its connection, else every reconnect leaks one.
      req.on('close', cleanup);
      // F-C3 — mismo cleanup ante un error del socket de respuesta (ej. ECONNRESET
      // durante un write), no solo el cierre "prolijo" de req.on('close').
      res.on('error', cleanup);
    } catch (err) {
      if (res.headersSent) {
        res.end();
        return;
      }
      next(err);
    }
  });

  // GET / — filtered list, monitoring.read.
  router.get('/', auth, readPerm, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const q = req.query as Record<string, string>;
      const filters: NocAlertListFilters = {};
      if (typeof q['source'] === 'string') filters.source = q['source'];
      if (typeof q['severity'] === 'string') {
        // F6 (fix wave) — an invalid filter value used to be silently ignored
        // (returned EVERYTHING instead of the intended subset) — now it 400s.
        if (!VALID_SEVERITIES.includes(q['severity'] as NocAlertSeverity)) {
          res.status(400).json({ error: `Invalid severity: ${q['severity']}`, code: 'VALIDATION_ERROR' });
          return;
        }
        filters.severity = q['severity'] as NocAlertSeverity;
      }
      if (typeof q['status'] === 'string') {
        if (!VALID_STATUSES.includes(q['status'] as NocAlertStatus)) {
          res.status(400).json({ error: `Invalid status: ${q['status']}`, code: 'VALIDATION_ERROR' });
          return;
        }
        filters.status = q['status'] as NocAlertStatus;
      }
      const alerts = await listAlerts.execute(filters);
      res.json({ data: alerts.map(toNocAlertDto) });
    } catch (err) {
      next(err);
    }
  });

  // GET /thresholds — F1 (noc-alerts-config, `noc-alert-thresholds`). Dual
  // auth: fiberIngestKey (Rust collector, read-only) OR session+monitoring.manage
  // (panel). Flat DTO, NO {data:...} envelope — the collector `serde_json::
  // from_str`s the response body DIRECTLY into its `Thresholds` struct.
  router.get('/thresholds', thresholdsReadAuth, async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!deps.getAlertThresholds) {
        throw new Error('alerts.routes: getAlertThresholds dependency missing for GET /thresholds');
      }
      res.json(await deps.getAlertThresholds.execute());
    } catch (err) {
      next(err);
    }
  });

  // PUT /thresholds — HUMAN ONLY (session + monitoring.manage). The machine
  // fiberIngestKey is intentionally NOT accepted here (spec.md "Fiber
  // collector cannot edit thresholds via its API key") — no dual-auth on
  // this route, just the standard auth+requirePerm pair every other
  // RBAC-guarded route on this router uses.
  router.put('/thresholds', auth, managePerm, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const parsed = UpdateNocAlertThresholdsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
      return;
    }
    try {
      if (!deps.updateAlertThresholds) {
        throw new Error('alerts.routes: updateAlertThresholds dependency missing for PUT /thresholds');
      }
      res.json(await deps.updateAlertThresholds.execute(parsed.data));
    } catch (err) {
      next(err);
    }
  });

  // POST /:id/acknowledge — monitoring.acknowledge_alert.
  router.post(
    '/:id/acknowledge',
    auth,
    ackPerm,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const by = req.user?.username ?? req.user?.id ?? 'unknown';
        const note = typeof req.body?.note === 'string' ? req.body.note : undefined;
        const alert = await acknowledgeAlert.execute(req.params['id'] as string, by, new Date().toISOString(), note, 'panel');
        // F2 (noc-alerts-config) — AcknowledgeAlert already wrote the RICH
        // structured AuditEvent (entityType='NocAlert', actor, channel='panel')
        // when it found the alert. Mark __auditEmitted so the generic
        // auditMutationsMiddleware doesn't ALSO write its action=null
        // duplicate for this same request — same dedupe flag
        // createRequestAuditService uses (auditMutationsMiddleware.ts).
        // Idempotent re-acks (alert found, nothing changed) still suppress
        // the generic row: a no-op re-ack isn't audit-worthy noise either way.
        if (alert) {
          res.locals['__auditEmitted'] = true;
        }
        if (!alert) {
          res.status(404).json({ error: 'NocAlert not found', code: 'NOC_ALERT_NOT_FOUND' });
          return;
        }
        res.json(toNocAlertDto(alert));
      } catch (err) {
        next(err);
      }
    },
  );

  // POST /telegram/webhook — Fase D (`noc-alert-telegram`). Machine-to-machine
  // (Telegram's servers), guarded by the shared secret header, NOT session
  // auth/RBAC. spec.md "A Telegram button callback acknowledges the alert" +
  // "Double acknowledge is idempotent across channels" + "Callback for a
  // non-existent alert does not error the webhook".
  router.post(
    '/telegram/webhook',
    telegramWebhookAuth,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const update = (req.body ?? {}) as TelegramCallbackUpdate;
        const callbackQuery = update.callback_query;

        // Not a button callback (e.g. a plain message update) — 2xx, Telegram
        // must never retry an update it's not going to act on differently.
        if (!callbackQuery || typeof callbackQuery.data !== 'string') {
          res.status(200).json({ ok: true });
          return;
        }

        const match = /^ack:(.+)$/.exec(callbackQuery.data);
        if (!match) {
          res.status(200).json({ ok: true });
          return;
        }
        const alertId = match[1] as string;

        const from = callbackQuery.from;
        const ackBy = from ? `telegram:${from.username ?? from.id}` : 'telegram:unknown';

        // Non-existent id → AcknowledgeAlert returns null (same contract the
        // panel route already relies on) — nothing created/modified. Still a
        // 2xx: Telegram must not retry indefinitely on a callback that will
        // NEVER resolve to a real alert.
        // F2 (noc-alerts-config) — channel='telegram' so the structured
        // AuditEvent's afterJson.channel/actor reflect the REAL source
        // (this route is excluded from auditMutationsMiddleware entirely —
        // see EXCLUDED_MUTATION_PATH_PREFIXES — so there's no generic row to
        // dedupe against here, unlike the panel route).
        const alert = await acknowledgeAlert.execute(alertId, ackBy, new Date().toISOString(), undefined, 'telegram');

        if (telegramGateway) {
          const ackText = alert ? 'Tomado ✅' : 'Alerta no encontrada';
          try {
            await telegramGateway.answerCallbackQuery(callbackQuery.id, ackText);
          } catch {
            // F-D3 (fix wave, MEDIUM) — best-effort UX nicety (stops Telegram's
            // client-side button spinner). The ACK itself already persisted
            // above; a flake HERE must not 500 the webhook — that would make
            // Telegram retry a callback whose ack already succeeded.
          }
        }

        res.status(200).json({ ok: true });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
