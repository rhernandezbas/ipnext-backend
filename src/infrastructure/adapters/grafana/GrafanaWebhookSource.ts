import { NocAlertInput, NocAlertSeverity, NocAlertStatus } from '@domain/entities/nocAlert';
import { AlertSource } from '@domain/ports/AlertSource';

/**
 * GrafanaWebhookSource — maps a Grafana Alerting webhook into the canonical
 * `NocAlertInput` shape (design.md "Contrato de ingesta canónico"), delegating
 * ingestion to the SAME `IngestAlert` use-case the fiber-collector already
 * uses. This adapter owns ONLY the Grafana-specific shape knowledge — the
 * use-case never learns Grafana exists (spec.md purpose).
 *
 * Two entry points:
 * - `map(raw, context?)` — maps ONE alert element (`alerts[i]` in Grafana's
 *   webhook body) to a single `NocAlertInput`. Implements the `AlertSource`
 *   port. Throws a descriptive `Error` if the element is malformed
 *   (missing/invalid `fingerprint` or `status`) — caller (`mapWebhook`, or the
 *   route) decides how to turn that into an HTTP response.
 * - `mapWebhook(raw)` — validates + maps the FULL webhook body
 *   (`{status, alerts: [...], commonLabels?}`) into `NocAlertInput[]`, one per
 *   `alerts[]` element (spec.md "Grouped alerts produce N NocAlerts"). Returns
 *   a `string` error message (same convention as `parseIngestBody` in
 *   alerts.routes.ts) if ANY element is malformed — the whole webhook is
 *   rejected atomically, no partial ingestion (spec.md "Malformed payload
 *   rejection").
 */

const VALID_STATUSES: readonly NocAlertStatus[] = ['firing', 'resolved'];
const VALID_SEVERITIES: readonly NocAlertSeverity[] = ['critical', 'warning', 'info'];

/**
 * Go's zero-time value. Grafana Alerting's JSON encoder emits this for
 * `EndsAt` on alerts that have never resolved (i.e. still `firing`) instead of
 * omitting the field — a well-known Grafana quirk. Treated identically to
 * "endsAt not sent".
 */
const GRAFANA_ZERO_TIME = '0001-01-01T00:00:00Z';

/**
 * Label names that may carry the affected entity, in priority order (first
 * present wins). `routerboard_name`/`nombre`/`equipo` are MikroTik-flavoured
 * aliases used across the 36 rules on the .37 Grafana instance (ver skill
 * `grafana-ipnext`/`master-mikrotik`); `router` is the label documented in
 * spec.md "Label and annotation mapping"; `instance`/`network` are the
 * Prometheus/exporter-standard fallbacks.
 */
const ENTITY_LABEL_PRIORITY: ReadonlyArray<{ label: string; entityType: string }> = [
  { label: 'routerboard_name', entityType: 'router' },
  { label: 'router', entityType: 'router' },
  { label: 'nombre', entityType: 'router' },
  { label: 'equipo', entityType: 'router' },
  { label: 'instance', entityType: 'instance' },
  { label: 'network', entityType: 'network' },
];

/**
 * Alertname substrings (case/accent-insensitive) that infer a severity when
 * Grafana doesn't send `labels.severity` — task instruction: "crítico:
 * rectificador/telemetría-ciega/router-caído; warning: cpu/memoria/saturación".
 * Order matters: critical is checked first so an alertname matching both
 * lists (unlikely, but defensive) leans critical.
 */
const CRITICAL_ALERTNAME_KEYWORDS = ['rectificador', 'telemetria-ciega', 'telemetriaciega', 'router-caido', 'routercaido'];
const WARNING_ALERTNAME_KEYWORDS = ['cpu', 'memoria', 'saturacion'];

function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip combining diacritics (accents)
    .toLowerCase();
}

function inferSeverity(alertname: string): NocAlertSeverity {
  const n = normalize(alertname);
  if (CRITICAL_ALERTNAME_KEYWORDS.some((kw) => n.includes(kw))) return 'critical';
  if (WARNING_ALERTNAME_KEYWORDS.some((kw) => n.includes(kw))) return 'warning';
  // Decision: default to 'warning' (not 'critical') when nothing matches —
  // a Grafana rule someone forgot to label shouldn't silently page as critical.
  return 'warning';
}

function resolveEntity(labels: Record<string, string>): { type: string; name: string } {
  for (const { label, entityType } of ENTITY_LABEL_PRIORITY) {
    const value = labels[label];
    if (typeof value === 'string' && value) {
      return { type: entityType, name: value };
    }
  }
  return { type: 'unknown', name: 'unknown' };
}

