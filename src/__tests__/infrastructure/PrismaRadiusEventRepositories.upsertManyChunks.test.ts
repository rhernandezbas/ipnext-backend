/**
 * Regresión del incidente 2026-07-26 (crash loop por heap de V8).
 *
 * Los dos repos de ingest RADIUS mandaban TODOS los upserts de la página en UN solo
 * `$transaction(rows.map(...))`. Cada upsert es un round-trip propio, así que con la
 * DB lenta el lote se pasaba del timeout de Prisma (medido en prod: 5245 ms contra
 * 5000 ms) y el ingest fallaba. Ese fallo, combinado con el `cursor: null` del catch
 * del scheduler, disparaba la espiral que reventaba el heap.
 *
 * Estos tests pinean que el upsert se parte en lotes acotados: cada `$transaction`
 * recibe como mucho UPSERT_CHUNK_SIZE operaciones, y el total devuelto no cambia.
 *
 * Tradeoff documentado: chunkear pierde la atomicidad "todo o nada" de la página.
 * Es SEGURO porque el upsert es idempotente por `sourceUniqueId` — si un lote falla,
 * el cursor NO avanza (se preserva, ver RadiusAuthIngestScheduler) y el próximo tick
 * re-upsertea los lotes ya aplicados sin duplicar nada.
 */
jest.mock('../../infrastructure/database/prisma', () => ({
  prisma: {
    radiusAuthEvent: { upsert: jest.fn((args: unknown) => args) },
    radiusEvent:     { upsert: jest.fn((args: unknown) => args) },
    $transaction:    jest.fn(async (ops: unknown[]) => ops),
  },
}));

import { prisma } from '../../infrastructure/database/prisma';
import {
  PrismaRadiusAuthEventRepository,
  UPSERT_CHUNK_SIZE as AUTH_CHUNK,
} from '../../infrastructure/adapters/prisma/PrismaRadiusAuthEventRepository';
import {
  PrismaRadiusEventRepository,
  UPSERT_CHUNK_SIZE as ACCT_CHUNK,
} from '../../infrastructure/adapters/prisma/PrismaRadiusEventRepository';

const mockPrisma = prisma as unknown as { $transaction: jest.Mock };

beforeEach(() => {
  mockPrisma.$transaction.mockClear();
});

function authRows(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    sourceUniqueId: `pa-${i}`,
    username:       `u${i}`,
    reply:          'Access-Reject' as const,
    authdate:       new Date('2026-07-26T10:00:00Z'),
    class:          null,
    reason:         null,
  }));
}

describe('PrismaRadiusAuthEventRepository.upsertMany — chunking', () => {
  it('parte en lotes de a lo sumo UPSERT_CHUNK_SIZE en vez de una transaccion gigante', async () => {
    const repo  = new PrismaRadiusAuthEventRepository();
    const total = AUTH_CHUNK * 3 + 7;

    const written = await repo.upsertMany(authRows(total) as never);

    expect(written).toBe(total);
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(Math.ceil(total / AUTH_CHUNK));
    for (const call of mockPrisma.$transaction.mock.calls) {
      expect((call[0] as unknown[]).length).toBeLessThanOrEqual(AUTH_CHUNK);
    }
  });

  it('una pagina chica sigue siendo UNA sola transaccion (sin regresion de overhead)', async () => {
    const repo = new PrismaRadiusAuthEventRepository();
    await repo.upsertMany(authRows(3) as never);
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('lista vacia no toca la DB', async () => {
    const repo = new PrismaRadiusAuthEventRepository();
    expect(await repo.upsertMany([])).toBe(0);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('PrismaRadiusEventRepository.upsertMany — chunking', () => {
  function acctRows(n: number) {
    return Array.from({ length: n }, (_, i) => ({
      sourceUniqueId: `acct-${i}`,
      username:       `u${i}`,
      nasId:          null,
      nasIpAddress:   '10.60.0.46',
      framedIp:       null,
      startedAt:      new Date('2026-07-26T10:00:00Z'),
      lastUpdate:     null,
      stoppedAt:      null,
      terminateCause: null,
      callingStationId: null,
    }));
  }

  it('parte en lotes de a lo sumo UPSERT_CHUNK_SIZE', async () => {
    const repo  = new PrismaRadiusEventRepository();
    const total = ACCT_CHUNK * 2 + 1;

    const written = await repo.upsertMany(acctRows(total) as never);

    expect(written).toBe(total);
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(Math.ceil(total / ACCT_CHUNK));
    for (const call of mockPrisma.$transaction.mock.calls) {
      expect((call[0] as unknown[]).length).toBeLessThanOrEqual(ACCT_CHUNK);
    }
  });

  it('lista vacia no toca la DB', async () => {
    const repo = new PrismaRadiusEventRepository();
    expect(await repo.upsertMany([])).toBe(0);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });
});
