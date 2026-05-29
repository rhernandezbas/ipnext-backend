import { foldClientStats } from '../../infrastructure/adapters/prisma/PrismaCustomerRepository';

type Group = { status: string; _count: { _all: number } };

const group = (status: string, count: number): Group => ({
  status,
  _count: { _all: count },
});

describe('PrismaCustomerRepository.foldClientStats', () => {
  it('folds each status group into its bucket and totals the sum', () => {
    const stats = foldClientStats([
      group('active', 5),
      group('inactive', 2),
      group('blocked', 1),
      group('late', 3),
    ]);

    expect(stats).toEqual({
      total: 11,
      active: 5,
      inactive: 2,
      blocked: 1,
      late: 3,
      baja: 0,
    });
  });

  it('captures the baja status in its own bucket', () => {
    const stats = foldClientStats([
      group('active', 4),
      group('baja', 7),
    ]);

    expect(stats.baja).toBe(7);
  });

  it('keeps total equal to the sum of all per-status buckets when baja is present', () => {
    const stats = foldClientStats([
      group('active', 10),
      group('late', 4),
      group('blocked', 2),
      group('inactive', 3),
      group('baja', 6),
    ]);

    const bucketSum =
      stats.active + stats.late + stats.blocked + stats.inactive + stats.baja;

    expect(stats.total).toBe(25);
    expect(stats.total).toBe(bucketSum);
  });
});
