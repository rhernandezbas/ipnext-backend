import { createHash } from 'crypto';
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
 *   (missing/invalid `status`, or missing `alertname`) — caller (`mapWebhook`,
 *   or the route) decides how to turn that into an HTTP response.
 *   `fingerprint` is NO LONGER required (F-B4, fix wave): if Grafana doesn't
 *   send one, a stable one is derived from `alertname` + sorted labels.
 * - `mapWebhook(raw)` — validates + maps the FULL webhook body
 *   (`{status, alerts: [...], commonLabels?}`) into per-element results
 *   (spec.md "Grouped alerts produce N NocAlerts"). Returns a `string` error
 *   message (same convention as `parseIngestBody` in alerts.routes.ts) ONLY
 *   when the SOBRE itself is malformed (missing/empty `alerts` array) — an
 *   individual malformed element no longer rejects the whole webhook (F-B3,
 *   fix wave): it's skipped and reported, the valid siblings still ingest.
 */

const VALID_STATUSES: readonly NocAlertStatus[] = ['firing', 'resolved'];

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
 * F-B1 (fix wave, HIGH — under-paging). Alertname substrings that infer a
 * severity when Grafana doesn't send a recognizable `labels.severity`.
 * Checked against `normalize(alertname)` (accents stripped, lowercased, ALL
 * separators — spaces/hyphens/underscores — collapsed out), so
 * "Router Caído", "router-caido" and "RouterCaido" all match identically.
 *
 * Vocabulary widened to the REAL alertname families on the .37 Grafana
 * instance (36 rules — ver skill `grafana-ipnext`). Order matters: CRITICAL is
 * checked first, so an alertname that would match both lists (defensive only
 * — no known real case) leans critical. Default (no match) is 'warning', NEVER
 * 'critical' — a rule someone forgot to label shouldn't silently page as
 * critical (under-paging is the failure we're fixing here, but SILENTLY
 * OVER-paging on unknown/misspelled rules is a worse failure mode).
 *
 * OJO — ambiguity guard: "Batería descargándose" (warning) vs "ALGCom en
 * batería" / "Bus DC bajo 24V" (critical). We do NOT use a bare "bateria"
 * critical keyword — the critical entries are the specific device/bus tokens
 * ("algcom", "busdcalto", "busdcbajo") so a generic "bateria" warning keyword
 * can safely exist without colliding (critical list is checked, and returns,
 * before the warning list is ever consulted).
 */
const CRITICAL_ALERTNAME_KEYWORDS = [
  'rectificadoroffline',
  'rectificadorsinac',
  'alarmacriticarectificador',
  'routercaido',
  'routeroffline',
  'routersinmetricas',
  'telemetriaciega',
  'carpetbombing',
  'clientecgnatcomprometido',
  'bgpsessioncaida',
  'bgppeercaido',
  'bgppeerdown',
  'busdcalto',
  'busdcbajo',
  'monitordeenergiaoffline',
  'algcom',
];
const WARNING_ALERTNAME_KEYWORDS = [
  'cpu',
  'memoria',
  'errores',
  'drops',
  'rectificador',
  'saturacion',
  'down',
  'bateria',
];

/**
 * F-B1 — vocabulary Prometheus/Grafana actually sends in `labels.severity`,
 * mapped onto our 3 canonical levels. `labels.severity` GANA over the
 * alertname inference when it's present and maps to something known — an
 * unrecognized value (e.g. a typo) falls through to alertname inference
 * instead of blindly trusting garbage.
 */
const SEVERITY_LABEL_TO_CRITICAL = new Set(['critical', 'crit', 'error', 'page', 'p1', 'p2']);
const SEVERITY_LABEL_TO_WARNING = new Set(['warning', 'warn', 'p3']);
const SEVERITY_LABEL_TO_INFO = new Set(['info', 'none']);

/**
 * normalize — accent/case/separator-insensitive canonical form. Strips
 * combining diacritics (NFD decomposition) and collapses ALL of
 * spaces/hyphens/underscores away entirely, so "Router Caído",
 * "router-caido", "router_caido" and "RouterCaido" all normalize to the exact
 * same string ("routercaido"). Non-letter noise (emoji, digits, punctuation
 * like "/") is left in place — it never breaks a `.includes()` substring
 * match, which is all this is used for.
 */
function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip combining diacritics (accents)
    .toLowerCase()
    .replace(/[\s\-_]+/g, ''); // collapse separators — unify pegado/con-guión/con-espacio
}

function inferSeverityFromAlertname(alertname: string): NocAlertSeverity {
  const n = normalize(alertname);
  if (CRITICAL_ALERTNAME_KEYWORDS.some((kw) => n.includes(kw))) return 'critical';
  if (WARNING_ALERTNAME_KEYWORDS.some((kw) => n.includes(kw))) return 'warning';
  // Decision: default to 'warning' (not 'critical') when nothing matches —
  // a Grafana rule someone forgot to label shouldn't silently page as critical.
  return 'warning';
}

