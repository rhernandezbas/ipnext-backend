/**
 * Helpers del sweep sistémico de handlers async (fix/async-error-sweep).
 *
 * El bug: en Express 4 (sin express-async-errors) un `throw err;` dentro de un
 * handler async NO pasa por next() → jamás llega al errorHandler global → la
 * request queda COLGADA y el proxy la corta a ~60s (504). El fallback correcto
 * de todo catch en un handler async es `next(err)`.
 *
 * Estos helpers arman el escenario "error de infraestructura NO mapeado inline"
 * (p. ej. Prisma caído): el use case rechaza con un Error genérico y el test
 * exige respuesta INMEDIATA (500 INTERNAL_ERROR via errorHandler global). En
 * rojo (pre-sweep) la carrera la gana el timer → el test falla con "COLGADA".
 */
import type { Response as SupertestResponse, Test } from 'supertest';
import type { RequestHandler } from 'express';
import type { AuthProvider } from '@domain/ports/AuthProvider';

/**
 * Use case cuyo execute() rechaza con un error de infra NO tipado (no es
 * DomainError, no está mapeado inline en ningún handler). Tipado `never` para
 * poder inyectarlo en cualquier firma de factory sin importar ~40 clases de
 * use cases solo para castear stubs — jamás se usa fuera de `.execute()`.
 */
export const failingUseCase = {
  execute: (..._args: unknown[]) => Promise.reject(new Error('boom: infraestructura caída (no mapeado inline)')),
} as unknown as never;

/** AuthProvider que siempre autentica (cookie auth_token=fake). */
export const fakeAuthProvider = {
  getSession: async () => ({ id: 'admin-1', username: 'test', email: 'test@test.com', role: 'admin' as const }),
} as unknown as AuthProvider;

/** requirePerm pass-through — RBAC no es lo que se prueba en este sweep. */
export const passthroughPerm = (_module: unknown, _action: unknown): RequestHandler =>
  (_req, _res, next) => next();

export const AUTH_COOKIE = 'auth_token=fake';

const HANG_MS = 1500;

/**
 * Corre la request contra un timer: si el timer gana, el handler re-lanzó el
 * error sin next(err) y la request quedó COLGADA (el bug de este sweep).
 */
export async function expectNoHang(req: Test): Promise<SupertestResponse> {
  let timer: NodeJS.Timeout | undefined;
  const hung = new Promise<'HUNG'>((resolve) => {
    timer = setTimeout(() => resolve('HUNG'), HANG_MS);
  });
  try {
    const winner = await Promise.race([req, hung]);
    if (winner === 'HUNG') {
      req.abort();
      throw new Error(
        `BUG (async-error-sweep): la request quedó COLGADA ${HANG_MS}ms — un throw async no llega ` +
        'al errorHandler en Express 4; el fallback del catch debe ser next(err)',
      );
    }
    return winner;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
