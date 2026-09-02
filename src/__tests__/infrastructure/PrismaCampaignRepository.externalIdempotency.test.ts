/**
 * external-bulk-messaging (1.7) — PrismaCampaignRepository.findByExternalIdempotencyKey
 * + countAuthorizedRecipientsByCreatorSince. Mocked-Prisma pattern (molde
 * `PrismaClosedServiceOrderRepository.pendingWhere.test.ts`) — pin del WHERE
 * shape EXACTO que documenta D3.a (cuenta lo ENVIADO, nunca lo creado, D6).
 */

jest.mock('../../infrastructure/database/prisma', () => ({
  prisma: {
    campaign: {
      findUnique: jest.fn(),
      create: jest.fn(),
    },
    campaignRecipient: {
      count: jest.fn(),
    },
  },
}));

import { prisma } from '../../infrastructure/database/prisma';
import { PrismaCampaignRepository } from '../../infrastructure/adapters/prisma/PrismaCampaignRepository';
import { UniqueConstraintViolationError } from '../../domain/errors/persistence';
import type { CampaignCreateData } from '../../domain/ports/CampaignRepository';

const mockPrisma = prisma as unknown as {
  campaign: { findUnique: jest.Mock; create: jest.Mock };
  campaignRecipient: { count: jest.Mock };
};

const CREATE_DATA: CampaignCreateData = {
  name: 'Recordatorio deuda julio',
  templateRef: 'HXabc123',
  segment: { statuses: ['late'] },
  variableSpec: { '1': { source: 'name' } },
  total: 2,
  createdById: 'user-1',
};

describe('PrismaCampaignRepository — external-bulk-messaging (1.7)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('findByExternalIdempotencyKey busca por la columna externalIdempotencyKey', async () => {
    mockPrisma.campaign.findUnique.mockResolvedValueOnce(null);
    const repo = new PrismaCampaignRepository();

    const result = await repo.findByExternalIdempotencyKey('idem-1');

    expect(result).toBeNull();
    expect(mockPrisma.campaign.findUnique).toHaveBeenCalledWith({ where: { externalIdempotencyKey: 'idem-1' } });
  });

  /**
   * fix wave F1 (F2) — paridad campo-a-campo con el InMemory: cuenta lo
   * AUTORIZADO (recipients CREADOS desde `since`, status NOT IN skipped/
   * opted_out) del creador pedido. `createdAt: {gte}` es INCLUSIVO en `since`.
   */
  it('countAuthorizedRecipientsByCreatorSince cuenta CampaignRecipient createdAt>=since, status NOT IN (skipped, opted_out), del createdById pedido (D3.a/D6, fix wave F1)', async () => {
    mockPrisma.campaignRecipient.count.mockResolvedValueOnce(7);
    const repo = new PrismaCampaignRepository();
    const since = new Date('2026-09-02T03:00:00.000Z');

    const count = await repo.countAuthorizedRecipientsByCreatorSince('api-messaging', since);

    expect(count).toBe(7);
    expect(mockPrisma.campaignRecipient.count).toHaveBeenCalledWith({
      where: {
        createdAt: { gte: since },
        status: { notIn: ['skipped', 'opted_out'] },
        campaign: { createdById: 'api-messaging' },
      },
    });
  });
});

/**
 * fix wave F2 (NEW-1) — `create()` traducia CUALQUIER P2002 a
 * `UniqueConstraintViolationError('Campaign', field)`, sin chequear si el
 * `target` violado era `externalIdempotencyKey`. `SendExternalBulk` cachea ESE
 * error para devolver la campana GANADORA de una carrera (fix wave F1 F5); si
 * el schema alguna vez suma OTRO `@unique` en `Campaign` (o Postgres reporta un
 * P2002 de otra columna), ese catch de negocio NO debe tragarselo — tiene que
 * subir tal cual para que el errorHandler lo trate como el 500 real que es.
 */
describe('PrismaCampaignRepository.create — traduccion de P2002 acotada a externalIdempotencyKey (fix wave F2, NEW-1)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('P2002 con target=[externalIdempotencyKey] → UniqueConstraintViolationError(Campaign, externalIdempotencyKey)', async () => {
    mockPrisma.campaign.create.mockRejectedValue({
      code: 'P2002',
      meta: { target: ['externalIdempotencyKey'] },
    });
    const repo = new PrismaCampaignRepository();

    await expect(repo.create({ ...CREATE_DATA, externalIdempotencyKey: 'key-race' })).rejects.toThrow(
      UniqueConstraintViolationError,
    );
    await expect(
      repo.create({ ...CREATE_DATA, externalIdempotencyKey: 'key-race' }),
    ).rejects.toMatchObject({ entity: 'Campaign', field: 'externalIdempotencyKey' });
  });

  it('P2002 con target COMPUESTO que incluye externalIdempotencyKey igual se traduce', async () => {
    mockPrisma.campaign.create.mockRejectedValueOnce({
      code: 'P2002',
      meta: { target: ['createdById', 'externalIdempotencyKey'] },
    });
    const repo = new PrismaCampaignRepository();

    await expect(repo.create({ ...CREATE_DATA, externalIdempotencyKey: 'key-race' })).rejects.toBeInstanceOf(
      UniqueConstraintViolationError,
    );
  });

  it('P2002 con target de OTRA columna (no externalIdempotencyKey) se re-lanza SIN traducir', async () => {
    const boom = { code: 'P2002', meta: { target: ['id'] } };
    mockPrisma.campaign.create.mockRejectedValueOnce(boom);
    const repo = new PrismaCampaignRepository();

    await expect(repo.create({ ...CREATE_DATA, externalIdempotencyKey: 'key-race' })).rejects.toBe(boom);
  });

  it('P2002 sin meta.target (forma cruda) se re-lanza SIN traducir', async () => {
    const boom = { code: 'P2002' };
    mockPrisma.campaign.create.mockRejectedValueOnce(boom);
    const repo = new PrismaCampaignRepository();

    await expect(repo.create({ ...CREATE_DATA, externalIdempotencyKey: 'key-race' })).rejects.toBe(boom);
  });

  it('un error NO-P2002 se re-lanza tal cual', async () => {
    const boom = new Error('connection reset');
    mockPrisma.campaign.create.mockRejectedValueOnce(boom);
    const repo = new PrismaCampaignRepository();

    await expect(repo.create({ ...CREATE_DATA, externalIdempotencyKey: 'key-race' })).rejects.toBe(boom);
  });
});
