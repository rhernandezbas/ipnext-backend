import { Router, RequestHandler } from 'express';
import { config } from '@infrastructure/config';
import type { AuthProvider } from '@domain/ports/AuthProvider';
import type { SessionRepository } from '@domain/ports/SessionRepository';
import type { RbacModuleCode, PermissionAction } from '@domain/entities/rbac';
import { IngestAlert } from '@application/use-cases/alerts/IngestAlert';
import { ListAlerts } from '@application/use-cases/alerts/ListAlerts';
import { AcknowledgeAlert } from '@application/use-cases/alerts/AcknowledgeAlert';
import { PrismaNocAlertRepository } from '@infrastructure/adapters/prisma/PrismaNocAlertRepository';
import { NoOpAlertEventPublisher } from '@infrastructure/adapters/in-memory/NoOpAlertEventPublisher';
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
 * Publisher = `NoOpAlertEventPublisher` — Fase A ingestion is dark by design
 * (spec.md "Dark ingestion"); `AlertEventBus`/SSE replaces it in Fase C.
 * `ingestKey` = `config.alerts.fiberIngestKey` — the CANONICAL `/ingest` route is
 * for the fiber-collector's direct POST (design.md "POST /api/alerts/ingest
 * canónico + /ingest/grafana shim"); Grafana's shim endpoint is Fase B.
 */
export function composeAlertsModule(deps: ComposeAlertsModuleDeps): Router {
  const repo = new PrismaNocAlertRepository();
  const publisher = new NoOpAlertEventPublisher();

  return createAlertsRouter({
    ingestAlert: new IngestAlert(repo, publisher),
    listAlerts: new ListAlerts(repo),
    acknowledgeAlert: new AcknowledgeAlert(repo),
    ingestKey: config.alerts.fiberIngestKey,
    auth: createAuthMiddleware(deps.authAdapter, deps.sessionRepo),
    requirePerm: deps.requirePerm,
  });
}
