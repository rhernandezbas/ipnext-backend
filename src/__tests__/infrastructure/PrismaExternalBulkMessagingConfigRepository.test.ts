/**
 * external-bulk-messaging (1.6) — PrismaExternalBulkMessagingConfigRepository.
 * Mocked-Prisma pattern. Molde `PrismaFinanceReceiptSyncConfigRepository`: fila
 * única `id:'singleton'`, `get()` sin fila → defaults en código (CONFIG-1),
 * `set()` hace upsert.
 */

jest.mock('../../infrastructure/database/prisma', () => ({
  prisma: {
    externalBulkMessagingConfig: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
    },
  },
}));

import { prisma } from '../../infrastructure/database/prisma';
import { PrismaExternalBulkMessagingConfigRepository } from '../../infrastructure/adapters/prisma/PrismaExternalBulkMessagingConfigRepository';

const mockPrisma = prisma as unknown as {
  externalBulkMessagingConfig: { findUnique: jest.Mock; upsert: jest.Mock };
};

describe('PrismaExternalBulkMessagingConfigRepository', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  /**
   * fix wave F1 (finding F14) — `get()` sin fila devolvia los defaults con un
   * `updatedAt: new Date().toISOString()` FABRICADO: el `GET` de la card admin
   * mostraba "actualizado hace un segundo" sobre una config que nadie toco
   * jamas, y cada lectura devolvia un timestamp distinto. La fila se crea
   * PEREZOSAMENTE (upsert con los defaults) para que `updatedAt` sea real y
   * estable. El shape del wire NO cambia.
   */
  it('get() sin fila previa crea la fila singleton con los defaults 500/2000 y devuelve su updatedAt REAL (CONFIG-1)', async () => {
    mockPrisma.externalBulkMessagingConfig.findUnique.mockResolvedValueOnce(null);
    mockPrisma.externalBulkMessagingConfig.upsert.mockResolvedValueOnce({
      id: 'singleton',
      maxPerRequest: 500,
      maxPerDay: 2000,
      updatedAt: new Date('2026-09-02T00:00:00.000Z'),
    });
    const repo = new PrismaExternalBulkMessagingConfigRepository();

    const config = await repo.get();

    expect(config.maxPerRequest).toBe(500);
    expect(config.maxPerDay).toBe(2000);
    expect(config.updatedAt).toBe('2026-09-02T00:00:00.000Z'); // real, no fabricado
    const call = mockPrisma.externalBulkMessagingConfig.upsert.mock.calls[0][0];
    expect(call.where).toEqual({ id: 'singleton' });
    expect(call.create).toEqual({ id: 'singleton', maxPerRequest: 500, maxPerDay: 2000 });
    expect(call.update).toEqual({}); // no pisa una fila que otro request acabe de crear
  });

  it('get() con la fila ausente Y el upsert fallando (DB read-only) degrada a los defaults, sin volter el GET', async () => {
    mockPrisma.externalBulkMessagingConfig.findUnique.mockResolvedValueOnce(null);
    mockPrisma.externalBulkMessagingConfig.upsert.mockRejectedValueOnce(new Error('read-only'));
    const repo = new PrismaExternalBulkMessagingConfigRepository();

    const config = await repo.get();

    expect(config.maxPerRequest).toBe(500);
    expect(config.maxPerDay).toBe(2000);
  });

  it('get() mapea la fila persistida', async () => {
    mockPrisma.externalBulkMessagingConfig.findUnique.mockResolvedValueOnce({
      id: 'singleton',
      maxPerRequest: 300,
      maxPerDay: 1500,
      updatedAt: new Date('2026-09-02T00:00:00.000Z'),
    });
    const repo = new PrismaExternalBulkMessagingConfigRepository();

    const config = await repo.get();

    expect(config.maxPerRequest).toBe(300);
    expect(config.maxPerDay).toBe(1500);
    expect(config.updatedAt).toBe('2026-09-02T00:00:00.000Z');
  });

  it('set() hace upsert sobre id:"singleton" con el patch', async () => {
    mockPrisma.externalBulkMessagingConfig.upsert.mockResolvedValueOnce({
      id: 'singleton',
      maxPerRequest: 300,
      maxPerDay: 1500,
      updatedAt: new Date('2026-09-02T00:00:00.000Z'),
    });
    const repo = new PrismaExternalBulkMessagingConfigRepository();

    const updated = await repo.set({ maxPerRequest: 300, maxPerDay: 1500 });

    expect(updated.maxPerRequest).toBe(300);
    expect(updated.maxPerDay).toBe(1500);
    const call = mockPrisma.externalBulkMessagingConfig.upsert.mock.calls[0][0];
    expect(call.where).toEqual({ id: 'singleton' });
    expect(call.create).toEqual({ id: 'singleton', maxPerRequest: 300, maxPerDay: 1500 });
    expect(call.update).toEqual({ maxPerRequest: 300, maxPerDay: 1500 });
  });
});
