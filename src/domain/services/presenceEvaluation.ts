import { haversineMeters } from './haversine';
import {
  mapsUrlFor,
  type GeoCoordinate,
  type TeamLocationPoint,
  type TimeWindow,
} from '../entities/team-location-point';

/**
 * presenceEvaluation — el núcleo del veredicto de presencia en sitio. PURO.
 *
 * Recibe puntos, una ventana y umbrales; devuelve un veredicto con TODA su evidencia.
 * No sabe de HTTP, de Prisma ni de IClass.
 *
 * ## La regla que gobierna este archivo
 *
 * Esto produce EVIDENCIA, no acusaciones. Un falso "no estuvo" imputa a una persona real
 * algo que sí hizo. **La asimetría es deliberada**: probar PRESENCIA con un solo punto es
 * válido (el dispositivo estuvo ahí); probar AUSENCIA con un solo punto no lo es.
 *
 * Todo el diseño está sesgado a favor del técnico:
 *
 *  1. Sin puntos en la ventana → `NO_CONCLUYENTE`, JAMÁS "fuera de sitio".
 *  2. Para CONDENAR hace falta un piso de cobertura: mínimo de puntos Y sin huecos de
 *     muestreo grandes dentro de la ventana. Un hueco de 40 minutos es tiempo de sobra
 *     para ir y volver.
 *  3. El punto se elige minimizando la COTA INFERIOR `d − precisión`, no la distancia
 *     cruda: un fix lejano pero impreciso cuyo margen alcanza el domicilio pesa más que
 *     uno cercano y preciso que no lo alcanza.
 *  4. Precisión DESCONOCIDA no puede condenar (sí puede probar presencia).
 *  5. Puntos corruptos (coordenadas no finitas) se descartan, no se propagan como `NaN`
 *     —que comparado con cualquier cosa da `false` y termina condenando—.
 *  6. Sólo cuentan los puntos DE ESA cuadrilla.
 *  7. El veredicto viaja SIEMPRE con su evidencia.
 */

export type PresenceVerdictKind =
  /** Hubo cobertura GPS y el técnico estuvo dentro del umbral del domicilio. */
  | 'EN_SITIO'
  /** Cobertura SUFICIENTE y ningún punto compatible con estar en el domicilio. */
  | 'FUERA_DE_SITIO'
  /** No hay datos suficientes para concluir. NO significa que el técnico no haya ido. */
  | 'NO_CONCLUYENTE'
  /** La orden no admite auditoría (sin domicilio geolocalizado, sin cuadrilla o sin ventana). */
  | 'NO_AUDITABLE';

export interface PresenceEvaluationInput {
  address: GeoCoordinate | null;
  teamLogin: string | null;
  window: TimeWindow | null;
  points: TeamLocationPoint[];
  onSiteThresholdMeters?: number;
  minPointsToCondemn?: number;
  maxCoverageGapMinutes?: number;
}

export interface PresenceEvaluation {
  verdict: PresenceVerdictKind;
  reason: string | null;
  /** Distancia CRUDA del punto elegido, sin descontar precisión. Es evidencia. */
  minDistanceMeters: number | null;
  closestPointAt: Date | null;
  closestAccuracyMeters: number | null;
  /** Puntos VÁLIDOS de esa cuadrilla dentro de la ventana. Mide la solidez del veredicto. */
  pointsEvaluated: number;
  /** Hueco de muestreo más grande dentro de la ventana, en minutos. */
  largestCoverageGapMinutes: number | null;
  window: TimeWindow | null;
  mapsUrl: string | null;
  onSiteThresholdMeters: number;
}

export const PRESENCE_DEFAULTS = {
  onSiteThresholdMeters: 150,
  /** Margen a cada lado de la ventana. Lo consume workWindow. */
  windowMarginMinutes: 15,
  /** Mínimo de puntos para poder emitir un veredicto de AUSENCIA. */
  minPointsToCondemn: 3,
  /**
   * Hueco máximo tolerado entre puntos consecutivos para condenar. Los breadcrumbs llegan
   * cada 5-10 min; un hueco mayor es tiempo sin muestrear, y en ese tiempo el técnico
   * pudo estar en el domicilio.
   */
  maxCoverageGapMinutes: 20,
} as const;

