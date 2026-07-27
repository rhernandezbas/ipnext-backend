import { InMemoryTeamLocationRepository } from '@infrastructure/adapters/in-memory/InMemoryTeamLocationRepository';
import type { TeamLocationPoint } from '@domain/entities/team-location-point';

const p = (
  iso: string,
  lat = -34.65,
  lon = -59.44,
  sources: number[] = [1],
  teamLogin = 'IPNXANDYM',
  accuracyMeters = 7.5,
): TeamLocationPoint => ({
  teamLogin,
  latitude: lat,
  longitude: lon,
  recordedAt: new Date(iso),
  accuracyMeters,
  sources,
});

describe('InMemoryTeamLocationRepository', () => {
  let repo: InMemoryTeamLocationRepository;
  beforeEach(() => {
    repo = new InMemoryTeamLocationRepository();
  });

  describe('saveMany — deduplication', () => {
    it('inserts distinct points', async () => {
      const r = await repo.saveMany([p('2026-07-26T12:00:00Z'), p('2026-07-26T12:10:00Z')]);
      expect(r).toEqual({ inserted: 2, duplicates: 0 });
    });

    it('collapses the SAME fix reported by two sources into one row', async () => {
      // Observado en vivo: origem 1 y origem 3 con timestamp y coordenadas IDÉNTICOS.
      const r = await repo.saveMany([
        p('2026-07-26T12:01:45Z', -34.6585133333, -59.4541083333, [1]),
        p('2026-07-26T12:01:45Z', -34.6585133333, -59.4541083333, [3]),
      ]);
      expect(r).toEqual({ inserted: 1, duplicates: 1 });

      const all = await repo.findByTeamInWindow('IPNXANDYM', {
        from: new Date('2026-07-26T00:00:00Z'),
        to: new Date('2026-07-27T00:00:00Z'),
      });
      expect(all).toHaveLength(1);
      // Ambos orígenes se conservan: no se pierde información al deduplicar.
      expect(all[0].sources.sort()).toEqual([1, 3]);
    });

    it('is IDEMPOTENT — re-ingesting the same window does not duplicate', async () => {
      const batch = [p('2026-07-26T12:00:00Z'), p('2026-07-26T12:10:00Z')];
      await repo.saveMany(batch);
      const second = await repo.saveMany(batch);

      expect(second).toEqual({ inserted: 0, duplicates: 2 });
      const all = await repo.findByTeamInWindow('IPNXANDYM', {
        from: new Date('2026-07-26T00:00:00Z'),
        to: new Date('2026-07-27T00:00:00Z'),
      });
      expect(all).toHaveLength(2);
    });

    it('does NOT treat different teams at the same instant as duplicates', async () => {
      const r = await repo.saveMany([
        p('2026-07-26T12:00:00Z', -34.65, -59.44, [1], 'IPNXANDYM'),
        p('2026-07-26T12:00:00Z', -34.65, -59.44, [1], 'IPNXDENIC'),
      ]);
      expect(r.inserted).toBe(2);
    });

    it('does NOT treat different coordinates at the same instant as duplicates', async () => {
      const r = await repo.saveMany([
        p('2026-07-26T12:00:00Z', -34.65, -59.44),
        p('2026-07-26T12:00:00Z', -34.66, -59.45),
      ]);
      expect(r.inserted).toBe(2);
    });
  });

  describe('findByTeamInWindow', () => {
    beforeEach(async () => {
      await repo.saveMany([
        p('2026-07-26T11:00:00Z'),
        p('2026-07-26T12:00:00Z', -34.66),
        p('2026-07-26T13:00:00Z', -34.67),
        p('2026-07-26T12:30:00Z', -34.68, -59.44, [1], 'IPNXDENIC'),
      ]);
    });

    it('returns only points of that team inside the window, chronologically', async () => {
      const res = await repo.findByTeamInWindow('IPNXANDYM', {
        from: new Date('2026-07-26T11:30:00Z'),
        to: new Date('2026-07-26T12:30:00Z'),
      });
      expect(res).toHaveLength(1);
      expect(res[0].recordedAt.toISOString()).toBe('2026-07-26T12:00:00.000Z');
    });

    it('is inclusive on both bounds', async () => {
      const res = await repo.findByTeamInWindow('IPNXANDYM', {
        from: new Date('2026-07-26T11:00:00Z'),
        to: new Date('2026-07-26T13:00:00Z'),
      });
      expect(res).toHaveLength(3);
      expect(res.map((x) => x.recordedAt.toISOString())).toEqual([
        '2026-07-26T11:00:00.000Z',
        '2026-07-26T12:00:00.000Z',
        '2026-07-26T13:00:00.000Z',
      ]);
    });

    it('returns empty for a team with no points — never throws', async () => {
      await expect(
        repo.findByTeamInWindow('IPNXSEBAM', {
          from: new Date('2026-07-26T00:00:00Z'),
          to: new Date('2026-07-27T00:00:00Z'),
        }),
      ).resolves.toEqual([]);
    });
  });

  describe('findWatermark', () => {
    it('returns the most recent recordedAt for the team', async () => {
      await repo.saveMany([
        p('2026-07-26T11:00:00Z'),
        p('2026-07-26T13:00:00Z', -34.67),
        p('2026-07-26T12:00:00Z', -34.66),
      ]);
      const w = await repo.findWatermark('IPNXANDYM');
      expect(w!.toISOString()).toBe('2026-07-26T13:00:00.000Z');
    });

    it('returns null for a team with no points (first ingest)', async () => {
      await expect(repo.findWatermark('IPNXNUEVO')).resolves.toBeNull();
    });
  });

  describe('findLatestPerTeam', () => {
    it('returns one point per team — the newest of each', async () => {
      await repo.saveMany([
        p('2026-07-26T11:00:00Z', -34.65, -59.44, [1], 'IPNXANDYM'),
        p('2026-07-26T13:00:00Z', -34.67, -59.44, [1], 'IPNXANDYM'),
        p('2026-07-24T11:00:00Z', -34.64, -59.43, [1], 'IPNXRODRIGOS'),
      ]);
      const latest = await repo.findLatestPerTeam();
      expect(latest).toHaveLength(2);
      const byTeam = Object.fromEntries(latest.map((x) => [x.teamLogin, x.recordedAt.toISOString()]));
      expect(byTeam['IPNXANDYM']).toBe('2026-07-26T13:00:00.000Z');
      expect(byTeam['IPNXRODRIGOS']).toBe('2026-07-24T11:00:00.000Z');
    });
  });

  describe('findByTeamOnDay — Argentina calendar day', () => {
    it('groups by the ARGENTINA day, not the UTC day', async () => {
      // 01-07 21:53 AR == 02-07 00:53 UTC. Agrupar por UTC lo pondría en el día equivocado.
      await repo.saveMany([
        p('2026-07-02T00:53:37Z'), // 21:53 del 01-07 en Argentina
        p('2026-07-02T15:00:00Z', -34.66), // 12:00 del 02-07 en Argentina
      ]);

      const day1 = await repo.findByTeamOnDay('IPNXANDYM', '2026-07-01');
      const day2 = await repo.findByTeamOnDay('IPNXANDYM', '2026-07-02');
      expect(day1).toHaveLength(1);
      expect(day2).toHaveLength(1);
      expect(day1[0].recordedAt.toISOString()).toBe('2026-07-02T00:53:37.000Z');
    });
  });

  describe('purgeOlderThan', () => {
    it('deletes points before the cutoff and reports the count', async () => {
      await repo.saveMany([
        p('2025-06-01T12:00:00Z'),
        p('2025-06-02T12:00:00Z', -34.66),
        p('2026-07-26T12:00:00Z', -34.67),
      ]);
      const purged = await repo.purgeOlderThan(new Date('2026-01-01T00:00:00Z'));
      expect(purged).toBe(2);

      const rest = await repo.findByTeamInWindow('IPNXANDYM', {
        from: new Date('2020-01-01T00:00:00Z'),
        to: new Date('2030-01-01T00:00:00Z'),
      });
      expect(rest).toHaveLength(1);
    });

    it('returns 0 when nothing is old enough', async () => {
      await repo.saveMany([p('2026-07-26T12:00:00Z')]);
      await expect(repo.purgeOlderThan(new Date('2020-01-01T00:00:00Z'))).resolves.toBe(0);
    });
  });

  describe('recordIngestRun', () => {
    it('stores the run summary for observability', async () => {
      await repo.recordIngestRun({
        startedAt: new Date('2026-07-26T12:00:00Z'),
        finishedAt: new Date('2026-07-26T12:02:00Z'),
        teamsProcessed: 6,
        pointsNew: 120,
        pointsDuplicate: 40,
        pointsPurged: 0,
        pagesRead: 14,
        pointsDropped: 0,
        incompleteTeams: ['IPNXEMAV'],
      });
      const runs = repo.runs;
      expect(runs).toHaveLength(1);
      expect(runs[0].incompleteTeams).toEqual(['IPNXEMAV']);
      expect(runs[0].pointsNew).toBe(120);
    });
  });
});
