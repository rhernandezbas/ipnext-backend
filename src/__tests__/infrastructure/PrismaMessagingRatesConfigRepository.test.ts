/**
 * twilio-credit-guard (1.7) — PrismaMessagingRatesConfigRepository. Mocked-Prisma
 * pattern (molde `PrismaExternalBulkMessagingConfigRepository.test.ts`). Fila única
 * `id:'singleton'`, `get()` sin fila → lazy upsert con defaults (F14), `set()`
 * hace upsert. Frontera Decimal ↔ string: `row.utilityRate.toFixed(4)` al leer,
 * string tal cual al escribir — NUNCA `Number(row.rate)` (D2).
 */

jest.mock('../../infrastructure/database/prisma', () => ({
  prisma: {
    messagingRatesConfig: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
    },
  },
}));

import { prisma } from '../../infrastructure/database/prisma';
import { PrismaMessagingRatesConfigRepository } from '../../infrastructure/adapters/prisma/PrismaMessagingRatesConfigRepository';

const mockPrisma = prisma as unknown as {
  messagingRatesConfig: { findUnique: jest.Mock; upsert: jest.Mock };
};

// Fake Prisma Decimal — mismo patrón que CustomerBalanceMapper.test.ts.
function dec(s: string) {
  return { toFixed: (n: number) => Number(s).toFixed(n) };
}

describe('PrismaMessagingRatesConfigRepository', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('get() sin fila previa crea la fila singleton con los 5 defaults (F14, lazy upsert) y devuelve su updatedAt REAL', async () => {
    mockPrisma.messagingRatesConfig.findUnique.mockResolvedValueOnce(null);
    mockPrisma.messagingRatesConfig.upsert.mockResolvedValueOnce({
      id: 'singleton',
      currency: 'USD',
      utilityRate: dec('0.0120'),
      marketingRate: dec('0.0618'),
      authenticationRate: dec('0.0220'),
      providerFee: dec('0.0050'),
      updatedAt: new Date('2026-09-03T00:00:00.000Z'),
    });
    const repo = new PrismaMessagingRatesConfigRepository();

    const config = await repo.get();

    expect(config.currency).toBe('USD');
    expect(config.utilityRate).toBe('0.0120');
    expect(config.marketingRate).toBe('0.0618');
    expect(config.authenticationRate).toBe('0.0220');
    expect(config.providerFee).toBe('0.0050');
    expect(config.updatedAt).toBe('2026-09-03T00:00:00.000Z'); // real, no fabricado
    const call = mockPrisma.messagingRatesConfig.upsert.mock.calls[0][0];
    expect(call.where).toEqual({ id: 'singleton' });
    expect(call.create).toEqual({
      id: 'singleton',
      currency: 'USD',
      utilityRate: '0.0120',
      marketingRate: '0.0618',
      authenticationRate: '0.0220',
      providerFee: '0.0050',
    });
    expect(call.update).toEqual({}); // no pisa una fila que otro request acabe de crear
  });

  /**
   * fix wave F1 (F4) — el fallback a defaults SE ELIMINÓ. Un repo que "degrada
   * a los defaults" cuando la DB no responde le MIENTE al gate de crédito: el
   * `send` decidiría gastar plata real con una tarifa inventada, y el
   * `validate` mostraría un costo que no es el que la casa cobra. El único
   * camino que devuelve defaults es el lazy-create FELIZ (con `updatedAt` REAL
   * de la fila creada).
   */
  it('get() con la fila ausente Y el upsert fallando (DB read-only) TIRA — nunca inventa tarifas', async () => {
    mockPrisma.messagingRatesConfig.findUnique.mockResolvedValueOnce(null);
    mockPrisma.messagingRatesConfig.upsert.mockRejectedValueOnce(new Error('read-only'));
    const repo = new PrismaMessagingRatesConfigRepository();

    await expect(repo.get()).rejects.toThrow('read-only');
  });

  it('get() con el findUnique fallando TIRA tal cual (no hay segundo intento silencioso)', async () => {
    mockPrisma.messagingRatesConfig.findUnique.mockRejectedValueOnce(new Error('connection lost'));
    const repo = new PrismaMessagingRatesConfigRepository();

    await expect(repo.get()).rejects.toThrow('connection lost');
    expect(mockPrisma.messagingRatesConfig.upsert).not.toHaveBeenCalled();
  });

  it('get() mapea la fila persistida, Decimal → string de 4 decimales', async () => {
    mockPrisma.messagingRatesConfig.findUnique.mockResolvedValueOnce({
      id: 'singleton',
      currency: 'ARS',
      utilityRate: dec('0.0150'),
      marketingRate: dec('0.0700'),
      authenticationRate: dec('0.0250'),
      providerFee: dec('0.0060'),
      updatedAt: new Date('2026-09-03T00:00:00.000Z'),
    });
    const repo = new PrismaMessagingRatesConfigRepository();

    const config = await repo.get();

    expect(config.currency).toBe('ARS');
    expect(config.utilityRate).toBe('0.0150');
    expect(config.marketingRate).toBe('0.0700');
    expect(config.authenticationRate).toBe('0.0250');
    expect(config.providerFee).toBe('0.0060');
    expect(config.updatedAt).toBe('2026-09-03T00:00:00.000Z');
  });

  it('set() hace upsert sobre id:"singleton" con el patch, mandando strings tal cual (NUNCA Number)', async () => {
    mockPrisma.messagingRatesConfig.upsert.mockResolvedValueOnce({
      id: 'singleton',
      currency: 'USD',
      utilityRate: dec('0.0150'),
      marketingRate: dec('0.0700'),
      authenticationRate: dec('0.0250'),
      providerFee: dec('0.0060'),
      updatedAt: new Date('2026-09-03T00:00:00.000Z'),
    });
    const repo = new PrismaMessagingRatesConfigRepository();

    const updated = await repo.set({
      currency: 'USD',
      utilityRate: '0.0150',
      marketingRate: '0.0700',
      authenticationRate: '0.0250',
      providerFee: '0.0060',
    });

    expect(updated.utilityRate).toBe('0.0150');
    const call = mockPrisma.messagingRatesConfig.upsert.mock.calls[0][0];
    expect(call.where).toEqual({ id: 'singleton' });
    expect(call.create).toEqual({
      id: 'singleton',
      currency: 'USD',
      utilityRate: '0.0150',
      marketingRate: '0.0700',
      authenticationRate: '0.0250',
      providerFee: '0.0060',
    });
    expect(call.update).toEqual({
      currency: 'USD',
      utilityRate: '0.0150',
      marketingRate: '0.0700',
      authenticationRate: '0.0250',
      providerFee: '0.0060',
    });
    // Nunca Number(...) en el camino de escritura — todos los valores pasados son strings.
    expect(typeof call.create.utilityRate).toBe('string');
    expect(typeof call.update.utilityRate).toBe('string');
  });
});
