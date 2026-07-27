/**
 * Unit tests de PrismaTeamLocationRepository.
 * Mockea el singleton de Prisma — sin DB real. Mismo patrón que
 * PrismaIClassSoTypeRepository.test.ts.
 */

jest.mock('../../infrastructure/database/prisma', () => ({
  prisma: {
    teamLocationPoint: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      deleteMany: jest.fn(),
    },
    teamLocationIngestRun: {
      create: jest.fn(),
    },
    teamLocationIngestState: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
    },
    $queryRaw: jest.fn(),
  },
}));

import { PrismaTeamLocationRepository } from '../../infrastructure/adapters/prisma/PrismaTeamLocationRepository';
import { prisma } from '../../infrastructure/database/prisma';
import type { TeamLocationPoint } from '@domain/entities/team-location-point';

type MockPrisma = {
  teamLocationPoint: {
    findMany: jest.Mock;
    findFirst: jest.Mock;
    deleteMany: jest.Mock;
  };
  teamLocationIngestRun: { create: jest.Mock };
  teamLocationIngestState: { findUnique: jest.Mock; upsert: jest.Mock };
  $queryRaw: jest.Mock;
};
const mockPrisma = prisma as unknown as MockPrisma;

const point = (
  iso: string,
  lat = -34.65,
  lon = -59.44,
  sources: number[] = [1],
  teamLogin = 'IPNXANDYM',
): TeamLocationPoint => ({
  teamLogin,
  latitude: lat,
  longitude: lon,
  recordedAt: new Date(iso),
  accuracyMeters: 7.5,
  sources,
});

const row = (iso: string, lat = -34.65, lon = -59.44, teamLogin = 'IPNXANDYM') => ({
  id: 'uuid',
  teamLogin,
  latitude: lat,
  longitude: lon,
  recordedAt: new Date(iso),
  accuracyM: 7.5,
  sources: [1],
  ingestedAt: new Date(iso),
});

