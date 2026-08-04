import { SyncStateRepository } from '@domain/ports/SyncStateRepository';
import { SLOW_LANE } from '@application/use-cases/RefreshDebtorBalances';
import { shouldRunDailyLane } from '@application/use-cases/shouldRunDailyLane';

/** Lo mínimo que el tick necesita de un carril — así el test no arma el use case entero. */
export interface RunnableLane {
  execute(): Promise<{ refreshed: number; errors: number }>;
}

/** Guard COMPARTIDO por los dos carriles. Objeto (no boolean suelto) para pasarlo por referencia. */
export interface LaneGuard {
  inFlight: boolean;
}

export interface BalanceLaneTickDeps {
  fast: RunnableLane;
  slow: RunnableLane;
  state: SyncStateRepository;
  guard: LaneGuard;
  now: () => Date;
}

/** Qué hizo el tick — devuelto para que el test lo pueda assertear sin espiar logs. */
export type BalanceLaneTickResult = 'fast' | 'slow' | 'skipped';

/**
 * Un tick del refresco de balances de GR.
 *
 * Hay UN solo ticker horario para los dos carriles, y eso es la exclusión mutua:
 * dos tickers independientes podrían solapar el carril lento (~70 min) con el
 * rápido (~43 min) y duplicar la carga instantánea sobre GR, justo el escenario
 * de 429s que el propio use case advierte.
 *
 * Prioridad: si el carril LENTO está en ventana y no corrió con éxito hoy, gana
 * él. El rápido tiene 24 oportunidades por día; el lento tiene 3 (la ventana de
 * madrugada). Cederle el tick al escaso es lo que evita que se saltee días.
 *
 * ⚠️ **DEUDA CONOCIDA — el carril lento no tiene observabilidad** (card propia en
 * el BACKLOG). Su `SyncState` (`gr-balances-bajas`) hoy no lo lee nadie, y si el
 * guard queda tomado o `state.get` falla de forma persistente, el carril no corre
 * y nadie se entera. Se intentó una alarma en este change y se RETIRÓ: falló dos
 * rondas de review seguidas (primero se anulaba con el gate del cupo, después con
 * su propia gracia de arranque, que se reseteaba en cada deploy). **Una alarma
 * rota es peor que ninguna: da confianza falsa.** La observabilidad se hace bien,
 * con su propio diseño, o no se hace.
 */
export async function runBalanceLaneTick(deps: BalanceLaneTickDeps): Promise<BalanceLaneTickResult> {
  const { fast, slow, state, guard, now } = deps;

  if (guard.inFlight) return 'skipped';

  let lane: RunnableLane = fast;
  let name: BalanceLaneTickResult = 'fast';

  try {
    const last = await state.get(SLOW_LANE.entity);
    // Solo una corrida EXITOSA consume el cupo del día. `execute()` guarda
    // `lastRunAt` aunque haya fallado todo, así que sin este filtro un blip de GR
    // a las 03:00 dejaba al carril lento fuera hasta el día siguiente: la ventana
    // de 3 h, que existe para dar TRES intentos, daba cero.
    const ultimaCorridaBuena = last?.lastResult === 'ok' ? (last.lastRunAt ?? null) : null;
    if (shouldRunDailyLane(ultimaCorridaBuena, now())) {
      lane = slow;
      name = 'slow';
    }
  } catch (err) {
    // Si SyncState no se puede leer, NO se bloquea el refresco: se cae al carril
    // rápido, que es el que le importa al cliente que está mirando la app. El
    // lento se reintenta en el próximo tick de la ventana.
    console.error('[gr-balance] no se pudo leer el estado del carril lento:', (err as Error).message);
  }

  // Re-chequeo + set SINCRÓNICOS, sin ningún `await` en el medio: entre el
  // chequeo de arriba y acá hubo un await (la lectura de SyncState) y otro tick
  // pudo haber tomado el guard.
  if (guard.inFlight) return 'skipped';
  guard.inFlight = true;

  try {
    const result = await lane.execute();
    console.log(`[gr-balance] carril ${name}: refreshed=${result.refreshed}, errors=${result.errors}`);
  } catch (err) {
    console.error(`[gr-balance] carril ${name} falló:`, (err as Error).message);
  } finally {
    guard.inFlight = false;
  }

  return name;
}
