import { Router, RequestHandler } from 'express';
import { config } from '@infrastructure/config';
import type { AuthProvider } from '@domain/ports/AuthProvider';
import type { SessionRepository } from '@domain/ports/SessionRepository';
import type { AuditEventRepository } from '@domain/ports/AuditEventRepository';
import type { RbacModuleCode, PermissionAction } from '@domain/entities/rbac';
import { IngestAlert } from '@application/use-cases/alerts/IngestAlert';
import { ListAlerts } from '@application/use-cases/alerts/ListAlerts';
import { AcknowledgeAlert } from '@application/use-cases/alerts/AcknowledgeAlert';
import { NotifyAlert } from '@application/use-cases/alerts/NotifyAlert';
import { GetAlertThresholds } from '@application/use-cases/alerts/GetAlertThresholds';
import { UpdateAlertThresholds } from '@application/use-cases/alerts/UpdateAlertThresholds';
import { PrismaNocAlertRepository } from '@infrastructure/adapters/prisma/PrismaNocAlertRepository';
import { PrismaFeatureFlagRepository } from '@infrastructure/adapters/prisma/PrismaFeatureFlagRepository';
import { PrismaNocAlertThresholdsConfigRepository } from '@infrastructure/adapters/prisma/PrismaNocAlertThresholdsConfigRepository';
import { AlertEventBus } from '@infrastructure/events/AlertEventBus';
import { GrafanaWebhookSource } from '@infrastructure/adapters/grafana/GrafanaWebhookSource';
import { HttpTelegramGateway } from '@infrastructure/adapters/telegram/TelegramGateway';
import { TelegramBotGateway } from '@infrastructure/adapters/telegram/TelegramBotGateway';
import { createTelegramSecretMiddleware } from './middleware/apiKeyMiddleware';
import { createIngestRateLimiter } from './middleware/rateLimiters';
import { createAlertsRouter } from './routes/alerts.routes';
import { createAuthMiddleware } from './middleware/authMiddleware';

export interface ComposeAlertsModuleDeps {
  authAdapter: AuthProvider;
  sessionRepo: SessionRepository;
  /** app.ts's module-level `requirePerm`, injected — NOT re-derived here (single
   *  rbacUserRepo instance stays the source of truth, avoids a 2nd wiring path). */
  requirePerm: (module: RbacModuleCode, action: PermissionAction) => RequestHandler;
  /**
   * F2 (noc-alerts-config) — app.ts's module-level `auditEventRepo` singleton
   * (the SAME instance `auditMutationsMiddleware` + the audit-events query
   * endpoint already share), injected so `AcknowledgeAlert`'s structured ACK
   * audit writes to the SAME table via the SAME repo instance — not a 2nd
   * `PrismaAuditEventRepository()` wiring path.
   */
  auditEventRepo: AuditEventRepository;
}

