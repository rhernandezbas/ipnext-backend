import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * `gr-balance-refresh-lanes` — composition-root guard.
 *
 * El change se puede implementar PERFECTO y quedar MUERTO en produccion con el CI
 * en verde (leccion W6 del EPIC #38): `bootstrapGestionRealSync` tiene que
 * instanciar LOS DOS carriles y ademas LLAMAR al ticker. Con un carril solo, o las
 * Bajas no se refrescan nunca, o —peor— los ACTIVOS no se refrescan nunca y
 * estamos de nuevo en el bug original. Y si la llamada al ticker se borra, `tsc`
 * compila igual (no hay `noUnusedLocals`) y no corre ninguno de los dos.
 *
 * Regla del repo "tests sobre texto filtran comentarios": los asserts corren
 * sobre el source EFECTIVO. Sin esto, el propio comentario explicativo que
 * dejamos arriba de cada linea satisfaria el assert aunque el wiring real se
 * hubiera perdido.
 *
 * ⚠️ LIMITES REALES DE ESTE TEST, medidos con mutantes en la ronda 3 de review —
 * se documentan en vez de fingir que no existen:
 *   - Un wiring dentro de `if (false)`, o en una funcion MUERTA que nadie llama,
 *     satisface los asserts. El texto no distingue codigo vivo de codigo muerto.
 *   - El texto asertado escondido en un string tambien los satisface.
 *   - Lo que SI caza: que la llamada se borre, que se comente (un bloque que
 *     envuelva un JSDoc ni siquiera compila — `tsc` lo mata con TS1109, probado),
 *     y que los carriles se pasen por posicion en vez de por nombre.
 * El guard de COMPORTAMIENTO (levantar la app y verificar el grafo real) queda
 * como deuda con card propia. Un test que declara sus limites es mas util que uno
 * que promete mas de lo que da.
 */
function stripComments(src: string): string {
  return (
    src
      // Bloques /* ... */ completos, incluso multilinea.
      .replace(/\/\*[\s\S]*?\*\//g, '')
      // Comentarios de linea, esten al principio o al FINAL de la linea.
      // El `[^:]` preserva el `://` de las URLs dentro de strings.
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
  );
}

describe('gr-balance-refresh-lanes — composition root', () => {
  let bootstrapSrc: string;

  beforeAll(() => {
    bootstrapSrc = stripComments(
      readFileSync(
        join(__dirname, '..', '..', 'infrastructure', 'scheduling', 'bootstrapGestionRealSync.ts'),
        'utf8',
      ),
    );
  });

  // ---------------------------------------------------------------------------
  // LANE-1/LANE-3 — los DOS carriles se instancian y comparten el ticker
  // ---------------------------------------------------------------------------

  it('LANE-1 — el bootstrap instancia los dos carriles, explicitos', () => {
    expect(bootstrapSrc).toContain('new RefreshDebtorBalances(client, mirror, state, FAST_LANE)');
    expect(bootstrapSrc).toContain('new RefreshDebtorBalances(client, mirror, state, SLOW_LANE)');
  });

  it('LANE-1 — importa los dos carriles desde el use case (no los redefine)', () => {
    expect(bootstrapSrc).toMatch(
      /import \{[^}]*FAST_LANE[^}]*SLOW_LANE[^}]*\} from '@application\/use-cases\/RefreshDebtorBalances'/,
    );
  });

  it('LANE-3 — hay UN solo ticker y usa el tick con guard compartido', () => {
    expect(bootstrapSrc).toContain('runBalanceLaneTick');
    expect(bootstrapSrc).toContain('const guard: LaneGuard = { inFlight: false }');
    // Un unico setInterval para el refresco de balances: dos tickers
    // independientes solaparian los carriles contra GR.
    const intervals = bootstrapSrc.match(/setInterval/g) ?? [];
    expect(intervals.length).toBe(1);
  });

  it('LANE-3 — el job viejo de un solo carril ya no existe', () => {
    expect(bootstrapSrc).not.toContain('startBalanceBatchJob');
  });

  // ---------------------------------------------------------------------------
  // FIX-3 — el mutante que sobrevivia: borrar la LLAMADA al ticker
  // ---------------------------------------------------------------------------

  it('FIX-3 — el ticker se LLAMA, no solo se define', () => {
    // Mutante que sobrevivia la suite entera: borrar la llamada a
    // `startBalanceLaneJobs(...)` en el bootstrap. `tsc` compila igual (no hay
    // `noUnusedLocals`), el TEXTO de la funcion sigue en el archivo, y los 6
    // asserts anteriores seguian verdes => los dos carriles MUERTOS en prod con
    // el CI en verde. Este assert exige la INVOCACION, no la definicion.
    expect(bootstrapSrc).toMatch(/^\s*startBalanceLaneJobs\(\{/m);
  });

  it('FIX-3 — los carriles se pasan por NOMBRE, no por posicion', () => {
    // `fast` y `slow` son del mismo tipo: como posicionales se podian invertir
    // sin error de compilacion ni test rojo, y con los carriles cruzados el bug
    // original volvia. Con un objeto es imposible equivocarse.
    expect(bootstrapSrc).toMatch(/startBalanceLaneJobs\(\{[\s\S]*?fast: refreshFastLane[\s\S]*?slow: refreshSlowLane[\s\S]*?\}\)/);
    expect(bootstrapSrc).not.toMatch(/startBalanceLaneJobs\(\s*refresh/);
  });
});