interface EvaluationDefaults {
  threshold: number;
  minPoints: number;
  maxGap: number;
}

const inconclusive = (
  verdict: PresenceVerdictKind,
  reason: string,
  window: TimeWindow | null,
  defaults: EvaluationDefaults,
  pointsEvaluated = 0,
  largestGap: number | null = null,
): PresenceEvaluation => ({
  verdict,
  reason,
  minDistanceMeters: null,
  closestPointAt: null,
  closestAccuracyMeters: null,
  pointsEvaluated,
  largestCoverageGapMinutes: largestGap,
  window,
  mapsUrl: null,
  onSiteThresholdMeters: defaults.threshold,
});

/** Precisión utilizable: finita y no negativa. Cualquier otra cosa es DESCONOCIDA. */
function usableAccuracy(value: number | null): number | null {
  if (value === null || !Number.isFinite(value) || value < 0) return null;
  return value;
}

export function evaluatePresence(input: PresenceEvaluationInput): PresenceEvaluation {
  const defaults: EvaluationDefaults = {
    threshold: input.onSiteThresholdMeters ?? PRESENCE_DEFAULTS.onSiteThresholdMeters,
    minPoints: input.minPointsToCondemn ?? PRESENCE_DEFAULTS.minPointsToCondemn,
    maxGap: input.maxCoverageGapMinutes ?? PRESENCE_DEFAULTS.maxCoverageGapMinutes,
  };

  // --- Imposibilidad estructural: no hay nada que auditar -------------------------
  if (!input.address || !Number.isFinite(input.address.latitude) || !Number.isFinite(input.address.longitude)) {
    return inconclusive('NO_AUDITABLE', 'La orden no tiene domicilio geolocalizado.', input.window, defaults);
  }
  if (input.address.latitude === 0 && input.address.longitude === 0) {
    // "Null Island": coordenada centinela de un domicilio nunca geocodificado. Medirla
    // da ~7.250 km y produciría la condena más demoledora posible sobre un dato vacío.
    return inconclusive(
      'NO_AUDITABLE',
      'El domicilio de la orden tiene coordenadas (0,0), que indican una dirección sin geocodificar.',
      input.window,
      defaults,
    );
  }
  if (!input.teamLogin) {
    return inconclusive('NO_AUDITABLE', 'La orden no tiene cuadrilla asignada.', input.window, defaults);
  }
  if (!input.window) {
    return inconclusive(
      'NO_AUDITABLE',
      'La orden no registra un ciclo de ejecución CERRADO en su histórico de estados, ' +
        'así que no hay una ventana de trabajo acotada contra la cual auditar.',
      null,
      defaults,
    );
  }

  // --- Sólo cuentan los puntos VÁLIDOS, de ESA cuadrilla, DENTRO de la ventana -----
  const from = input.window.from.getTime();
  const to = input.window.to.getTime();
  const inWindow = input.points
    .filter((p) => p.teamLogin === input.teamLogin)
    .filter((p) => Number.isFinite(p.latitude) && Number.isFinite(p.longitude))
    .filter((p) => {
      const t = p.recordedAt.getTime();
      return Number.isFinite(t) && t >= from && t <= to;
    })
    .sort((a, b) => a.recordedAt.getTime() - b.recordedAt.getTime());

  if (inWindow.length === 0) {
    return inconclusive(
      'NO_CONCLUYENTE',
      'No hay registros de ubicación de la cuadrilla en la base para la ventana de trabajo.',
      input.window,
      defaults,
    );
  }

  // --- Punto más compatible con estar en el domicilio -----------------------------
  // Se minimiza la COTA INFERIOR (distancia − precisión), no la distancia cruda: un fix
  // impreciso cuyo círculo de error alcanza el domicilio es mejor evidencia de presencia
  // que uno preciso que no lo alcanza.
  let best = inWindow[0];
  let bestRaw = haversineMeters(input.address.latitude, input.address.longitude, best.latitude, best.longitude);
  let bestBound = bestRaw - (usableAccuracy(best.accuracyMeters) ?? 0);

  for (const candidate of inWindow.slice(1)) {
    const raw = haversineMeters(
      input.address.latitude,
      input.address.longitude,
      candidate.latitude,
      candidate.longitude,
    );
    const bound = raw - (usableAccuracy(candidate.accuracyMeters) ?? 0);
    if (bound < bestBound) {
      best = candidate;
      bestRaw = raw;
      bestBound = bound;
    }
  }

  const evidence = {
    minDistanceMeters: bestRaw,
    closestPointAt: best.recordedAt,
    closestAccuracyMeters: usableAccuracy(best.accuracyMeters),
    pointsEvaluated: inWindow.length,
    window: input.window,
    mapsUrl: mapsUrlFor(best.latitude, best.longitude),
    onSiteThresholdMeters: defaults.threshold,
  };

  const largestGap = largestGapMinutes(inWindow, input.window);

  // --- PRESENCIA: alcanza con un punto compatible ---------------------------------
  if (bestBound <= defaults.threshold) {
    return { verdict: 'EN_SITIO', reason: null, largestCoverageGapMinutes: largestGap, ...evidence };
  }

  // --- AUSENCIA: exige piso de cobertura ------------------------------------------
  // Todo lo de acá abajo existe para que "no encontramos al técnico" no se confunda
  // nunca con "el técnico no fue".

  if (inWindow.length < defaults.minPoints) {
    return inconclusive(
      'NO_CONCLUYENTE',
      `Sólo hay ${inWindow.length} punto(s) en la ventana; se necesitan al menos ` +
        `${defaults.minPoints} para descartar la presencia. La cobertura es insuficiente ` +
        `para concluir que el técnico no estuvo.`,
      input.window,
      defaults,
      inWindow.length,
      largestGap,
    );
  }

  if (largestGap !== null && largestGap > defaults.maxGap) {
    return inconclusive(
      'NO_CONCLUYENTE',
      `Hay un hueco de ${Math.round(largestGap)} minutos sin registros dentro de la ventana ` +
        `(máximo tolerado: ${defaults.maxGap}). En ese lapso el técnico pudo estar en el ` +
        `domicilio sin que quedara registro.`,
      input.window,
      defaults,
      inWindow.length,
      largestGap,
    );
  }

  // Ningún punto con precisión conocida ⇒ no se puede acotar el error ⇒ no se condena.
  if (!inWindow.some((p) => usableAccuracy(p.accuracyMeters) !== null)) {
    return inconclusive(
      'NO_CONCLUYENTE',
      'Ningún registro de la ventana informa su precisión, así que no se puede acotar el ' +
        'margen de error de las mediciones.',
      input.window,
      defaults,
      inWindow.length,
      largestGap,
    );
  }

  return { verdict: 'FUERA_DE_SITIO', reason: null, largestCoverageGapMinutes: largestGap, ...evidence };
}

/**
 * Mayor tramo de la VENTANA sin muestrear, en minutos.
 *
 * Incluye los BORDES a propósito (re-review, R1). Medir sólo entre puntos consecutivos
 * dejaba pasar el caso: ventana 15:00-19:00 con tres puntos a las 18:50/18:55/19:00 daba
 * `largestGap = 5` y CONDENABA, con 3 h 50 min de la ventana sin un solo registro. El
 * piso de cobertura subía el precio de la acusación injusta de 1 punto a 3; no la
 * eliminaba. El hueco relevante no es "entre puntos": es "de la ventana".
 */
function largestGapMinutes(points: TeamLocationPoint[], window: TimeWindow): number | null {
  if (points.length === 0) return null;

  let largest = (points[0].recordedAt.getTime() - window.from.getTime()) / 60_000;

  for (let i = 1; i < points.length; i++) {
    const gap = (points[i].recordedAt.getTime() - points[i - 1].recordedAt.getTime()) / 60_000;
    if (gap > largest) largest = gap;
  }

  const tail = (window.to.getTime() - points[points.length - 1].recordedAt.getTime()) / 60_000;
  if (tail > largest) largest = tail;

  return Math.max(0, largest);
}
