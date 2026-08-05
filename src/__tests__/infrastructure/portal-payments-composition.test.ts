import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * `portal-payments` — composition-root guard.
 *
 * La ruta `/payments` solo se monta si `deps.listPortalPayments` es truthy
 * (`portal.routes.ts` monta cada handler bajo su propio `if`). Si `app.ts` no lo
 * pasa, el endpoint NO EXISTE en prod: 404 silencioso, cero errores de compilacion
 * y todos los tests del use case en verde porque inyectan su propio doble.
 * Es la leccion W6 del EPIC #38 y la familia `feature-sin-perilla-inerte`.
 *
 * ⚠️ LIMITES (medidos con mutantes en otro change, se documentan en vez de fingir):
 * un wiring dentro de `if (false)` o en una funcion muerta satisface un test de
 * TEXTO. Lo que SI caza: que el wiring se borre, que se comente, o que se pase un
 * doble en vez del adapter real. El guard de comportamiento queda como deuda.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('portal-payments — composition root', () => {
  let appSrc: string;
  let routesSrc: string;

  beforeAll(() => {
    appSrc = stripComments(
      readFileSync(join(__dirname, '..', '..', 'infrastructure', 'http', 'app.ts'), 'utf8'),
    );
    routesSrc = stripComments(
      readFileSync(join(__dirname, '..', '..', 'infrastructure', 'http', 'routes', 'portal.routes.ts'), 'utf8'),
    );
  });

  it('app.ts construye el use case con el adapter Prisma REAL, no un fixture', () => {
    expect(appSrc).toContain('new ListPortalPayments(customerAdapter, new PrismaPortalPaymentsReader())');
    expect(appSrc).toContain("from '../adapters/prisma/PrismaPortalPaymentsReader'");
  });

  it('el use case se PASA al router del portal (si no, la ruta no se monta)', () => {
    expect(appSrc).toMatch(/^\s*listPortalPayments,\s*$/m);
  });

  /**
   * La ventana ACOTADA al bloque de `/payments`, no hasta el final del archivo.
   *
   * La version anterior hacia `slice(indexOf("'/payments'"))` — 38.013 caracteres
   * contra los 526 del bloque real. Las ~40 rutas POSTERIORES satisfacian los
   * asserts: el review le saco el `portalAuthMiddleware` a esta ruta y el test paso
   * 4/4. Un guard que mira 72 veces mas de lo que dice vigilar no vigila nada.
   */
  function bloquePayments(src: string): string {
    const desde = src.indexOf("'/payments'");
    const hasta = src.indexOf('if (deps.listPortalPlans)', desde);
    expect(desde).toBeGreaterThan(-1);
    expect(hasta).toBeGreaterThan(desde);
    return src.slice(desde, hasta);
  }

  it('la ruta esta montada y anclada al token', () => {
    const bloque = bloquePayments(routesSrc);
    // `requireClientId` es lo que saca el clientId de `req.portalClientId`; sin eso
    // el anclaje anti-IDOR se afloja.
    expect(bloque).toContain('requireClientId(req, res)');
    expect(bloque).toContain('deps.portalAuthMiddleware');
    // El rate limiter tambien: sin este assert, borrarlo sobrevivia toda la suite.
    expect(bloque).toContain('generalRateLimiter');
  });

  it('la ruta NO acepta ningun identificador de cliente del request', () => {
    const bloque = bloquePayments(routesSrc);
    // Del request solo se lee la paginacion. OJO: este assert es de AUSENCIA sobre
    // TEXTO y por lo tanto NO discrimina — un alias local (`const q = req.query`) lo
    // esquiva. Lo que realmente protege la invariante son los tests de
    // COMPORTAMIENTO de `portalSelfService.routes.test.ts` que mandan `?clientId=`.
    expect(bloque).toContain('parsePagination(req.query)');
    expect(bloque).not.toMatch(/req\.(query|params|body)\.\s*clientId/);
  });
});