/**
 * composeAlertsModule — wires the noc-alerts-hub Fase A module (repo, use-cases,
 * router) in ONE place, OFF app.ts's God Object body (known_debt, design.md
 * "File Changes" ⚠). Keeps the app.ts mount to a single `app.use(...)` call.
 *
 * Publisher = `AlertEventBus` (Fase C, `noc-alert-realtime`) — a SINGLE shared
 * instance wired both as the `AlertEventPublisher` port `IngestAlert`/
 * `AcknowledgeAlert` publish to, AND passed to the router so `GET /stream`
 * subscribes to the SAME bus (design.md "la ruta SSE se suscribe al bus,
 * NUNCA al use-case"). Real-time is NOT gated behind `noc-alerts-telegram-send`
 * — that flag only controls the Fase D OUTBOUND Telegram send; the internal
 * panel/SSE is part of the hub itself and stays lit even while Telegram stays
 * dark (design.md "Flags de convivencia", `noc-alerts-hub-enabled` scopes
 * "Ingesta + persistencia + panel + SSE", separately from `noc-alerts-telegram-send`).
 *

 * `ingestKeys` (F3, fix wave) — `POST /api/alerts/ingest/{source}` (spec.md
 * "Alert ingestion endpoint auth"), each known source keyed by ITS OWN secret
 * so rotating `fiberIngestKey` never forces rotating `grafanaIngestKey` (and
 * vice versa). `grafana` is wired here already even though `GrafanaWebhookSource`
 * (the mapper that turns Grafana's webhook shape into the canonical `NocAlertInput`)
 * is Fase B — until then `/ingest/grafana` accepts the SAME canonical shape as
 * `/ingest/fiber-collector` (the route doesn't know about Grafana's shape yet).
 *
 * `featureFlagRepo` (F5, fix wave) — `PrismaFeatureFlagRepository`, same
 * instance-per-request-cycle pattern as `GetGigaredConfig`/`createGigaredReadyMiddleware`
 * (molde gigared-integration). Backs the `noc-alerts-hub-enabled` kill-switch.
 *
 * `grafanaSource` (Fase B, `noc-alert-grafana-source`) — `GrafanaWebhookSource`
 * maps Grafana Alerting's own webhook shape (`{status, alerts: [...]}`) into
 * the canonical `NocAlertInput`, one call per `alerts[]` element, delegating
 * each to the SAME `IngestAlert` instantiated above. Stateless, no ports to
 * inject — plain `new`.
 *
 * Fase D (`noc-alert-telegram`) — `TelegramBotGateway` (implements the
 * `AlertNotifier` port) replaces the dark `NoOpAlertNotifier` default: it's
 * wired as an `eventBus.subscribe(...)` listener (design.md Data Flow —
 * `AlertEventPublisher(port)` branches into BOTH SSE and Telegram, peers off
 * the SAME publish, not a call chain from `IngestAlert`), so on every
 * `'firing'` event it runs `NotifyAlert` — which checks the
 * `noc-alerts-telegram-send` flag FIRST (default OFF, convivencia) before
 * ever touching the gateway. The subscription is fire-and-forget (`.catch`
 * logs, never throws back into `AlertEventBus.publish`'s synchronous
 * per-listener try/catch, which doesn't await async listeners at all). The
 * SAME `telegramNotifier` instance is also handed to `AcknowledgeAlert` so
 * ACKs from EITHER channel (panel or the `/telegram/webhook` callback) edit
 * the existing Telegram message (spec.md "Acknowledge edits the Telegram
 * message on either channel").
 */
export function composeAlertsModule(deps: ComposeAlertsModuleDeps): Router {
  const repo = new PrismaNocAlertRepository();
  const eventBus = new AlertEventBus();
  const featureFlagRepo = new PrismaFeatureFlagRepository();
  const grafanaSource = new GrafanaWebhookSource();
  const thresholdsRepo = new PrismaNocAlertThresholdsConfigRepository();

  const telegramGateway = new HttpTelegramGateway({ botToken: config.alerts.telegramBotToken });
  const telegramNotifier = new TelegramBotGateway(telegramGateway, config.alerts.telegramChatId);
  const notifyAlert = new NotifyAlert(repo, telegramNotifier, featureFlagRepo);

  eventBus.subscribe((event) => {
    if (event.type !== 'firing') return;
    notifyAlert.execute(event.alert).catch((err) => {
      console.error('[composeAlertsModule] NotifyAlert (Telegram) falló', err);
    });
  });

  return createAlertsRouter({
    ingestAlert: new IngestAlert(repo, eventBus),
    listAlerts: new ListAlerts(repo),
    acknowledgeAlert: new AcknowledgeAlert(repo, eventBus, telegramNotifier, deps.auditEventRepo),
    getAlertThresholds: new GetAlertThresholds(thresholdsRepo),
    updateAlertThresholds: new UpdateAlertThresholds(thresholdsRepo),
    ingestKeys: {
      'fiber-collector': config.alerts.fiberIngestKey,
      grafana: config.alerts.grafanaIngestKey,
    },
    featureFlagRepo,
    grafanaSource,
    eventBus,
    // alerts-ingest-ratelimit (fix) — limiter DEDICADO de ingesta (default
    // 600/60s, config.alerts.ingestRateLimit), NUNCA el default de 30/60s
    // pensado para el API externo (createExternalWriteRateLimiter).
    ingestRateLimiter: createIngestRateLimiter(config.alerts.ingestRateLimit),
    auth: createAuthMiddleware(deps.authAdapter, deps.sessionRepo),
    requirePerm: deps.requirePerm,
    telegramWebhookAuth: createTelegramSecretMiddleware(config.alerts.telegramWebhookSecret),
    telegramGateway,
  });
}
