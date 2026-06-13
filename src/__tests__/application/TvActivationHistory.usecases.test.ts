/**
 * TDD — TV activation history use cases + InMemory adapter (#5 BE).
 *
 * Red phase: tests for ListTvActivationHistory use case.
 * Also covers RegisterGigaredAccount event recording (alta/reactivacion)
 * and CancelTvJobRunner 'baja' recording.
 */
import { InMemoryTvActivationEventRepository } from '@infrastructure/adapters/in-memory/InMemoryTvActivationEventRepository';
import { ListTvActivationHistory } from '@application/use-cases/gigared/ListTvActivationHistory';

// ─── InMemory adapter unit ──────────────────────────────────────────────────

describe('InMemoryTvActivationEventRepository', () => {
  it('record + listByClient returns newest first', async () => {
    const t0 = new Date('2026-07-21T10:00:00.000Z');
    const t1 = new Date('2026-07-21T11:00:00.000Z');
    let tick = 0;
    const repo = new InMemoryTvActivationEventRepository({ now: () => (tick++ === 0 ? t0 : t1) });

    await repo.record({ clientId: 'c1', actorId: 'a1', actorName: 'Admin', eventType: 'alta' });
    await repo.record({ clientId: 'c1', actorId: 'a1', actorName: 'Admin', eventType: 'reactivacion' });

    const events = await repo.listByClient('c1');
    expect(events).toHaveLength(2);
    // newest first
    expect(events[0]!.eventType).toBe('reactivacion');
    expect(events[1]!.eventType).toBe('alta');
  });

  it('listByClient filters to that client only', async () => {
    const repo = new InMemoryTvActivationEventRepository();
    await repo.record({ clientId: 'c1', actorId: null, actorName: 'Sys', eventType: 'alta' });
    await repo.record({ clientId: 'c2', actorId: null, actorName: 'Sys', eventType: 'alta' });

    const events = await repo.listByClient('c1');
    expect(events).toHaveLength(1);
    expect(events[0]!.clientId).toBe('c1');
  });

  it('list filters by actorId', async () => {
    const repo = new InMemoryTvActivationEventRepository();
    await repo.record({ clientId: 'c1', actorId: 'a1', actorName: 'Admin1', eventType: 'alta' });
    await repo.record({ clientId: 'c2', actorId: 'a2', actorName: 'Admin2', eventType: 'alta' });

    const events = await repo.list({ actorId: 'a1' });
    expect(events).toHaveLength(1);
    expect(events[0]!.actorId).toBe('a1');
  });

  it('list filters by from/to date range', async () => {
    let tick = 0;
    const times = [
      new Date('2026-07-20T00:00:00.000Z'),
      new Date('2026-07-21T00:00:00.000Z'),
      new Date('2026-07-22T00:00:00.000Z'),
    ];
    const repo = new InMemoryTvActivationEventRepository({ now: () => times[tick++]! });

    await repo.record({ clientId: 'c1', actorId: null, actorName: 'S', eventType: 'alta' });
    await repo.record({ clientId: 'c1', actorId: null, actorName: 'S', eventType: 'reactivacion' });
    await repo.record({ clientId: 'c1', actorId: null, actorName: 'S', eventType: 'baja' });

    const events = await repo.list({
      from: new Date('2026-07-20T12:00:00.000Z'),
      to:   new Date('2026-07-21T12:00:00.000Z'),
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe('reactivacion');
  });

  it('stores cic, internalId, seq, contractId', async () => {
    const repo = new InMemoryTvActivationEventRepository();
    await repo.record({
      clientId: 'c1', actorId: 'a1', actorName: 'Op',
      eventType: 'alta', cic: '0000000001', internalId: 'c1', seq: 0, contractId: 'ct-1',
    });
    const events = await repo.listByClient('c1');
    expect(events[0]).toMatchObject({
      cic: '0000000001', internalId: 'c1', seq: 0, contractId: 'ct-1',
    });
  });

  it('returns immutable copies (mutation of result does not affect store)', async () => {
    const repo = new InMemoryTvActivationEventRepository();
    await repo.record({ clientId: 'c1', actorId: null, actorName: 'S', eventType: 'alta' });
    const [ev] = await repo.listByClient('c1');
    (ev as any).actorName = 'MUTATED';
    const [ev2] = await repo.listByClient('c1');
    expect(ev2!.actorName).toBe('S');
  });
});

// ─── ListTvActivationHistory use case ──────────────────────────────────────

describe('ListTvActivationHistory — global list', () => {
  it('returns all events newest first when no filters', async () => {
    let tick = 0;
    const times = [
      new Date('2026-07-21T09:00:00.000Z'),
      new Date('2026-07-21T10:00:00.000Z'),
    ];
    const repo = new InMemoryTvActivationEventRepository({ now: () => times[tick++]! });
    await repo.record({ clientId: 'c1', actorId: 'a1', actorName: 'Op1', eventType: 'alta' });
    await repo.record({ clientId: 'c2', actorId: 'a2', actorName: 'Op2', eventType: 'baja' });

    const uc = new ListTvActivationHistory(repo);
    const result = await uc.execute({});
    expect(result).toHaveLength(2);
    expect(result[0]!.eventType).toBe('baja'); // newest first
    expect(result[1]!.eventType).toBe('alta');
  });

  it('filters by actorId', async () => {
    const repo = new InMemoryTvActivationEventRepository();
    await repo.record({ clientId: 'c1', actorId: 'a1', actorName: 'Op1', eventType: 'alta' });
    await repo.record({ clientId: 'c2', actorId: 'a2', actorName: 'Op2', eventType: 'alta' });

    const uc = new ListTvActivationHistory(repo);
    const result = await uc.execute({ actorId: 'a1' });
    expect(result).toHaveLength(1);
    expect(result[0]!.actorId).toBe('a1');
  });

  it('filters by customerId (clientId)', async () => {
    const repo = new InMemoryTvActivationEventRepository();
    await repo.record({ clientId: 'c1', actorId: null, actorName: 'S', eventType: 'alta' });
    await repo.record({ clientId: 'c2', actorId: null, actorName: 'S', eventType: 'alta' });

    const uc = new ListTvActivationHistory(repo);
    const result = await uc.execute({ customerId: 'c1' });
    expect(result).toHaveLength(1);
    expect(result[0]!.clientId).toBe('c1');
  });

  it('maps to TvActivationEventDto shape', async () => {
    const repo = new InMemoryTvActivationEventRepository();
    await repo.record({
      clientId: 'c1', actorId: 'a1', actorName: 'Operator One',
      eventType: 'alta', cic: '0000000001', internalId: 'c1', seq: 0, contractId: 'ct-1',
    });

    const uc = new ListTvActivationHistory(repo);
    const [dto] = await uc.execute({});
    expect(dto).toMatchObject({
      clientId: 'c1',
      actorId: 'a1',
      actorName: 'Operator One',
      eventType: 'alta',
      cic: '0000000001',
      internalId: 'c1',
      seq: 0,
      contractId: 'ct-1',
    });
    expect(typeof dto!.id).toBe('string');
    expect(typeof dto!.createdAt).toBe('string');
  });
});

describe('ListTvActivationHistory — per-client list', () => {
  it('listByClient returns only events for that client, newest first', async () => {
    let tick = 0;
    const times = [
      new Date('2026-07-21T09:00:00.000Z'),
      new Date('2026-07-21T10:00:00.000Z'),
      new Date('2026-07-21T11:00:00.000Z'),
    ];
    const repo = new InMemoryTvActivationEventRepository({ now: () => times[tick++]! });
    await repo.record({ clientId: 'c1', actorId: 'a1', actorName: 'Op', eventType: 'alta' });
    await repo.record({ clientId: 'c2', actorId: 'a2', actorName: 'Op', eventType: 'alta' });
    await repo.record({ clientId: 'c1', actorId: 'a1', actorName: 'Op', eventType: 'reactivacion' });

    const uc = new ListTvActivationHistory(repo);
    const result = await uc.executeByClient('c1');
    expect(result).toHaveLength(2);
    expect(result[0]!.eventType).toBe('reactivacion'); // newest
    expect(result[1]!.eventType).toBe('alta');
    expect(result.every(e => e.clientId === 'c1')).toBe(true);
  });
});

// ─── #106 — customerName propagation ───────────────────────────────────────

describe('customerName propagation (#106)', () => {
  it('event with customerName flows through to DTO via execute()', async () => {
    const repo = new InMemoryTvActivationEventRepository();
    await repo.record({
      clientId: 'c1', actorId: 'a1', actorName: 'Op',
      eventType: 'alta', customerName: 'Juan Pérez',
    });

    const uc = new ListTvActivationHistory(repo);
    const [dto] = await uc.execute({});
    expect(dto!.customerName).toBe('Juan Pérez');
  });

  it('event with customerName flows through to DTO via executeByClient()', async () => {
    const repo = new InMemoryTvActivationEventRepository();
    await repo.record({
      clientId: 'c1', actorId: null, actorName: 'Sys',
      eventType: 'reactivacion', customerName: 'Ana López',
    });

    const uc = new ListTvActivationHistory(repo);
    const [dto] = await uc.executeByClient('c1');
    expect(dto!.customerName).toBe('Ana López');
  });

  it('event without customerName produces null in DTO', async () => {
    const repo = new InMemoryTvActivationEventRepository();
    await repo.record({
      clientId: 'c1', actorId: null, actorName: 'Sys', eventType: 'baja',
    });

    const uc = new ListTvActivationHistory(repo);
    const [dto] = await uc.execute({});
    expect(dto!.customerName).toBeNull();
  });
});
