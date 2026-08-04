import { runBalanceLaneTick, LaneGuard } from '@infrastructure/scheduling/balanceLaneTick';
import { InMemorySyncStateRepository } from '@infrastructure/adapters/in-memory/InMemorySyncStateRepository';
import { SLOW_LANE, FAST_LANE } from '@application/use-cases/RefreshDebtorBalances';

function makeLane(calls: string[], name: string, opts: { throws?: boolean; delayMs?: number } = {}) {
  return {
    execute: async () => {
      calls.push(name);
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      if (opts.throws) throw new Error(`${name} exploto`);
      return { refreshed: 1, errors: 0 };
    },
  };
}

/** 03:30 ART == 06:30 UTC (Argentina es UTC-3 todo el año). */
const MADRUGADA_AR = new Date('2026-08-04T06:30:00Z');
/** 14:00 ART == 17:00 UTC. */
const MEDIODIA_AR = new Date('2026-08-04T17:00:00Z');

describe('runBalanceLaneTick', () => {
  let state: InMemorySyncStateRepository;
  let calls: string[];
  let guard: LaneGuard;

  beforeEach(() => {
    state = new InMemorySyncStateRepository();
    calls = [];
    guard = { inFlight: false };
  });

  const deps = (now: Date) => ({
    fast: makeLane(calls, 'fast'),
    slow: makeLane(calls, 'slow'),
    state,
    guard,
    now: () => now,
  });

  it('fuera de la ventana de madrugada corre el carril RAPIDO', async () => {
    const result = await runBalanceLaneTick(deps(MEDIODIA_AR));

    expect(result).toBe('fast');
    expect(calls).toEqual(['fast']);
  });

  it('en la ventana de madrugada, si el lento no corrio hoy, gana el LENTO', async () => {
    const result = await runBalanceLaneTick(deps(MADRUGADA_AR));

    expect(result).toBe('slow');
    expect(calls).toEqual(['slow']);
  });

  it('en la ventana pero el lento YA corrio hoy: corre el RAPIDO', async () => {
    await state.save({
      entity: SLOW_LANE.entity,
      cursor: null,
      lastRunAt: new Date('2026-08-04T06:05:00Z'), // 03:05 ART, mismo dia AR
      lastResult: 'ok',
      itemsSynced: 10,
    });

    const result = await runBalanceLaneTick(deps(MADRUGADA_AR));

    expect(result).toBe('fast');
    expect(calls).toEqual(['fast']);
  });

  // ---------------------------------------------------------------------------
  // LANE-3.1 — exclusion mutua
  // ---------------------------------------------------------------------------

  it('LANE-3.1 — con el guard tomado, el tick NO llama a ningun carril', async () => {
    guard.inFlight = true;

    const result = await runBalanceLaneTick(deps(MEDIODIA_AR));

    expect(result).toBe('skipped');
    expect(calls).toEqual([]);
  });

  it('LANE-3.1 — dos ticks concurrentes: solo UNO corre', async () => {
    const slowLane = makeLane(calls, 'slow-lento', { delayMs: 30 });
    const fastLane = makeLane(calls, 'fast-lento', { delayMs: 30 });
    const d = { fast: fastLane, slow: slowLane, state, guard, now: () => MEDIODIA_AR };

    const [a, b] = await Promise.all([runBalanceLaneTick(d), runBalanceLaneTick(d)]);

    expect(calls).toHaveLength(1);
    expect([a, b].filter((r) => r === 'skipped')).toHaveLength(1);
  });

  it('LANE-3.1 — el guard se LIBERA aunque el carril explote', async () => {
    const d = {
      fast: makeLane(calls, 'fast', { throws: true }),
      slow: makeLane(calls, 'slow'),
      state,
      guard,
      now: () => MEDIODIA_AR,
    };

    await runBalanceLaneTick(d);

    // Sin el `finally`, el guard quedaria trabado para siempre y el refresco de
    // facturas moriria en silencio hasta el proximo reinicio del contenedor.
    expect(guard.inFlight).toBe(false);

    await runBalanceLaneTick({ ...d, fast: makeLane(calls, 'fast-2') });
    expect(calls).toContain('fast-2');
  });

  it('si SyncState no se puede leer, NO se bloquea: cae al carril rapido', async () => {
    state.get = async () => {
      throw new Error('DB caida');
    };

    const result = await runBalanceLaneTick(deps(MADRUGADA_AR));

    expect(result).toBe('fast');
    expect(calls).toEqual(['fast']);
    expect(guard.inFlight).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // FIX-4 — una corrida FALLIDA no consume el cupo del dia
  // ---------------------------------------------------------------------------

  it('FIX-4 — si la corrida de hoy FALLO, el carril lento REINTENTA en la ventana', async () => {
    // `execute()` guarda lastRunAt aunque haya fallado todo. Sin este filtro, un
    // blip de GR a las 03:00 dejaba al carril lento afuera hasta el dia siguiente:
    // la ventana de 3 h, que existe para dar TRES intentos, daba CERO.
    await state.save({
      entity: SLOW_LANE.entity,
      cursor: null,
      lastRunAt: new Date('2026-08-04T06:05:00Z'), // 03:05 ART, HOY
      lastResult: 'error: 1 failure(s), no clients refreshed',
      itemsSynced: 0,
    });

    const result = await runBalanceLaneTick(deps(MADRUGADA_AR));

    expect(result).toBe('slow');
    expect(calls).toEqual(['slow']);
  });

  it('FIX-4 — pero una corrida OK si consume el cupo (no corre dos veces)', async () => {
    await state.save({
      entity: SLOW_LANE.entity,
      cursor: null,
      lastRunAt: new Date('2026-08-04T06:05:00Z'),
      lastResult: 'ok',
      itemsSynced: 9082,
    });

    const result = await runBalanceLaneTick(deps(MADRUGADA_AR));

    expect(result).toBe('fast');
    expect(calls).toEqual(['fast']);
  });

  it('los dos carriles apuntan a entities distintas de SyncState', () => {
    expect(FAST_LANE.entity).not.toBe(SLOW_LANE.entity);
  });
});
