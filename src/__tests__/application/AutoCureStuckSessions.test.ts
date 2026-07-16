import { AutoCureStuckSessions } from '@application/use-cases/AutoCureStuckSessions';
import { CureStuckSession } from '@application/use-cases/CureStuckSession';
import { InMemoryRadiusAuthEventRepository } from '@infrastructure/adapters/in-memory/InMemoryRadiusAuthEventRepository';
import { InMemoryRadiusOrchestratorGateway } from '@infrastructure/adapters/in-memory/InMemoryRadiusOrchestratorGateway';
import { InMemoryRadiusSessionCureEventRepository } from '@infrastructure/adapters/in-memory/InMemoryRadiusSessionCureEventRepository';
import type { OrchestratorSession } from '@domain/ports/RadiusOrchestratorGateway';
import type { RadiusAuthEventUpsert } from '@domain/ports/RadiusAuthEventRepository';

/**
 * radius-session-autocure BE-1 (REQ-CURE-1, REQ-CURE-4) — watcher AutoCureStuckSessions:
 * detección desde RadiusAuthEvent YA ingerido (cero barrido nuevo) + breaker/cap/cure-throttle
 * 30min/flapping ≥3-24h/throttle de registro 6h.
 */
const NOW = new Date('2026-07-16T12:00:00Z');
const TUNING = {
  lookbackMs: 900_000,   // 15min
  abortThreshold: 20,
  maxPerTick: 5,
  cooldownMs: 1_800_000, // 30min
  flappingMax: 3,
};
const CURE_TUNING = { staleMs: 1_200_000, persistenceMs: 300_000, recencyMs: 120_000 };

function stuckEvent(username: string, authdate: string, over: Partial<RadiusAuthEventUpsert> = {}): RadiusAuthEventUpsert {
  return {
    sourceUniqueId: `${username}-${authdate}`,
    username,
    reply: 'Access-Reject',
    authdate: new Date(authdate),
    class: null,
    reason: 'session_stuck',
    ...over,
  };
}

function session(username: string, over: Partial<OrchestratorSession> = {}): OrchestratorSession {
  return {
    sessionId: `sid-${username}`,
    username,
    nasIp: '10.60.0.10',
    framedIp: '100.64.10.10',
    startedAt: '2026-07-16T09:00:00Z',
    bytesIn: 0,
    bytesOut: 0,
    callerId: null,
    lastUpdate: '2026-07-16T11:30:00Z', // 30min stale por default → camino stale
    ...over,
  };
}

function build(opts: { events: RadiusAuthEventUpsert[]; sessions?: Record<string, OrchestratorSession[]> }) {
  const authRepo = new InMemoryRadiusAuthEventRepository();
  const cureEventRepo = new InMemoryRadiusSessionCureEventRepository({ now: () => NOW });
  const seed = Object.entries(opts.sessions ?? {}).map(([username, sessions]) => ({ username, sessions }));
  const gateway = new InMemoryRadiusOrchestratorGateway({ seed });
  const cureStuckSession = new CureStuckSession(gateway, cureEventRepo, CURE_TUNING);
  const watcher = new AutoCureStuckSessions(authRepo, cureEventRepo, cureStuckSession, TUNING, { now: () => NOW });
  return { authRepo, cureEventRepo, gateway, cureStuckSession, watcher };
}

