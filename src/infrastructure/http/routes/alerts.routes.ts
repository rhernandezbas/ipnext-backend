import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { IngestAlert } from '@application/use-cases/alerts/IngestAlert';
import { ListAlerts } from '@application/use-cases/alerts/ListAlerts';
import { AcknowledgeAlert } from '@application/use-cases/alerts/AcknowledgeAlert';
import { toNocAlertDto } from '@application/dto/nocAlert';
import { NocAlertInput, NocAlertSeverity, NocAlertStatus } from '@domain/entities/nocAlert';
import { NocAlertListFilters } from '@domain/ports/NocAlertRepository';
import { createApiKeyMiddleware } from '../middleware/apiKeyMiddleware';
import type { RbacModuleCode, PermissionAction } from '@domain/entities/rbac';

/** Factory matching `requirePerm` exported from app.ts (DIP-clean injection, molde accessPoints.routes). */
type RequirePerm = (module: RbacModuleCode, action: PermissionAction) => RequestHandler;

const VALID_SEVERITIES: readonly NocAlertSeverity[] = ['critical', 'warning', 'info'];
const VALID_STATUSES: readonly NocAlertStatus[] = ['firing', 'resolved'];

export interface AlertsRouterDeps {
  ingestAlert: IngestAlert;
  listAlerts: ListAlerts;
  acknowledgeAlert: AcknowledgeAlert;
  /** apiKeyMiddleware key guarding POST /ingest (fiberIngestKey — canonical, machine-to-machine). */
  ingestKey: string;
  /** Session auth (`createAuthMiddleware(...)`) applied to the RBAC-guarded routes ONLY. */
  auth: RequestHandler;
  requirePerm: RequirePerm;
}

/**
 * Validates + flattens the raw ingest body into `NocAlertInput`. Returns a
 * string error message on failure (400 territory), or the input on success.
 * Fase A keeps this intentionally light — `GrafanaWebhookSource` (Fase B) owns
 * the richer per-fuente mapping/validation for the `/ingest/grafana` shim.
 */
function parseIngestBody(body: unknown): NocAlertInput | string {
  const b = (body ?? {}) as Record<string, unknown>;
  const missing: string[] = [];
  if (typeof b['source'] !== 'string' || !b['source']) missing.push('source');
  if (typeof b['fingerprint'] !== 'string' || !b['fingerprint']) missing.push('fingerprint');
  if (typeof b['status'] !== 'string' || !VALID_STATUSES.includes(b['status'] as NocAlertStatus)) missing.push('status');
  if (typeof b['alertname'] !== 'string' || !b['alertname']) missing.push('alertname');
  if (typeof b['severity'] !== 'string' || !VALID_SEVERITIES.includes(b['severity'] as NocAlertSeverity)) missing.push('severity');
  if (typeof b['message'] !== 'string' || !b['message']) missing.push('message');
  if (typeof b['startsAt'] !== 'string' || !b['startsAt']) missing.push('startsAt');
  const entity = b['entity'] as Record<string, unknown> | undefined;
  if (!entity || typeof entity['type'] !== 'string' || typeof entity['name'] !== 'string') {
    missing.push('entity.type/entity.name');
  }
  if (missing.length > 0) {
    return `Missing or invalid required fields: ${missing.join(', ')}`;
  }

  const metric = b['metric'] as Record<string, unknown> | undefined;
  return {
    source: b['source'] as string,
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
    ...(metric ? { metric: { name: metric['name'] as string | undefined, value: metric['value'] as number | undefined, unit: metric['unit'] as string | undefined } } : {}),
    ...(typeof b['threshold'] === 'number' ? { threshold: b['threshold'] as number } : {}),
    message: b['message'] as string,
    ...(typeof b['explanation'] === 'string' ? { explanation: b['explanation'] as string } : {}),
    ...(typeof b['link'] === 'string' ? { link: b['link'] as string } : {}),
    startsAt: b['startsAt'] as string,
    ...(typeof b['endsAt'] === 'string' ? { endsAt: b['endsAt'] as string } : {}),
  };
}

export function createAlertsRouter(deps: AlertsRouterDeps): Router {
  const { ingestAlert, listAlerts, acknowledgeAlert, ingestKey, auth, requirePerm } = deps;
  const router = Router();

  const ingestAuth = createApiKeyMiddleware(ingestKey);
  const readPerm = requirePerm('monitoring', 'read');
  const ackPerm = requirePerm('monitoring', 'acknowledge_alert');

  // POST /ingest — canonical ingestion (fiber-collector, direct). Machine-to-machine,
  // no RBAC, no req.user (spec.md "Alert ingestion endpoint auth").
  router.post('/ingest', ingestAuth, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = parseIngestBody(req.body);
      if (typeof parsed === 'string') {
        res.status(400).json({ error: parsed, code: 'VALIDATION_ERROR' });
        return;
      }
      const alert = await ingestAlert.execute(parsed);
      res.status(201).json(toNocAlertDto(alert));
    } catch (err) {
      next(err);
    }
  });

  // GET / — filtered list, monitoring.read.
  router.get('/', auth, readPerm, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const q = req.query as Record<string, string>;
      const filters: NocAlertListFilters = {};
      if (typeof q['source'] === 'string') filters.source = q['source'];
      if (typeof q['severity'] === 'string' && VALID_SEVERITIES.includes(q['severity'] as NocAlertSeverity)) {
        filters.severity = q['severity'] as NocAlertSeverity;
      }
      if (typeof q['status'] === 'string' && VALID_STATUSES.includes(q['status'] as NocAlertStatus)) {
        filters.status = q['status'] as NocAlertStatus;
      }
      const alerts = await listAlerts.execute(filters);
      res.json({ data: alerts.map(toNocAlertDto) });
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
        const alert = await acknowledgeAlert.execute(req.params['id'] as string, by, new Date().toISOString(), note);
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

  return router;
}
