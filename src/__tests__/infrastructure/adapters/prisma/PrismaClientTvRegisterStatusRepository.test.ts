/**
 * PrismaClientTvRegisterStatusRepository — tests de INTENCIÓN del adapter con el cliente Prisma
 * mockeado (patrón `PrismaOwnershipCaseRepository.where.test.ts`, que ya pinnea el CAS de
 * `flipToDone`).
 *
 * POR QUÉ existe este archivo: la reserva del alta es lo único que impide que dos POST concurrentes
 * produzcan dos `register` REALES contra el partner (⇒ activación pendiente ⇒ cliente quemado para
 * siempre). Esa atomicidad NO vive en TypeScript: vive en el `WHERE` del `UPDATE`. Un adapter que
 * hiciera `findUnique` + `update` compilaría igual, pasaría todos los tests de ruta con el adapter
 * in-memory —que es monohilo y no puede exhibir el race— y se rompería SÓLO en producción.
 *
 * Por eso acá se afirma la FORMA del `where`, no el resultado: es lo único observable sin una DB.
 */

jest.mock('../../../../infrastructure/database/prisma', () => ({
  prisma: {
    client: {
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
  },
}));

import { prisma } from '../../../../infrastructure/database/prisma';
import { PrismaClientTvRegisterStatusRepository } from '../../../../infrastructure/adapters/prisma/PrismaClientTvRegisterStatusRepository';

const mockPrisma = prisma as unknown as {
  client: { findUnique: jest.Mock; update: jest.Mock; updateMany: jest.Mock };
};

const TTL = 15 * 60 * 1000;

describe('PrismaClientTvRegisterStatusRepository.tryReserve — CAS de la reserva del alta', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.client.updateMany.mockResolvedValue({ count: 1 });
  });

  it('reserva con UN SOLO updateMany condicional — nunca read-then-write', async () => {
    const repo = new PrismaClientTvRegisterStatusRepository();
    await repo.tryReserve('cust-1', new Date(), TTL);

    expect(mockPrisma.client.updateMany).toHaveBeenCalledTimes(1);
    // Si el adapter leyera primero, el race volvería: entre el read y el write hay un yield.
    expect(mockPrisma.client.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.client.update).not.toHaveBeenCalled();
  });

  it('el WHERE exige el id Y que NO haya un alta viva (las tres ramas del watchdog)', async () => {
    const repo = new PrismaClientTvRegisterStatusRepository();
    const startedAt = new Date('2026-08-11T10:00:00.000Z');
    await repo.tryReserve('cust-1', startedAt, TTL);

    const { where, data } = mockPrisma.client.updateMany.mock.calls[0]![0];
    expect(where.id).toBe('cust-1');

    const ramas = where.OR as Array<Record<string, unknown>>;
    expect(Array.isArray(ramas)).toBe(true);
    // (1) nunca se encoló un alta
    expect(ramas).toContainEqual({ tvRegisterStatus: null });
    // (2) el último alta terminó (done/failed) → re-encolable
    expect(ramas).toContainEqual({ tvRegisterStatus: { notIn: ['pending', 'running'] } });
    // (3) pending/running MÁS VIEJO que el TTL → job huérfano, el watchdog lo libera.
    //     El corte se calcula sobre el startedAt de ESTE intento, no sobre un now() del adapter:
    //     así el reloj de la reserva y el del guard son el MISMO.
    expect(ramas).toContainEqual({
      AND: [
        { tvRegisterStatus: { in: ['pending', 'running'] } },
        { tvRegisterHeartbeatAt: { lt: new Date(startedAt.getTime() - TTL) } },
      ],
    });

    // Y lo que escribe: pending + los dos sellos + el result del intento anterior LIMPIADO (si no,
    // el polling del alta nueva mostraría el error de la vieja).
    expect(data).toEqual({
      tvRegisterStatus: 'pending',
      tvRegisterStartedAt: startedAt,
      tvRegisterHeartbeatAt: startedAt,
      tvRegisterResult: null,
    });
  });

  it('count 1 → ganó la reserva; count 0 → la perdió (otro request llegó primero)', async () => {
    const repo = new PrismaClientTvRegisterStatusRepository();
    mockPrisma.client.updateMany.mockResolvedValueOnce({ count: 1 });
    await expect(repo.tryReserve('cust-1', new Date(), TTL)).resolves.toBe(true);
    mockPrisma.client.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(repo.tryReserve('cust-1', new Date(), TTL)).resolves.toBe(false);
  });
});