describe('AutoCureStuckSessions', () => {
  it('S1.1: un evento session_stuck de userX dentro del lookback → userX candidato UNA sola vez (179 rejects)', async () => {
    const events: RadiusAuthEventUpsert[] = [];
    for (let i = 0; i < 179; i++) {
      events.push(stuckEvent('userX', new Date(NOW.getTime() - 60_000 - i * 1000).toISOString()));
    }
    const { authRepo, watcher } = build({ events: [], sessions: { userX: [session('userX')] } });
    await authRepo.upsertMany(events);
    const summary = await watcher.run();
    expect(summary.candidates).toBe(1);
    expect(summary.events).toBe(179);
  });

  it('S1.2: evento MÁS VIEJO que el lookback → NO es candidato', async () => {
    const { authRepo, watcher } = build({ events: [] });
    await authRepo.upsertMany([stuckEvent('userOld', new Date(NOW.getTime() - TUNING.lookbackMs - 60_000).toISOString())]);
    const summary = await watcher.run();
    expect(summary.candidates).toBe(0);
  });

  it('S1.3: eventos con reason user_not_found/other → jamás candidatos', async () => {
    const { authRepo, watcher } = build({ events: [] });
    await authRepo.upsertMany([
      stuckEvent('u1', NOW.toISOString(), { reason: 'user_not_found' }),
      stuckEvent('u2', NOW.toISOString(), { reason: 'other' }),
    ]);
    const summary = await watcher.run();
    expect(summary.candidates).toBe(0);
  });

  it('S1.4: rejects a las 10:00, 10:03 y 10:06 → agregado {firstReject:10:00, lastReject:10:06} (fast path cumple con 6min>=5min)', async () => {
    const { authRepo, watcher, cureEventRepo } = build({
      events: [], sessions: { userY: [session('userY', { lastUpdate: '2026-07-16T11:55:00Z' })] }, // fresco: solo fast path cura
    });
    await authRepo.upsertMany([
      stuckEvent('userY', '2026-07-16T11:54:00Z'),
      stuckEvent('userY', '2026-07-16T11:57:00Z'),
      stuckEvent('userY', '2026-07-16T12:00:00Z'), // último reject = NOW (recencia 0)
    ]);
    const summary = await watcher.run();
    expect(summary.cured).toBe(1);
    expect(cureEventRepo.all()[0]?.signalUsed).toBe('persistent_rejects');
  });

  it('S4.1: 25 candidatos únicos → tick ABORTADO, cero llamadas al gateway, aborted:true', async () => {
    const events: RadiusAuthEventUpsert[] = [];
    for (let i = 0; i < 25; i++) events.push(stuckEvent(`user${i}`, NOW.toISOString()));
    const { authRepo, watcher, gateway } = build({ events: [] });
    await authRepo.upsertMany(events);
    const summary = await watcher.run();
    expect(summary.aborted).toBe(true);
    expect(summary.cured).toBe(0);
    expect(gateway.calls).toHaveLength(0);
    expect(gateway.cureCalls).toHaveLength(0);
  });

  it('S4.2: 8 candidatos con cap 5 → 5 procesados, deferred:3', async () => {
    const events: RadiusAuthEventUpsert[] = [];
    const sessions: Record<string, OrchestratorSession[]> = {};
    for (let i = 0; i < 8; i++) {
      events.push(stuckEvent(`u${i}`, NOW.toISOString()));
      sessions[`u${i}`] = [session(`u${i}`)];
    }
    const { authRepo, watcher } = build({ events: [], sessions });
    await authRepo.upsertMany(events);
    const summary = await watcher.run();
    expect(summary.candidates).toBe(8);
    expect(summary.deferred).toBe(3);
    expect(summary.cured).toBe(5);
  });

  it('S4.4: flag OFF simulado por el caller — el watcher en sí no chequea el flag (eso es del scheduler); un tick sin eventos no procesa nada', async () => {
    const { watcher } = build({ events: [] });
    const summary = await watcher.run();
    expect(summary.candidates).toBe(0);
    expect(summary.cured).toBe(0);
  });

  it('S4.5: username curado hace 10min con fast path cumplido → skip por cure-throttle (counter, SIN fila)', async () => {
    const { authRepo, watcher, cureEventRepo } = build({
      events: [], sessions: { userZ: [session('userZ', { lastUpdate: '2026-07-16T11:55:00Z' })] },
    });
    // Cura previa hace 10min (dentro del cooldown de 30min) — el repo usa `now: () => NOW`
    // inyectado en build(), así que seedeamos con createdAt = NOW-10min directamente.
    cureEventRepo.seed([{
      username: 'userZ', nasIp: null, sessionId: null, sessionStartedAt: null, sessionLastUpdate: null,
      signalUsed: null, trigger: 'auto', action: null, outcome: 'cured', reason: null, actorName: 'sistema',
      createdAt: new Date(NOW.getTime() - 10 * 60 * 1000).toISOString(),
    }]);
    await authRepo.upsertMany([
      stuckEvent('userZ', '2026-07-16T11:54:00Z'),
      stuckEvent('userZ', '2026-07-16T12:00:00Z'),
    ]);
    const before = cureEventRepo.all().length;
    const summary = await watcher.run();
    expect(summary.skippedCureThrottle).toBe(1);
    expect(summary.cured).toBe(0);
    expect(cureEventRepo.all().length).toBe(before); // sin fila nueva
  });

  it('S4.6: username con 3 curas en 24h reaparece → fila flagged_flapping, CERO llamadas al cure', async () => {
    const { authRepo, watcher, cureEventRepo, gateway } = build({
      events: [], sessions: { userF: [session('userF', { lastUpdate: '2026-07-16T11:55:00Z' })] },
    });
    const old = new Date(NOW.getTime() - 20 * 60 * 60 * 1000).toISOString(); // 20h atrás: DENTRO de 24h, FUERA del cooldown 30min
    cureEventRepo.seed([
      { username: 'userF', nasIp: null, sessionId: null, sessionStartedAt: null, sessionLastUpdate: null, signalUsed: null, trigger: 'auto', action: null, outcome: 'cured', reason: null, actorName: 'sistema', createdAt: old },
      { username: 'userF', nasIp: null, sessionId: null, sessionStartedAt: null, sessionLastUpdate: null, signalUsed: null, trigger: 'auto', action: null, outcome: 'cured', reason: null, actorName: 'sistema', createdAt: old },
      { username: 'userF', nasIp: null, sessionId: null, sessionStartedAt: null, sessionLastUpdate: null, signalUsed: null, trigger: 'auto', action: null, outcome: 'cured', reason: null, actorName: 'sistema', createdAt: old },
    ]);
    await authRepo.upsertMany([stuckEvent('userF', '2026-07-16T11:59:00Z')]);
    const summary = await watcher.run();
    expect(summary.flaggedFlapping).toBe(1);
    expect(summary.cured).toBe(0);
    expect(gateway.cureCalls).toHaveLength(0);
    const flaggedRow = cureEventRepo.all().find((e) => e.outcome === 'flagged_flapping');
    expect(flaggedRow).toBeDefined();
  });

  it('S4.7: el fallo de un candidato NO aborta el tick (aislamiento por ítem)', async () => {
    const events = [stuckEvent('userBad', NOW.toISOString()), stuckEvent('userGood', NOW.toISOString())];
    const { authRepo, watcher } = build({
      events: [],
      sessions: { userGood: [session('userGood')] }, // userBad SIN sesiones seed → listSessions del gateway in-memory devuelve [] (no throw) → skipped_no_session, no failure real
    });
    await authRepo.upsertMany(events);
    const summary = await watcher.run();
    // Ambos candidatos se procesan (ninguno aborta al otro): userGood cura, userBad skip.
    expect(summary.cured).toBe(1);
    expect(summary.skippedNoSession).toBe(1);
  });

  it('S4.8: envs inválidas no aplica acá (config.ts) — pero un tuning con maxPerTick=0 no crashea, defiere todo', async () => {
    const { authRepo, cureEventRepo, gateway } = build({ events: [], sessions: { u1: [session('u1')] } });
    await authRepo.upsertMany([stuckEvent('u1', NOW.toISOString())]);
    const cureStuckSession = new CureStuckSession(gateway, cureEventRepo, CURE_TUNING);
    const watcherZeroCap = new AutoCureStuckSessions(authRepo, cureEventRepo, cureStuckSession, { ...TUNING, maxPerTick: 0 }, { now: () => NOW });
    const summary = await watcherZeroCap.run();
    expect(summary.deferred).toBe(1);
    expect(summary.cured).toBe(0);
  });
});
