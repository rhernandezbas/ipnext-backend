import { CureStuckSession } from '@application/use-cases/CureStuckSession';
import { InMemoryRadiusOrchestratorGateway } from '@infrastructure/adapters/in-memory/InMemoryRadiusOrchestratorGateway';
import { InMemoryRadiusSessionCureEventRepository } from '@infrastructure/adapters/in-memory/InMemoryRadiusSessionCureEventRepository';
import type { OrchestratorSession } from '@domain/ports/RadiusOrchestratorGateway';

/**
 * radius-session-autocure BE-1 (REQ-CURE-2, REQ-CURE-3, REQ-CURE-5, REQ-CURE-6) — core
 * CureStuckSession: gates FAIL-CLOSED + DOS caminos de cura (fast path por persistencia de
 * rejects / stale interim clásico) + registro con signalUsed, compartido por watcher y manual.
 */
const NOW = new Date('2026-07-16T12:00:00Z');
const TUNING = { staleMs: 1_200_000, persistenceMs: 300_000, recencyMs: 120_000 }; // 20min/5min/2min

function session(over: Partial<OrchestratorSession> = {}): OrchestratorSession {
  return {
    sessionId: 'sid-1',
    username: 'cliente001',
    nasIp: '10.60.0.10',
    framedIp: '100.64.10.10',
    startedAt: '2026-07-16T09:00:00Z',
    bytesIn: 0,
    bytesOut: 0,
    callerId: null,
    lastUpdate: '2026-07-16T11:59:00Z', // 1 min de frescura por default
    ...over,
  };
}

function build(seedSessions: OrchestratorSession[]) {
  const gateway = new InMemoryRadiusOrchestratorGateway({
    seed: [{ username: 'cliente001', sessions: seedSessions }],
  });
  const cureEventRepo = new InMemoryRadiusSessionCureEventRepository({ now: () => NOW });
  const useCase = new CureStuckSession(gateway, cureEventRepo, TUNING);
  return { gateway, cureEventRepo, useCase };
}

