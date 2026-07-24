/**
 * NocAlert — domain entity for the unified NOC alerts hub (noc-alerts-hub, Fase A).
 *
 * NEW entity, own table — does NOT reuse `MonitoringAlert` (device-céntrico, scaffold
 * roto) nor `Notification` (bandeja genérica). See design.md "Decision: Entidad
 * NocAlert nueva" for the full rationale. Zero external dependencies — no Prisma,
 * no Express, no Node I/O (hexagonal core).
 */

export type NocAlertStatus = 'firing' | 'resolved';
export type NocAlertSeverity = 'critical' | 'warning' | 'info';

/**
 * NocAlert — persisted lifecycle record. Unique per (source, fingerprint).
 */
export interface NocAlert {
  id: string;
  source: string;
  fingerprint: string;

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
  firstSeen: string;
  lastSeen: string;
  endsAt: string | null;
  createdAt: string;
  updatedAt: string;

  acknowledged: boolean;
  ackBy: string | null;
  ackAt: string | null;
  ackNote: string | null;

  /** Fase D+ — nivel de escalado (N1/N2/N3), absorbe olt_watch. No usado en Fase A. */
  escalationState: string | null;

  /** Fase D — para editar el mensaje de Telegram al ackear. No usado en Fase A. */
  telegramChatId: string | null;
  telegramMessageId: string | null;
}

/**
 * NocAlertInput — canonical ingestion contract (compartido BE↔Rust, ver design.md
 * "Contrato de ingesta canónico"). `entity`/`metric` llegan anidados en el wire;
 * se aplanan a columnas en `NocAlert`. `labels` es passthrough opaco de debug —
 * Fase A no lo persiste.
 */
export interface NocAlertInput {
  source: string;
  fingerprint: string;
  status: NocAlertStatus;
  alertname: string;
  severity: NocAlertSeverity;
  entity: {
    type: string;
    name: string;
    ref?: string;
  };
  metric?: {
    name?: string;
    value?: number;
    unit?: string;
  };
  threshold?: number;
  message: string;
  explanation?: string;
  link?: string;
  startsAt: string;
  endsAt?: string;
  labels?: Record<string, unknown>;
}

export class NocAlertNotFoundError extends Error {
  readonly code = 'NOC_ALERT_NOT_FOUND';

  constructor(id: string) {
    super(`NocAlert with id ${id} not found`);
    this.name = 'NocAlertNotFoundError';
  }
}

/**
 * computeNocAlertIngest — PURE function encapsulating the full firing/resolved
 * lifecycle + dedup decision by (source, fingerprint). Both `InMemoryNocAlertRepository`
 * and `PrismaNocAlertRepository` call this SAME function so the business rule lives in
 * ONE place (domain), not duplicated across adapters — the repos are thin persistence
 * translators around it.
 *
 * Rules (design.md "Modelo NocAlert + ciclo de vida" + A6 decisión):
 * - No existing + firing            → creates (`startsAt`, `firstSeen`/`lastSeen` = now).
 * - No existing + resolved (A6)     → creates ANYWAY, `startsAt = endsAt` (default input.endsAt
 *                                      ?? now) + a warning is logged (no descartar silencioso —
 *                                      evita perder señal de un webhook resolved "late").
 * - Existing firing + firing        → upsert in place (no duplicate row), `lastSeen` bumps.
 * - Existing (firing) + resolved    → closes the SAME row (`endsAt` set, `status: resolved`).
 * - Existing resolved + firing      → RESURRECTS the row (status: firing, ack reset,
 *                                      `startsAt`/`endsAt` reset to the new occurrence).
 *
 * `generateId` is injected (not `crypto.randomUUID()` called directly) so the function
 * stays a pure, deterministic unit — trivial to test with a fixed id.
 */
export function computeNocAlertIngest(
  existing: NocAlert | null,
  input: NocAlertInput,
  now: string,
  generateId: () => string,
): NocAlert {
  const shared = {
    source: input.source,
    fingerprint: input.fingerprint,
    alertname: input.alertname,
    severity: input.severity,
    entityType: input.entity.type,
    entityName: input.entity.name,
    entityRef: input.entity.ref ?? null,
    metricName: input.metric?.name ?? null,
    metricValue: input.metric?.value ?? null,
    metricUnit: input.metric?.unit ?? null,
    threshold: input.threshold ?? null,
    message: input.message,
    explanation: input.explanation ?? null,
    link: input.link ?? null,
  };

  if (!existing) {
    if (input.status === 'firing') {
      return {
        id: generateId(),
        ...shared,
        status: 'firing',
        startsAt: input.startsAt,
        firstSeen: now,
        lastSeen: now,
        endsAt: null,
        createdAt: now,
        updatedAt: now,
        acknowledged: false,
        ackBy: null,
        ackAt: null,
        ackNote: null,
        escalationState: null,
        telegramChatId: null,
        telegramMessageId: null,
      };
    }

    // A6 — resolved with no prior firing record: create anyway (do not discard silently).
    // F6 (fix wave): this function stays PURE — no console/I-O here. The caller
    // (adapter: InMemory/PrismaNocAlertRepository) knows `existing === null` and
    // `input.status === 'resolved'` BEFORE calling this function, so it logs the
    // warning itself instead of the domain doing side effects.
    const endsAt = input.endsAt ?? now;
    return {
      id: generateId(),
      ...shared,
      status: 'resolved',
      startsAt: endsAt,
      firstSeen: now,
      lastSeen: now,
      endsAt,
      createdAt: now,
      updatedAt: now,
      acknowledged: false,
      ackBy: null,
      ackAt: null,
      ackNote: null,
      escalationState: null,
      telegramChatId: null,
      telegramMessageId: null,
    };
  }

  if (input.status === 'firing') {
    const resurrecting = existing.status === 'resolved';
    return {
      ...existing,
      ...shared,
      status: 'firing',
      startsAt: resurrecting ? input.startsAt : existing.startsAt,
      lastSeen: now,
      endsAt: resurrecting ? null : existing.endsAt,
      acknowledged: resurrecting ? false : existing.acknowledged,
      ackBy: resurrecting ? null : existing.ackBy,
      ackAt: resurrecting ? null : existing.ackAt,
      ackNote: resurrecting ? null : existing.ackNote,
      // F-D2 (fix wave) — a resurrection is a NEW incident, not a continuation
      // of the one Telegram already has a message for. Reset alongside ACK
      // (same "new occurrence, clean slate" reasoning) so `NotifyAlert`'s
      // F-D1 guard (skip if telegramChatId/telegramMessageId already set)
      // doesn't permanently pin this alert to the PREVIOUS incident's message
      // — without this reset, a resurrected alert would never get notified
      // again.
      telegramChatId: resurrecting ? null : existing.telegramChatId,
      telegramMessageId: resurrecting ? null : existing.telegramMessageId,
      updatedAt: now,
    };
  }

  // status === 'resolved', existing found → close the SAME row.
  return {
    ...existing,
    ...shared,
    status: 'resolved',
    lastSeen: now,
    endsAt: input.endsAt ?? now,
    updatedAt: now,
  };
}