describe('PrismaTeamLocationRepository', () => {
  let repo: PrismaTeamLocationRepository;
  beforeEach(() => {
    jest.clearAllMocks();
    repo = new PrismaTeamLocationRepository();
  });

  describe('saveMany', () => {
    /** `xmax = 0` ⇒ la fila fue INSERT; `false` ⇒ fue UPDATE (ya existía). */
    const outcome = (inserts: number, updates: number) => [
      ...Array.from({ length: inserts }, () => ({ was_insert: true })),
      ...Array.from({ length: updates }, () => ({ was_insert: false })),
    ];

    it('merges sources on conflict instead of discarding the row', async () => {
      // Hallazgo 4.3: `createMany({skipDuplicates})` descartaba la fila entera, así que
      // un `origem` que llegaba en OTRA corrida se perdía en silencio — mientras el
      // in-memory sí lo mergeaba. Contadores iguales, datos distintos.
      mockPrisma.$queryRaw.mockResolvedValue(outcome(0, 1));

      const res = await repo.saveMany([point('2026-07-26T12:00:00Z')]);

      const sql = mockPrisma.$queryRaw.mock.calls[0][0];
      const text = JSON.stringify(sql);
      expect(text).toContain('ON CONFLICT');
      expect(text).toContain('DO UPDATE');
      expect(text).toContain('unnest');
      expect(res).toEqual({ inserted: 0, duplicates: 1 });
    });

    it('counts inserts and updates separately via xmax', async () => {
      mockPrisma.$queryRaw.mockResolvedValue(outcome(2, 1));
      const res = await repo.saveMany([
        point('2026-07-26T12:00:00Z'),
        point('2026-07-26T12:10:00Z', -34.66),
        point('2026-07-26T12:20:00Z', -34.67),
      ]);
      expect(res).toEqual({ inserted: 2, duplicates: 1 });
    });

    it('collapses within-batch duplicates BEFORE hitting the DB, merging sources', async () => {
      mockPrisma.$queryRaw.mockResolvedValue(outcome(1, 0));

      const res = await repo.saveMany([
        point('2026-07-26T12:01:45Z', -34.6585, -59.4541, [1]),
        point('2026-07-26T12:01:45Z', -34.6585, -59.4541, [3]),
      ]);

      // Un solo punto físico llega a la base, y el duplicado intra-lote se cuenta.
      expect(res).toEqual({ inserted: 1, duplicates: 1 });
    });

    it('CHUNKS large batches so they cannot blow past the 65535 bind-param cap', async () => {
      // `createMany` de Prisma chunkea solo; `$queryRaw` NO. Al pasar al upsert crudo se
      // perdió esa red: 20.000 puntos × 6 params = 120.000 binds > 65.535, con un fallo
      // determinista Y ETERNO (el watermark contiguo no avanzaría nunca).
      mockPrisma.$queryRaw.mockImplementation(async () => outcome(500, 0));

      const many = Array.from({ length: 1200 }, (_, i) =>
        point(new Date(Date.UTC(2026, 6, 26, 0, i)).toISOString(), -34.65 - i * 0.0001),
      );
      await repo.saveMany(many);

      // 1200 filas / 500 por statement = 3 llamadas.
      expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(3);
    });

    it('does not hit the DB for an empty batch', async () => {
      const res = await repo.saveMany([]);
      expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
      expect(res).toEqual({ inserted: 0, duplicates: 0 });
    });
  });

  describe('findByTeamInWindow', () => {
    it('queries by team and inclusive time bounds, ordered chronologically', async () => {
      mockPrisma.teamLocationPoint.findMany.mockResolvedValue([row('2026-07-26T12:00:00Z')]);

      const res = await repo.findByTeamInWindow('IPNXANDYM', {
        from: new Date('2026-07-26T11:00:00Z'),
        to: new Date('2026-07-26T13:00:00Z'),
      });

      expect(mockPrisma.teamLocationPoint.findMany).toHaveBeenCalledWith({
        where: {
          teamLogin: 'IPNXANDYM',
          recordedAt: { gte: new Date('2026-07-26T11:00:00Z'), lte: new Date('2026-07-26T13:00:00Z') },
        },
        orderBy: { recordedAt: 'asc' },
      });
      expect(res).toHaveLength(1);
      expect(res[0].accuracyMeters).toBe(7.5);
      expect(res[0].teamLogin).toBe('IPNXANDYM');
    });
  });

  describe('findByTeamOnDay', () => {
    it('translates an Argentina calendar day into the right UTC range', async () => {
      mockPrisma.teamLocationPoint.findMany.mockResolvedValue([]);
      await repo.findByTeamOnDay('IPNXANDYM', '2026-07-01');

      // 01-07 00:00 AR == 01-07 03:00 UTC ; 02-07 00:00 AR == 02-07 03:00 UTC
      const arg = mockPrisma.teamLocationPoint.findMany.mock.calls[0][0];
      expect(arg.where.recordedAt.gte.toISOString()).toBe('2026-07-01T03:00:00.000Z');
      expect(arg.where.recordedAt.lt.toISOString()).toBe('2026-07-02T03:00:00.000Z');
    });

    it('returns [] for an impossible calendar date instead of serving ANOTHER day', async () => {
      // Hallazgo 4.2: `Date.UTC(2026,1,31)` desborda al 3 de marzo, así que
      // `?day=2026-02-31` servía el rastro REAL del 3 de marzo etiquetado como
      // 31 de febrero — en un endpoint de auditoría sobre personas. El in-memory
      // devolvía [], o sea que los tests de use case mentían sobre producción.
      mockPrisma.teamLocationPoint.findMany.mockResolvedValue([]);
      const res = await repo.findByTeamOnDay('IPNXANDYM', '2026-02-31');
      expect(res).toEqual([]);
      expect(mockPrisma.teamLocationPoint.findMany).not.toHaveBeenCalled();
    });
  });

  describe('findWatermark', () => {
    it('returns the newest recordedAt for the team', async () => {
      mockPrisma.teamLocationPoint.findFirst.mockResolvedValue(row('2026-07-26T13:00:00Z'));
      const w = await repo.findWatermark('IPNXANDYM');
      expect(w!.toISOString()).toBe('2026-07-26T13:00:00.000Z');
      expect(mockPrisma.teamLocationPoint.findFirst).toHaveBeenCalledWith({
        where: { teamLogin: 'IPNXANDYM' },
        orderBy: { recordedAt: 'desc' },
      });
    });

    it('returns null on first ingest', async () => {
      mockPrisma.teamLocationPoint.findFirst.mockResolvedValue(null);
      await expect(repo.findWatermark('IPNXNUEVO')).resolves.toBeNull();
    });
  });

  describe('findLatestPerTeam', () => {
    it('uses a REAL Postgres DISTINCT ON, not Prisma-side dedup', async () => {
      // Hallazgo 4.1: verificado compilando el query, el `distinct` de Prisma 7 NO se
      // traduce a DISTINCT ON — trae la tabla entera y deduplica en Node (~90 MB por
      // request a 432k filas). Este test asserta el SQL, no los argumentos que se le
      // pasan a Prisma: el test anterior verificaba lo que PEDÍA, no lo que PASABA.
      mockPrisma.$queryRaw.mockResolvedValue([
        row('2026-07-26T13:00:00Z', -34.65, -59.44, 'IPNXANDYM'),
        row('2026-07-24T11:00:00Z', -34.64, -59.43, 'IPNXRODRIGOS'),
      ]);

      const res = await repo.findLatestPerTeam();

      const text = JSON.stringify(mockPrisma.$queryRaw.mock.calls[0][0]);
      expect(text).toContain('DISTINCT ON');
      expect(text).toContain('ORDER BY');
      expect(res).toHaveLength(2);
      expect(res[0].teamLogin).toBe('IPNXANDYM');
    });
  });

  describe('purgeOlderThan', () => {
    it('deletes strictly before the cutoff and returns the count', async () => {
      mockPrisma.teamLocationPoint.deleteMany.mockResolvedValue({ count: 42 });
      const purged = await repo.purgeOlderThan(new Date('2025-07-26T00:00:00Z'));
      expect(purged).toBe(42);
      expect(mockPrisma.teamLocationPoint.deleteMany).toHaveBeenCalledWith({
        where: { recordedAt: { lt: new Date('2025-07-26T00:00:00Z') } },
      });
    });
  });

  describe('recordIngestRun', () => {
    it('persists the run summary including incomplete teams', async () => {
      mockPrisma.teamLocationIngestRun.create.mockResolvedValue({});
      await repo.recordIngestRun({
        startedAt: new Date('2026-07-26T12:00:00Z'),
        finishedAt: new Date('2026-07-26T12:02:00Z'),
        teamsProcessed: 6,
        pointsNew: 120,
        pointsDuplicate: 40,
        pointsPurged: 3,
        pagesRead: 14,
        pointsDropped: 0,
        incompleteTeams: ['IPNXEMAV'],
      });
      const arg = mockPrisma.teamLocationIngestRun.create.mock.calls[0][0];
      expect(arg.data.incompleteTeams).toEqual(['IPNXEMAV']);
      expect(arg.data.pointsNew).toBe(120);
    });
  });
});
