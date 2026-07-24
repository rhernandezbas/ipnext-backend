import { Router, RequestHandler } from 'express';
import { config } from '@infrastructure/config';
import type { AuthProvider } from '@domain/ports/AuthProvider';
import type { SessionRepository } from '@domain/ports/SessionRepository';
import type { RbacModuleCode, PermissionAction } from '@domain/entities/rbac';
import { IngestAlert } from '@application/use-cases/alerts/IngestAlert';
import { ListAlerts } from '@application/use-cases/alerts/ListAlerts';
import { AcknowledgeAlert } from '@application/use-cases/alerts/AcknowledgeAlert';
import { PrismaNocAlertRepository } from '@infrastructure/adapters/prisma/PrismaNocAlertRepository';
import { PrismaFeatureFlagRepository } from '@infrastructure/adapters/prisma/PrismaFeatureFlagRepository';
import { AlertEventBus } from '@infrastructure/events/AlertEventBus';
import { GrafanaWebhookSource } from '@infrastructure/adapters/grafana/GrafanaWebhookSource';
import { createAlertsRouter } from './routes/alerts.routes';
import { createAuthMiddleware } from './middleware/authMiddleware';

export interface ComposeAlertsModuleDeps {
  authAdapter: AuthProvider;
  sessionRepo: SessionRepository;
  /** app.ts's module-level `requirePerm`, injected — NOT re-derived here (single
   *  rbacUserRepo instance stays the source of truth, avoids a 2nd wiring path). */
  requirePerm: (module: RbacModuleCode, action: PermissionAction) => RequestHandler;
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
 */
export function composeAlertsModule(deps: ComposeAlertsModuleDeps): Router {
  const repo = new PrismaNocAlertRepository();
  const eventBus = new AlertEventBus();
  const featureFlagRepo = new PrismaFeatureFlagRepository();
  const grafanaSource = new GrafanaWebhookSource();

  return createAlertsRouter({
    ingestAlert: new IngestAlert(repo, eventBus),
    listAlerts: new ListAlerts(repo),
    acknowledgeAlert: new AcknowledgeAlert(repo, eventBus),
    ingestKeys: {
      'fiber-collector': config.alerts.fiberIngestKey,
      grafana: config.alerts.grafanaIngestKey,
    },
    featureFlagRepo,
    grafanaSource,
    eventBus,
    auth: createAuthMiddleware(deps.authAdapter, deps.sessionRepo),
    requirePerm: deps.requirePerm,
  });
}