describe('CureStuckSession', () => {
  it('S2.6: cero sesiones abiertas → skipped_no_session, fila registrada', async () => {
    const { useCase, cureEventRepo } = build([]);
    const result = await useCase.execute({ username: 'cliente001', trigger: 'auto', actorName: 'sistema', now: NOW });
    expect(result.outcome).toBe('skipped_no_session');
    expect(cureEventRepo.all()).toHaveLength(1);
    expect(cureEventRepo.all()[0]?.outcome).toBe('skipped_no_session');
  });

  it('S2.4: sesiones en NAS distintos → skipped_ambiguous AUNQUE la persistencia esté cumplida', async () => {
    const { useCase } = build([
      session({ sessionId: 's1', nasIp: '10.60.0.10' }),
      session({ sessionId: 's2', nasIp: '10.60.0.20' }),
    ]);
    const result = await useCase.execute({
      username: 'cliente001', trigger: 'auto', actorName: 'sistema', now: NOW,
      rejectAggregate: { firstReject: new Date('2026-07-16T11:50:00Z'), lastReject: new Date('2026-07-16T11:59:30Z') },
    });
    expect(result.outcome).toBe('skipped_ambiguous');
  });

  it('S2.5: sesión sin lastUpdate → skipped_no_signal AUNQUE la persistencia esté cumplida', async () => {
    const { useCase } = build([session({ lastUpdate: null })]);
    const result = await useCase.execute({
      username: 'cliente001', trigger: 'auto', actorName: 'sistema', now: NOW,
      rejectAggregate: { firstReject: new Date('2026-07-16T11:50:00Z'), lastReject: new Date('2026-07-16T11:59:30Z') },
    });
    expect(result.outcome).toBe('skipped_no_signal');
  });

  it('S2.3: interim FRESCO + rejects sostenidos 6min con el último hace 1min → CURADA via fast path', async () => {
    const { useCase, cureEventRepo } = build([session({ lastUpdate: '2026-07-16T11:59:00Z' })]);
    const result = await useCase.execute({
      username: 'cliente001', trigger: 'auto', actorName: 'sistema', now: NOW,
      rejectAggregate: { firstReject: new Date('2026-07-16T11:53:00Z'), lastReject: new Date('2026-07-16T11:59:00Z') },
    });
    expect(result.outcome).toBe('cured');
    expect(cureEventRepo.all()[0]?.signalUsed).toBe('persistent_rejects');
  });

  it('S2.2: interim fresco + rejects que AÚN no persisten (3min) → skipped_alive', async () => {
    const { useCase } = build([session({ lastUpdate: '2026-07-16T11:59:00Z' })]);
    const result = await useCase.execute({
      username: 'cliente001', trigger: 'auto', actorName: 'sistema', now: NOW,
      rejectAggregate: { firstReject: new Date('2026-07-16T11:57:00Z'), lastReject: new Date('2026-07-16T11:59:00Z') },
    });
    expect(result.outcome).toBe('skipped_alive');
  });

  it('S2.9: persistencia cumplida (8min) pero último reject hace 10min → recencia falla, evalúa camino stale', async () => {
    const { useCase, cureEventRepo } = build([session({ lastUpdate: '2026-07-16T11:30:00Z' })]); // 30min stale
    const result = await useCase.execute({
      username: 'cliente001', trigger: 'auto', actorName: 'sistema', now: NOW,
      rejectAggregate: { firstReject: new Date('2026-07-16T11:42:00Z'), lastReject: new Date('2026-07-16T11:50:00Z') },
    });
    expect(result.outcome).toBe('cured');
    expect(cureEventRepo.all()[0]?.signalUsed).toBe('stale_interim');
  });

  it('S2.10: agregado de rejects abarca EXACTAMENTE persistenceMs (borde) → fast path aplica (>=)', async () => {
    const { useCase, cureEventRepo } = build([session({ lastUpdate: '2026-07-16T11:59:00Z' })]);
    const result = await useCase.execute({
      username: 'cliente001', trigger: 'auto', actorName: 'sistema', now: NOW,
      rejectAggregate: { firstReject: new Date('2026-07-16T11:54:00Z'), lastReject: new Date('2026-07-16T11:59:00Z') }, // exactamente 5min
    });
    expect(result.outcome).toBe('cured');
    expect(cureEventRepo.all()[0]?.signalUsed).toBe('persistent_rejects');
  });

  it('S2.1: sesión stale (25min) sin persistencia de rejects → curada vía camino stale', async () => {
    const { useCase, cureEventRepo } = build([session({ lastUpdate: '2026-07-16T11:35:00Z' })]); // 25min
    const result = await useCase.execute({
      username: 'cliente001', trigger: 'auto', actorName: 'sistema', now: NOW,
      rejectAggregate: { firstReject: new Date('2026-07-16T11:59:00Z'), lastReject: new Date('2026-07-16T11:59:00Z') },
    });
    expect(result.outcome).toBe('cured');
    expect(cureEventRepo.all()[0]?.signalUsed).toBe('stale_interim');
  });

  it('S2.8: dos sesiones stale en el MISMO NAS → se curan AMBAS (cada una su fila)', async () => {
    const { useCase, cureEventRepo } = build([
      session({ sessionId: 's1', nasIp: '10.60.0.10', lastUpdate: '2026-07-16T11:30:00Z' }),
      session({ sessionId: 's2', nasIp: '10.60.0.10', lastUpdate: '2026-07-16T11:20:00Z' }),
    ]);
    const result = await useCase.execute({ username: 'cliente001', trigger: 'auto', actorName: 'sistema', now: NOW });
    expect(result.outcome).toBe('cured');
    expect(cureEventRepo.all()).toHaveLength(2);
    expect(cureEventRepo.all().every((e) => e.outcome === 'cured')).toBe(true);
  });

  it('S3.2: cure con already_closed:true en el wire → outcome already_cured, no-op limpio (jamás error)', async () => {
    // Fake gateway ad-hoc: listSessions ve la sesión STALE (gates pasan → cura) pero cureSession
    // informa que YA estaba cerrada (el cron ganó la carrera entre el listSessions y el cure).
    const seeded = session({ lastUpdate: '2026-07-16T11:30:00Z' }); // 30min stale
    const fakeGateway = {
      listSessions: jest.fn().mockResolvedValue([seeded]),
      cureSession: jest.fn().mockResolvedValue({ cured: false, alreadyClosed: true, closedAt: null, coa: [] }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const cureEventRepo = new InMemoryRadiusSessionCureEventRepository({ now: () => NOW });
    const useCase = new CureStuckSession(fakeGateway, cureEventRepo, TUNING);
    const result = await useCase.execute({ username: 'cliente001', trigger: 'auto', actorName: 'sistema', now: NOW });
    expect(result.outcome).toBe('already_cured');
    expect(cureEventRepo.all()[0]?.outcome).toBe('already_cured');
  });

  it('S3.3: orchestrator caído durante el cure → outcome failed, fila con reason', async () => {
    const gateway = new InMemoryRadiusOrchestratorGateway({
      unreachable: ['cliente001'],
      seed: [{ username: 'cliente001', sessions: [session()] }],
    });
    const cureEventRepo = new InMemoryRadiusSessionCureEventRepository({ now: () => NOW });
    const useCase = new CureStuckSession(gateway, cureEventRepo, TUNING);
    const result = await useCase.execute({ username: 'cliente001', trigger: 'auto', actorName: 'sistema', now: NOW });
    expect(result.outcome).toBe('failed');
    expect(cureEventRepo.all()[0]?.outcome).toBe('failed');
    expect(cureEventRepo.all()[0]?.reason).toBe('orchestrator_unreachable');
  });

  it('S5.1: cura auto por fast path → fila {trigger:auto, outcome:cured, actorName:sistema, signalUsed:persistent_rejects}', async () => {
    const { useCase, cureEventRepo } = build([session({ lastUpdate: '2026-07-16T11:59:00Z' })]);
    await useCase.execute({
      username: 'cliente001', trigger: 'auto', actorName: 'sistema', now: NOW,
      rejectAggregate: { firstReject: new Date('2026-07-16T11:53:00Z'), lastReject: new Date('2026-07-16T11:59:00Z') },
    });
    const row = cureEventRepo.all()[0];
    expect(row).toMatchObject({ trigger: 'auto', outcome: 'cured', actorName: 'sistema', signalUsed: 'persistent_rejects' });
  });

  it('S5.2: skip por sesión viva → fila {outcome:skipped_alive, signalUsed:null}', async () => {
    const { useCase, cureEventRepo } = build([session({ lastUpdate: '2026-07-16T11:59:00Z' })]);
    await useCase.execute({ username: 'cliente001', trigger: 'auto', actorName: 'sistema', now: NOW });
    const row = cureEventRepo.all()[0];
    expect(row?.outcome).toBe('skipped_alive');
    expect(row?.signalUsed).toBeNull();
  });

  // ── REQ-CURE-6 — manual (mismo core) ──────────────────────────────────────────────────────
  it('S6.1: manual sin force sobre sesión stale → cured + fila con actorName del operador', async () => {
    const { useCase, cureEventRepo } = build([session({ lastUpdate: '2026-07-16T11:30:00Z' })]); // 30min stale
    const result = await useCase.execute({ username: 'cliente001', trigger: 'manual', actorName: 'jgomez', now: NOW });
    expect(result.outcome).toBe('cured');
    expect(cureEventRepo.all()[0]?.actorName).toBe('jgomez');
    expect(cureEventRepo.all()[0]?.trigger).toBe('manual');
  });

  it('S6.2: manual sin force sobre sesión con interim fresco → skipped_alive + fila trigger manual', async () => {
    const { useCase, cureEventRepo } = build([session({ lastUpdate: '2026-07-16T11:59:00Z' })]);
    const result = await useCase.execute({ username: 'cliente001', trigger: 'manual', actorName: 'jgomez', now: NOW });
    expect(result.outcome).toBe('skipped_alive');
    expect(cureEventRepo.all()[0]?.trigger).toBe('manual');
  });

  it('S6.3: manual con force:true sobre sesión fresca → cured + fila con reason forced', async () => {
    const { useCase, cureEventRepo } = build([session({ lastUpdate: '2026-07-16T11:59:00Z' })]);
    const result = await useCase.execute({ username: 'cliente001', trigger: 'manual', actorName: 'jgomez', force: true, now: NOW });
    expect(result.outcome).toBe('cured');
    expect(cureEventRepo.all()[0]?.reason).toBe('forced');
  });

  it('S6.5: dos manuales seguidos del mismo username → AMBOS registran fila (sin throttle en manual)', async () => {
    const { useCase, cureEventRepo, gateway } = build([session({ lastUpdate: '2026-07-16T11:59:00Z' })]);
    await useCase.execute({ username: 'cliente001', trigger: 'manual', actorName: 'jgomez', now: NOW });
    // re-sembramos una segunda sesión fresca (la primera se curó/se fue) y repetimos.
    void gateway;
    const gw2 = new InMemoryRadiusOrchestratorGateway({ seed: [{ username: 'cliente001', sessions: [session({ sessionId: 'sid-2' })] }] });
    const uc2 = new CureStuckSession(gw2, cureEventRepo, TUNING);
    await uc2.execute({ username: 'cliente001', trigger: 'manual', actorName: 'jgomez', now: NOW });
    expect(cureEventRepo.all()).toHaveLength(2);
  });

  it('throttle de registro 6h: dos auto skipped_alive idénticos seguidos → 1 sola fila (throttled)', async () => {
    const { cureEventRepo, gateway } = build([session({ lastUpdate: '2026-07-16T11:59:00Z' })]);
    const useCase = new CureStuckSession(gateway, cureEventRepo, TUNING);
    const first = await useCase.execute({ username: 'cliente001', trigger: 'auto', actorName: 'sistema', now: NOW });
    const second = await useCase.execute({ username: 'cliente001', trigger: 'auto', actorName: 'sistema', now: NOW });
    expect(first.registrationThrottled).toBe(false);
    expect(second.registrationThrottled).toBe(true);
    expect(cureEventRepo.all()).toHaveLength(1);
  });
});
