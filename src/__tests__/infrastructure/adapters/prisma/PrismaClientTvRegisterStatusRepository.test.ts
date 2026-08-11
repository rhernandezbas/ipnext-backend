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
import type { TvRegisterStatusRow } from '../../../../domain/ports/ClientTvRegisterStatusRepository';

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

/**
 * El hermano de `tryReserve`, que hasta esta ronda NO tenía NI UN test: sacarle el
 * `tvRegisterHeartbeatAt` al `where` dejaba la suite ENTERA en verde.
 *
 * Y es el único mecanismo que impide que un runner zombi escriba `failed` sobre un alta que salió
 * bien (⇒ el operador ve un error, reintenta, y el reintento es el que quema al cliente) o `done`
 * sobre una que falló. Igual que la reserva, ese mecanismo NO vive en TypeScript: vive en el
 * `WHERE`. Sin el sello en el `where`, el `updateMany` degrada a un overwrite ciego que compila,
 * pasa todos los tests con el in-memory y sólo se rompe en producción.
 */
describe('PrismaClientTvRegisterStatusRepository.compareAndSet — fencing de la escritura', () => {
  const SELLO = new Date('2026-08-11T10:05:00.000Z');
  const ARRANQUE = new Date('2026-08-11T10:00:00.000Z');
  const NUEVO = new Date('2026-08-11T10:05:30.000Z');

  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.client.updateMany.mockResolvedValue({ count: 1 });
  });

  it('escribe con UN SOLO updateMany condicional — nunca read-then-write', async () => {
    const repo = new PrismaClientTvRegisterStatusRepository();
    await repo.compareAndSet('cust-1', SELLO, { status: 'running', startedAt: ARRANQUE, heartbeatAt: NUEVO });

    expect(mockPrisma.client.updateMany).toHaveBeenCalledTimes(1);
    // Un `findUnique` + `update` reintroduciría la ventana: entre el read y el write hay un yield,
    // y ahí adentro la generación nueva reserva y el zombi la pisa igual.
    expect(mockPrisma.client.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.client.update).not.toHaveBeenCalled();
  });

  it('el WHERE exige el id Y el sello esperado — ésa es TODA la barrera contra el zombi', async () => {
    const repo = new PrismaClientTvRegisterStatusRepository();
    await repo.compareAndSet('cust-1', SELLO, { status: 'done', result: { error: 'x' }, startedAt: ARRANQUE, heartbeatAt: NUEVO });

    const { where } = mockPrisma.client.updateMany.mock.calls[0]![0];
    // `toEqual` y no `toMatchObject`: un `where` que ADEMÁS trajera el sello no sería el bug, pero
    // uno al que le SOBRA una condición sí puede serlo. Lo que se pinea es la forma exacta.
    expect(where).toEqual({ id: 'cust-1', tvRegisterHeartbeatAt: SELLO });
  });

  it('escribe las cuatro columnas del row: estado, result y los DOS sellos', async () => {
    const repo = new PrismaClientTvRegisterStatusRepository();
    const result = { error: 'Gigared API is unavailable', code: 'GIGARED_UNAVAILABLE' };
    await repo.compareAndSet('cust-1', SELLO, { status: 'failed', result, startedAt: ARRANQUE, heartbeatAt: NUEVO });

    const { data } = mockPrisma.client.updateMany.mock.calls[0]![0];
    expect(data).toEqual({
      tvRegisterStatus: 'failed',
      tvRegisterResult: result,
      // `startedAt` viaja en CADA escritura y siempre con el valor de la reserva: es lo que el
      // operador ve en el polling ("empezó a las…") y lo que le da identidad a la generación.
      tvRegisterStartedAt: ARRANQUE,
      tvRegisterHeartbeatAt: NUEVO,
    });
  });

  it('un row sin result LIMPIA la columna en vez de dejar el error del intento anterior', async () => {
    const repo = new PrismaClientTvRegisterStatusRepository();
    await repo.compareAndSet('cust-1', SELLO, { status: 'running', startedAt: ARRANQUE, heartbeatAt: NUEVO });

    const { data } = mockPrisma.client.updateMany.mock.calls[0]![0];
    expect(data.tvRegisterResult).toBeNull();
  });

  it('count 1 → el sello era el nuestro; count 0 → somos un zombi', async () => {
    const repo = new PrismaClientTvRegisterStatusRepository();
    const row: TvRegisterStatusRow = { status: 'done', startedAt: ARRANQUE, heartbeatAt: NUEVO };
    mockPrisma.client.updateMany.mockResolvedValueOnce({ count: 1 });
    await expect(repo.compareAndSet('cust-1', SELLO, row)).resolves.toBe(true);
    mockPrisma.client.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(repo.compareAndSet('cust-1', SELLO, row)).resolves.toBe(false);
  });
});