/** F-B1 — maps `labels.severity` to our 3 levels; `undefined` if absent/unrecognized. */
function mapExplicitSeverity(raw: unknown): NocAlertSeverity | undefined {
  if (typeof raw !== 'string' || !raw) return undefined;
  const n = normalize(raw);
  if (SEVERITY_LABEL_TO_CRITICAL.has(n)) return 'critical';
  if (SEVERITY_LABEL_TO_WARNING.has(n)) return 'warning';
  if (SEVERITY_LABEL_TO_INFO.has(n)) return 'info';
  return undefined;
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

/**
 * F-B4 (fix wave, MEDIUM) — stable, deterministic fingerprint derived from
 * `alertname` + labels when Grafana doesn't send one (legacy Grafana on the
 * .37 may not — PENDING to confirm, see fix-wave report). Same input → same
 * fingerprint, always: labels are sorted by key before hashing so key
 * insertion order in the JSON payload can't change the result. Prefixed
 * `derived:` so it's visually distinguishable from a real Grafana fingerprint
 * in logs/DB — never collides with one (Grafana's are opaque hex, ours carry
 * the prefix).
 */
function deriveFingerprint(alertname: string, labels: Record<string, string>): string {
  const sortedLabels = Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k]}`)
    .join('|');
  const basis = `${alertname}::${sortedLabels}`;
  const hash = createHash('sha1').update(basis).digest('hex').slice(0, 16);
  return `derived:${hash}`;
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

    const labels = ((a['labels'] as Record<string, string> | undefined) ?? {}) as Record<string, string>;
    const annotations = ((a['annotations'] as Record<string, string> | undefined) ?? {}) as Record<string, string>;

    const alertname = labels['alertname'] ?? context.commonLabels?.['alertname'];
    if (!alertname) {
      throw new Error('GrafanaWebhookSource: missing labels.alertname (and no commonLabels.alertname fallback)');
    }

    // F-B4 — fingerprint is now OPTIONAL: use Grafana's if present, otherwise
    // derive a stable one from alertname + labels so a legacy Grafana that
    // never sends `fingerprint` doesn't take down the whole ingestion.
    const fingerprintRaw = a['fingerprint'];
    const fingerprint =
      typeof fingerprintRaw === 'string' && fingerprintRaw ? fingerprintRaw : deriveFingerprint(alertname, labels);

    // F-B1 — labels.severity GANA sobre la inferencia por alertname cuando
    // está presente Y mapea a un nivel conocido.
    const severity: NocAlertSeverity = mapExplicitSeverity(labels['severity']) ?? inferSeverityFromAlertname(alertname);

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

    // OJO (F1 fix wave finding, Fase A): alerts.routes.ts's date validator
    // rejects an explicit `endsAt: null` → 400. On `firing` we must NOT emit
    // the `endsAt` key at all — not even `undefined` — and Grafana's
    // zero-time quirk on firing alerts is treated exactly like "not sent".
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
   * mapWebhook — validates + maps the FULL Grafana webhook body.
   *
   * Returns a `string` error message ONLY when the SOBRE itself doesn't meet
   * the minimal expected shape (missing/empty `alerts` array) — that's the
   * one case that still rejects everything, since there's nothing to
   * partially process.
   *
   * Otherwise returns `{ mapped, skipped }`: `mapped` holds every element
   * that mapped successfully (with its original `alerts[]` index preserved,
   * for per-element result reporting in the route — F-B2/F-B3), `skipped`
   * holds the ones that didn't (malformed `status`, missing `alertname`),
   * each with its index + reason. A malformed element no longer takes its
   * valid siblings down with it (F-B3, fix wave) — "no perder alertas de red
   * buenas por una hermana ruidosa".
   */
  mapWebhook(raw: unknown): GrafanaMapWebhookResult | string {
    const body = (raw ?? {}) as Record<string, unknown>;
    const alertsRaw = body['alerts'];

    if (!Array.isArray(alertsRaw) || alertsRaw.length === 0) {
      return 'Missing or empty "alerts" array in Grafana webhook payload';
    }

    const commonLabels = (body['commonLabels'] as Record<string, string> | undefined) ?? undefined;
    const context: MapContext = commonLabels ? { commonLabels } : {};

    const mapped: GrafanaMappedElement[] = [];
    const skipped: GrafanaSkippedElement[] = [];
    for (let i = 0; i < alertsRaw.length; i++) {
      try {
        mapped.push({ index: i, input: this.map(alertsRaw[i], context) });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        skipped.push({ index: i, reason });
      }
    }

    return { mapped, skipped };
  }
}

/** F-B3 — one successfully-mapped `alerts[]` element, original index preserved. */
export interface GrafanaMappedElement {
  index: number;
  input: NocAlertInput;
}

/** F-B3 — one `alerts[]` element that failed to map, with why. */
export interface GrafanaSkippedElement {
  index: number;
  reason: string;
}

export interface GrafanaMapWebhookResult {
  mapped: GrafanaMappedElement[];
  skipped: GrafanaSkippedElement[];
}
