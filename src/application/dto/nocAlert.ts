import { NocAlert, NocAlertSeverity, NocAlertStatus } from '@domain/entities/nocAlert';

/**
 * NocAlertDto — the ONLY shape any `/api/alerts*` route may return (spec.md
 * "DTO output only"). Explicit allow-list: EXCLUDES `fingerprint` (internal dedup
 * key) and `telegramChatId`/`telegramMessageId` (Fase D internals) — never the raw
 * domain entity, never a Prisma row.
 */
export interface NocAlertDto {
  id: string;
  source: string;
  alertname: string;
  severity: NocAlertSeverity;
  status: NocAlertStatus;
  entityType: string;
  entityName: string;
  entityRef: string | null;
  metricName: string | null;
  metricValue: number | null;
  metricUnit: string | null;
  threshold: number | null;
  message: string;
  explanation: string | null;
  link: string | null;
  startsAt: string;
  endsAt: string | null;
  createdAt: string;
  updatedAt: string;
  acknowledged: boolean;
  ackBy: string | null;
  ackAt: string | null;
  ackNote: string | null;
  /** ackAt - startsAt, in seconds. null while un-acked. */
  mttaSeconds: number | null;
}

/**
 * computeMttaSeconds — pure. null while un-acked; otherwise `ackAt - startsAt`
 * in whole seconds. Shared by `toNocAlertDto` so a fresh ack and any later read
 * (ListAlerts) derive the SAME value from the same persisted fields.
 */
export function computeMttaSeconds(startsAt: string, ackAt: string | null): number | null {
  if (!ackAt) return null;
  const startMs = Date.parse(startsAt);
  const ackMs = Date.parse(ackAt);
  // F6 (fix wave) — NaN guard: an invalid date string must not leak a NaN
  // through the DTO (NaN silently breaks any downstream arithmetic/serialization
  // consumer). Clamp guard: clock skew between fuentes could make ackAt < startsAt
  // by a few ms — negative MTTA is nonsensical, clamp to 0 instead of reporting it.
  if (Number.isNaN(startMs) || Number.isNaN(ackMs)) return null;
  const diffMs = ackMs - startMs;
  return Math.max(0, Math.round(diffMs / 1000));
}

/**
 * NocAlertStateDto — Fase 1 (`noc-alerts-level-reconciliation`), proyección
 * MÍNIMA para `GET /api/alerts/ingest/:source/state` (spec.md
 * "Proyección mínima, solo firing, sin envelope"). Deliberadamente MÁS chico
 * que `NocAlertDto`: el colector Rust solo necesita reconciliar por
 * fingerprint+severidad+ACK, nunca `message`/`entity`/`explanation` (esos
 * viajan en el POST de ingesta, no hace falta repetirlos acá).
 */
export interface NocAlertStateDto {
  fingerprint: string;
  severity: NocAlertSeverity;
  startsAt: string;
  acknowledged: boolean;
}

export function toNocAlertStateDto(alert: NocAlert): NocAlertStateDto {
  return {
    fingerprint: alert.fingerprint,
    severity: alert.severity,
    startsAt: alert.startsAt,
    acknowledged: alert.acknowledged,
  };
}

export function toNocAlertDto(alert: NocAlert): NocAlertDto {
  return {
    id: alert.id,
    source: alert.source,
    alertname: alert.alertname,
    severity: alert.severity,
    status: alert.status,
    entityType: alert.entityType,
    entityName: alert.entityName,
    entityRef: alert.entityRef,
    metricName: alert.metricName,
    metricValue: alert.metricValue,
    metricUnit: alert.metricUnit,
    threshold: alert.threshold,
    message: alert.message,
    explanation: alert.explanation,
    link: alert.link,
    startsAt: alert.startsAt,
    endsAt: alert.endsAt,
    createdAt: alert.createdAt,
    updatedAt: alert.updatedAt,
    acknowledged: alert.acknowledged,
    ackBy: alert.ackBy,
    ackAt: alert.ackAt,
    ackNote: alert.ackNote,
    mttaSeconds: computeMttaSeconds(alert.startsAt, alert.ackAt),
  };
}
