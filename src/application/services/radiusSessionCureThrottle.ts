import {
  RadiusSessionCureEventRepository,
  RadiusSessionCureOutcome,
} from '@domain/ports/RadiusSessionCureEventRepository';

/**
 * Throttle anti-spam del REGISTRO de curas RADIUS (radius-session-autocure BE-1, REQ-CURE-4(e)).
 * Molde exacto de `pppoeNasMoveThrottle.ts` (D-W2.2). Un `skipped_*`/`failed`/`flagged_flapping`
 * IDÉNTICO (mismo outcome + mismo reason) del mismo username con menos de 6h NO genera fila
 * nueva. Los `cured` SIEMPRE registran (el caller NUNCA llama a este helper para outcome
 * 'cured'). El manual SIEMPRE registra (el caller NUNCA llama a este helper cuando
 * trigger === 'manual' — REQ-CURE-6). Fail-open: si el check lanza, se registra la fila igual
 * (una fila de más es mejor que una supresión silenciosa).
 */
export const RADIUS_CURE_EVENT_THROTTLE_MS = 6 * 60 * 60 * 1000; // 6 horas

export async function isDuplicateCureEvent(
  repo: RadiusSessionCureEventRepository,
  username: string,
  outcome: RadiusSessionCureOutcome,
  reason: string | null,
  nowMs: number = Date.now(),
): Promise<boolean> {
  try {
    const { items } = await repo.list({ page: 1, limit: 1, usernameExact: username });
    const last = items[0];
    if (!last) return false;
    if (last.outcome !== outcome) return false;
    if ((last.reason ?? null) !== (reason ?? null)) return false;
    const age = nowMs - Date.parse(last.createdAt);
    return Number.isFinite(age) && age < RADIUS_CURE_EVENT_THROTTLE_MS;
  } catch (err) {
    console.warn('[radiusSessionCureThrottle] check del throttle falló — FAIL-OPEN (la fila se registra igual):', err);
    return false;
  }
}
