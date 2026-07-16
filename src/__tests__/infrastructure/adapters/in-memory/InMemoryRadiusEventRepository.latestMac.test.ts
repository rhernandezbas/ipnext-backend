/**
 * InMemoryRadiusEventRepository.latestMacByUsernames — CAS-1.
 *
 * Batch resolver: for each username, the macAddress of the "best" event — prefers
 * status='online' (stoppedAt IS NULL); if none online, the most recent startedAt among
 * events with macAddress != null. Usernames with no MAC-bearing event are OMITTED from
 * the returned Map (never a key with undefined/null value).
 */
import { InMemoryRadiusEventRepository } from '@infrastructure/adapters/in-memory/InMemoryRadiusEventRepository';
import type { RadiusEventUpsert } from '@domain/ports/RadiusEventRepository';

function makeRow(overrides: Partial<RadiusEventUpsert> & { sourceUniqueId: string; username: string }): RadiusEventUpsert {
  return {
    nasIpAddress: '10.0.0.1',
    nasId: 'nas-1',
    framedIp: null,
    macAddress: null,
    vlanId: null,
    startedAt: new Date('2026-07-01T00:00:00Z'),
    stoppedAt: null,
    sessionTime: null,
    bytesIn: BigInt(0),
    bytesOut: BigInt(0),
    eventType: 'start',
    status: 'online',
    ...overrides,
  };
}

describe('InMemoryRadiusEventRepository.latestMacByUsernames', () => {
  it('prefers the ONLINE event mac over a more recent closed event', async () => {
    const repo = new InMemoryRadiusEventRepository();
    await repo.upsertMany([
      makeRow({
        sourceUniqueId: 'u1-closed',
        username: 'u1',
        macAddress: 'M1',
        startedAt: new Date('2026-07-15T00:00:00Z'), // ayer
        stoppedAt: new Date('2026-07-15T05:00:00Z'),
        status: 'closed',
      }),
      makeRow({
        sourceUniqueId: 'u1-online',
        username: 'u1',
        macAddress: 'M2',
        startedAt: new Date('2026-07-14T00:00:00Z'), // anteayer, pero ONLINE
        stoppedAt: null,
        status: 'online',
      }),
    ]);

    const result = await repo.latestMacByUsernames(['u1']);
    expect(result.get('u1')).toBe('M2');
  });

  it('no online event → falls back to the most recent startedAt WITH a mac', async () => {
    const repo = new InMemoryRadiusEventRepository();
    await repo.upsertMany([
      makeRow({
        sourceUniqueId: 'u2-today-nomac',
        username: 'u2',
        macAddress: null,
        startedAt: new Date('2026-07-16T00:00:00Z'), // hoy — pero SIN mac, se ignora
        stoppedAt: new Date('2026-07-16T01:00:00Z'),
        status: 'closed',
      }),
      makeRow({
        sourceUniqueId: 'u2-yesterday',
        username: 'u2',
        macAddress: 'M3',
        startedAt: new Date('2026-07-15T00:00:00Z'), // ayer
        stoppedAt: new Date('2026-07-15T02:00:00Z'),
        status: 'closed',
      }),
      makeRow({
        sourceUniqueId: 'u2-daybefore',
        username: 'u2',
        macAddress: 'M4',
        startedAt: new Date('2026-07-14T00:00:00Z'), // anteayer
        stoppedAt: new Date('2026-07-14T02:00:00Z'),
        status: 'closed',
      }),
    ]);

    const result = await repo.latestMacByUsernames(['u2']);
    expect(result.get('u2')).toBe('M3');
  });

  it('username with no MAC-bearing event is OMITTED from the Map', async () => {
    const repo = new InMemoryRadiusEventRepository();
    await repo.upsertMany([
      makeRow({
        sourceUniqueId: 'u1-online',
        username: 'u1',
        macAddress: 'M2',
        status: 'online',
      }),
      // u3 has an event but with macAddress null — must NOT resolve
      makeRow({
        sourceUniqueId: 'u3-nomac',
        username: 'u3',
        macAddress: null,
        status: 'online',
      }),
    ]);

    const result = await repo.latestMacByUsernames(['u1', 'u3']);
    expect(result.has('u1')).toBe(true);
    expect(result.has('u3')).toBe(false);
  });

  it('resolves a full batch of usernames in one call, without N+1 semantics leaking through', async () => {
    const repo = new InMemoryRadiusEventRepository();
    await repo.upsertMany([
      makeRow({ sourceUniqueId: 'a1', username: 'alice', macAddress: 'AA', status: 'online' }),
      makeRow({ sourceUniqueId: 'b1', username: 'bob', macAddress: 'BB', status: 'online' }),
      makeRow({ sourceUniqueId: 'c1', username: 'carol', macAddress: null, status: 'online' }),
    ]);

    const result = await repo.latestMacByUsernames(['alice', 'bob', 'carol', 'dave']);
    expect(result.get('alice')).toBe('AA');
    expect(result.get('bob')).toBe('BB');
    expect(result.has('carol')).toBe(false);
    expect(result.has('dave')).toBe(false);
    expect(result.size).toBe(2);
  });
});
