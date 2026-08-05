import type { UsageSession } from '@domain/ports/UsageMetricsReader';
import { ARGENTINA_UTC_OFFSET_HOURS, toArgentinaDateKey } from '@application/use-cases/messaging/reportsTimezone';

/**
 * portal-usage-metrics (fix C1) — ESTIMACIÓN por solapamiento del consumo de un
 * período. Es LA función que decide el número que ve el cliente, y es UNA sola a
 * propósito: la comparten el camino de prod (`PrismaUsageMetricsReader` trae las
 * sesiones crudas) y el gemelo in-memory — la clase de bug "el test certifica la
 * canónica y prod corre la otra" queda estructuralmente cerrada.
 *
 * El problema que resuelve: el ingest guarda UNA fila por sesión con contadores
 * ACUMULADOS y `startedAt` fijo. Una sesión always-on que nació en julio y sigue
 * viva en agosto trae en sus contadores TODO su tráfico histórico — atribuirlo
 * entero a agosto lo infla, y excluir la sesión (el bug C1) muestra 0. No hay
 * forma exacta de saber cuánto de ese acumulado pasó dentro del mes sin otro
 * modelo de datos (los deltas entre interims), así que se ESTIMA:
 *
 *  1. FRACCIÓN TEMPORAL: al período se le atribuye
 *     `bytes_acumulados × (duración_solapada / duración_total_de_la_sesión)`.
 *     Sesión viva: la duración corre hasta `to` (= ahora); cerrada: hasta
 *     `stoppedAt`. Una sesión 100% contenida en el período → fracción 1 →
 *     números EXACTOS, como siempre.
 *  2. REPARTO DIARIO UNIFORME: los bytes del período se distribuyen parejo entre
 *     los días LOCALES (AR, UTC-3) en que la sesión estuvo viva dentro del
 *     período. Es una estimación DOCUMENTADA — asume tráfico constante; con los
 *     eventos `interim` se podría prorratear de verdad, pero es otra query y
 *     otro modelo. El resto de la división entera se reparte de a 1 byte a los
 *     primeros días para que la suma de los daily sea EXACTAMENTE el total del
 *     período (el número grande se suma DESDE los daily).
 *  3. `approximate`: `true` si ALGUNA sesión aportó con fracción < 1 — la app
 *     muestra "aproximado". Todo exacto → `false`.
 *
 * La aritmética de bytes es BigInt puro (`acumulado × solapadaMs / totalMs`, con
 * truncado): sin doubles en el medio, el resultado es determinístico.
 *
 * Caso borde documentado: una sesión DEGENERADA (stop con `stoppedAt` ==
 * `startedAt`, duración 0) no tiene duración que prorratear — si su instante cae
 * dentro del período cuenta ENTERA en su día (fracción 1, sin división por 0);
 * si no, se descarta.
 */

export interface ProratedUsageBucket {
  downloadBytes: bigint;
  uploadBytes: bigint;
}

export interface ProratedUsage {
  /** Bytes del período por día local AR (`YYYY-MM-DD`). Solo días tocados por alguna sesión. */
  daily: Map<string, ProratedUsageBucket>;
  /** `true` si algún aporte fue prorrateado (fracción < 1): el total es una estimación. */
  approximate: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const OFFSET_MS = ARGENTINA_UTC_OFFSET_HOURS * 60 * 60 * 1000;

export function prorateUsageSessions(
  sessions: UsageSession[],
  window: { from: Date; to: Date },
): ProratedUsage {
  const fromMs = window.from.getTime();
  const toMs = window.to.getTime();
  const daily = new Map<string, ProratedUsageBucket>();
  let approximate = false;

  for (const s of sessions) {
    const startMs = s.startedAt.getTime();
    // Sesión viva: corre hasta `to` (= ahora). El max defiende contra basura
    // (stoppedAt < startedAt): la trata como degenerada, no como negativa.
    const endMs = Math.max(s.stoppedAt ? s.stoppedAt.getTime() : toMs, startMs);
    const totalMs = endMs - startMs;

    let downloadBytes: bigint;
    let uploadBytes: bigint;
    let aliveFromMs: number;
    let aliveToMs: number;

    if (totalMs <= 0) {
      // Degenerada: cuenta entera si su instante cae en [from, to).
      if (startMs < fromMs || startMs >= toMs) continue;
      downloadBytes = s.downloadBytes;
      uploadBytes = s.uploadBytes;
      aliveFromMs = startMs;
      aliveToMs = startMs;
    } else {
      const overlapStart = Math.max(startMs, fromMs);
      const overlapEnd = Math.min(endMs, toMs);
      const overlapMs = overlapEnd - overlapStart;
      if (overlapMs <= 0) continue; // borde exacto (p.ej. stoppedAt == from): nada que atribuir
      downloadBytes = (s.downloadBytes * BigInt(overlapMs)) / BigInt(totalMs);
      uploadBytes = (s.uploadBytes * BigInt(overlapMs)) / BigInt(totalMs);
      if (overlapMs < totalMs) approximate = true;
      aliveFromMs = overlapStart;
      aliveToMs = overlapEnd;
    }

    spreadUniformly(daily, argentinaDayKeysBetween(aliveFromMs, aliveToMs), downloadBytes, uploadBytes);
  }

  return { daily, approximate };
}

/** Índice de día LOCAL AR (UTC-3 fijo) de un instante epoch-ms. */
function argentinaDayIndex(ms: number): number {
  return Math.floor((ms + OFFSET_MS) / DAY_MS);
}

/** Los días locales AR tocados por `[startMs, endMs]`, como `YYYY-MM-DD`, en orden. */
function argentinaDayKeysBetween(startMs: number, endMs: number): string[] {
  const keys: string[] = [];
  for (let d = argentinaDayIndex(startMs); d <= argentinaDayIndex(endMs); d++) {
    // Mediodía LOCAL del día `d` expresado en UTC — bien adentro del día, a
    // salvo de bordes. La clave la arma `toArgentinaDateKey`, la única fuente
    // de verdad del bucketing por día del proyecto.
    keys.push(toArgentinaDateKey(new Date(d * DAY_MS - OFFSET_MS + DAY_MS / 2).toISOString()));
  }
  return keys;
}

/**
 * Reparte `downloadBytes`/`uploadBytes` uniforme entre `days`, acumulando sobre
 * `daily`. El resto de la división entera va de a 1 byte a los primeros días:
 * la suma de lo repartido es EXACTAMENTE lo recibido.
 */
function spreadUniformly(
  daily: Map<string, ProratedUsageBucket>,
  days: string[],
  downloadBytes: bigint,
  uploadBytes: bigint,
): void {
  const n = BigInt(days.length);
  const downQ = downloadBytes / n;
  const downR = downloadBytes % n;
  const upQ = uploadBytes / n;
  const upR = uploadBytes % n;

  days.forEach((date, i) => {
    const bucket = daily.get(date) ?? { downloadBytes: 0n, uploadBytes: 0n };
    daily.set(date, {
      downloadBytes: bucket.downloadBytes + downQ + (BigInt(i) < downR ? 1n : 0n),
      uploadBytes: bucket.uploadBytes + upQ + (BigInt(i) < upR ? 1n : 0n),
    });
  });
}