function isZeroOrUnset(endsAt: unknown): boolean {
  return endsAt === undefined || endsAt === null || endsAt === '' || endsAt === GRAFANA_ZERO_TIME;
}

interface MapContext {
  commonLabels?: Record<string, string>;
}

export class GrafanaWebhookSource implements AlertSource {
  /**
   * `AlertSource.map` — port signature takes `raw: unknown`. Grafana's webhook
   * shape needs webhook-level context (`commonLabels`) for grouped alerts that
   * omit `labels.alertname` on the individual element — passed as an optional
   * second arg (not part of the port contract, only `mapWebhook` uses it).
   */
  map(raw: unknown, context: MapContext = {}): NocAlertInput {
    const a = (raw ?? {}) as Record<string, unknown>;

    const status = a['status'];
    if (typeof status !== 'string' || !VALID_STATUSES.includes(status as NocAlertStatus)) {
      throw new Error(`GrafanaWebhookSource: invalid or missing status: ${JSON.stringify(status)}`);
    }

    const fingerprint = a['fingerprint'];
    if (typeof fingerprint !== 'string' || !fingerprint) {
      throw new Error('GrafanaWebhookSource: missing fingerprint on alert element');
    }

    const labels = ((a['labels'] as Record<string, string> | undefined) ?? {}) as Record<string, string>;
    const annotations = ((a['annotations'] as Record<string, string> | undefined) ?? {}) as Record<string, string>;

    const alertname = labels['alertname'] ?? context.commonLabels?.['alertname'];
    if (!alertname) {
      throw new Error('GrafanaWebhookSource: missing labels.alertname (and no commonLabels.alertname fallback)');
    }

    const severity: NocAlertSeverity =
      typeof labels['severity'] === 'string' && VALID_SEVERITIES.includes(labels['severity'] as NocAlertSeverity)
        ? (labels['severity'] as NocAlertSeverity)
        : inferSeverity(alertname);

    const entity = resolveEntity(labels);

    const message = annotations['description'] ?? annotations['summary'] ?? alertname;
    const explanation = annotations['runbook_url'];
    const link = typeof a['generatorURL'] === 'string' ? (a['generatorURL'] as string) : undefined;

    const startsAtRaw = a['startsAt'];
    const startsAt =
      typeof startsAtRaw === 'string' && !Number.isNaN(Date.parse(startsAtRaw)) ? startsAtRaw : new Date().toISOString();

    const input: NocAlertInput = {
      source: 'grafana',
      fingerprint,
      status: status as NocAlertStatus,
      alertname,
      severity,
      entity,
      message,
      startsAt,
      ...(explanation ? { explanation } : {}),
      ...(link ? { link } : {}),
    };

    // OJO (F1 fix wave finding): alerts.routes.ts's date validator rejects an
    // explicit `endsAt: null` → 400. On `firing` we must NOT emit the `endsAt`
    // key at all — not even `undefined` — and Grafana's zero-time quirk on
    // firing alerts is treated exactly like "not sent".
    if (status === 'resolved') {
      const endsAtRaw = a['endsAt'];
      const endsAt =
        !isZeroOrUnset(endsAtRaw) && typeof endsAtRaw === 'string' && !Number.isNaN(Date.parse(endsAtRaw))
          ? endsAtRaw
          : new Date().toISOString();
      return { ...input, endsAt };
    }

    return input;
  }

  /**
   * mapWebhook — validates + maps the FULL Grafana webhook body. Returns the
   * mapped `NocAlertInput[]` (one per `alerts[]` element) on success, or a
   * `string` error message if the payload doesn't meet the minimal expected
   * shape (spec.md "Malformed payload rejection") — the whole webhook is
   * rejected atomically, mirroring `parseIngestBody`'s return convention in
   * alerts.routes.ts so the route can branch on `typeof result === 'string'`.
   */
  mapWebhook(raw: unknown): NocAlertInput[] | string {
    const body = (raw ?? {}) as Record<string, unknown>;
    const alertsRaw = body['alerts'];

    if (!Array.isArray(alertsRaw) || alertsRaw.length === 0) {
      return 'Missing or empty "alerts" array in Grafana webhook payload';
    }

    const commonLabels = (body['commonLabels'] as Record<string, string> | undefined) ?? undefined;
    const context: MapContext = commonLabels ? { commonLabels } : {};

    const mapped: NocAlertInput[] = [];
    for (let i = 0; i < alertsRaw.length; i++) {
      try {
        mapped.push(this.map(alertsRaw[i], context));
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return `Malformed Grafana alert at alerts[${i}]: ${reason}`;
      }
    }

    return mapped;
  }
}
