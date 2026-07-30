/**
 * gigared-tv-cic-reuse (T3.2) — mapeo HTTP de los errores nuevos del alta.
 *
 * Se ejercita `sendGigaredError` directamente con un `res` falso: el mapeo código→status es
 * el contrato de wire con el frontend y merece un test propio, no quedar sólo ejercitado
 * de refilón end-to-end (fue justamente lo que pasó con `TvPoolPoisonedError`, cuyo branch
 * quedó sin test standalone).
 *
 * El requisito ERR-1.3 del spec es el que importa: NINGÚN camino del alta puede terminar en
 * un 404 "Gigared account not found". Ese era el bug reportado.
 */
import { sendGigaredError } from '@infrastructure/http/routes/gigared.routes';
import {
  TvPoolUnavailableError,
  TvNoUsableCicError,
  TvPoolPoisonedError,
  NoCicAvailableError,
} from '@domain/errors/gigared';

function fakeRes() {
  const res = {
    statusCode: 0 as number,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      return res;
    },
  };
  return res;
}

describe('gigared-tv-cic-reuse T3.2 — sendGigaredError', () => {
  it('TvPoolUnavailableError → 503 TV_POOL_UNAVAILABLE (transitorio, reintentable)', () => {
    const res = fakeRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handled = sendGigaredError(res as any, new TvPoolUnavailableError('timeout'));

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({ code: 'TV_POOL_UNAVAILABLE' });
  });

  it('TvNoUsableCicError → 422 TV_NO_USABLE_CIC, expone attemptedCount', () => {
    const res = fakeRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handled = sendGigaredError(res as any, new TvNoUsableCicError(3));

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(422);
    expect(res.body).toMatchObject({ code: 'TV_NO_USABLE_CIC', attemptedCount: 3 });
  });

  it('los errores de pool preexistentes NO cambian de status (no-regresión)', () => {
    const poisoned = fakeRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sendGigaredError(poisoned as any, new TvPoolPoisonedError(9));
    expect(poisoned.statusCode).toBe(422);
    expect(poisoned.body).toMatchObject({ code: 'TV_POOL_POISONED', poisonedCount: 9 });

    const empty = fakeRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sendGigaredError(empty as any, new NoCicAvailableError());
    expect(empty.statusCode).toBe(422);
    expect(empty.body).toMatchObject({ code: 'NO_CIC_AVAILABLE' });
  });

  it('ERR-1.3 — ninguno de los errores del alta mapea a 404', () => {
    for (const err of [
      new TvPoolUnavailableError(),
      new TvNoUsableCicError(3),
      new TvPoolPoisonedError(9),
      new NoCicAvailableError(),
    ]) {
      const res = fakeRes();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sendGigaredError(res as any, err);
      expect(res.statusCode).not.toBe(404);
    }
  });

  it('un error ajeno NO lo maneja (devuelve false, no escribe la respuesta)', () => {
    const res = fakeRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handled = sendGigaredError(res as any, new Error('boom'));
    expect(handled).toBe(false);
    expect(res.statusCode).toBe(0);
  });
});
