/**
 * fix wave F3 — **saldo y facturas se escriben en UNA transacción.**
 *
 * El defecto: `RefreshClientBalanceIfStale` hacía `updateClientBalance` (commit
 * inmediato) y DESPUÉS `upsertInvoices` (otra transacción). Si la segunda
 * fallaba, el saldo ya estaba commiteado y `execute()` devolvía `false` — el
 * caller creía que no había pasado nada, y la base quedaba en split-brain:
 * saldo NUEVO, facturas VIEJAS. Peor todavía, el `lastBalanceAt` fresco tapaba
 * la inconsistencia (nadie lo ve stale ⇒ nadie lo vuelve a pedir).
 *
 * Este test NO necesita Postgres: lo que hay que probar es que la escritura del
 * saldo ocurre sobre el CLIENTE TRANSACCIONAL (`tx`) dentro del callback de
 * `$transaction`, y no sobre el `prisma` global antes de abrirlo. El rollback
 * en sí lo garantiza Postgres; lo que se nos puede escapar a nosotros es dejar
 * una de las dos escrituras afuera de la transacción.
 */

type Call = { table: string; op: string };

/** Doble de Prisma que registra en qué cliente (global o tx) cae cada escritura. */
function makeFakePrisma(opts: { failOn?: 'invoice.upsert' | 'invoice.deleteMany' } = {}) {
  const globalCalls: Call[] = [];
  const txCalls: Call[] = [];

  const model = (sink: Call[], table: string) => ({
    updateMany: jest.fn(async () => {
      sink.push({ table, op: 'updateMany' });
      return { count: 1 };
    }),
    findUnique: jest.fn(async () => {
      sink.push({ table, op: 'findUnique' });
      return { id: 'local-1', name: 'Juan' };
    }),
    deleteMany: jest.fn(async () => {
      sink.push({ table, op: 'deleteMany' });
      if (opts.failOn === 'invoice.deleteMany' && table === 'invoice') throw new Error('boom deleteMany');
      return { count: 0 };
    }),
    upsert: jest.fn(async () => {
      sink.push({ table, op: 'upsert' });
      if (opts.failOn === 'invoice.upsert' && table === 'invoice') throw new Error('boom upsert');
      return {};
    }),
  });

  const tx = { client: model(txCalls, 'client'), invoice: model(txCalls, 'invoice') };
  const prisma = {
    client: model(globalCalls, 'client'),
    invoice: model(globalCalls, 'invoice'),
    $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };

  return { prisma, tx, globalCalls, txCalls };
}

const fake = makeFakePrisma();
let currentFake = fake;

jest.mock('../../infrastructure/database/prisma', () => ({
  get prisma() {
    return currentFake.prisma;
  },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { PrismaClientMirrorRepository } = require('../../infrastructure/adapters/prisma/PrismaClientMirrorRepository');
import type { GrInvoice } from '@domain/entities/gestionReal';

const AT = new Date('2026-08-10T12:00:00.000Z');

function invoice(numero: string): GrInvoice {
  return {
    tipo: 'FB', sucursal: '00010', numero, moneda: 'PES',
    fecha: '26-06-2026', fechaVto: '07-07-2026', importe: 1000, saldo: 1000,
    urlPdf: null, cuponPdf: null, paymentUrl: null,
  };
}

describe('PrismaClientMirrorRepository.updateBalanceAndInvoices (F3 — atomicidad)', () => {
  it('F3 — saldo Y facturas caen DENTRO del mismo $transaction (nada se escribe en el prisma global)', async () => {
    currentFake = makeFakePrisma();
    const repo = new PrismaClientMirrorRepository();

    await repo.updateBalanceAndInvoices({
      grClienteId: 'GR1', amount: 5000, currency: 'ARS', invoices: [invoice('1')], at: AT,
    });

    expect(currentFake.prisma.$transaction).toHaveBeenCalledTimes(1);
    // El saldo se escribe con el cliente TRANSACCIONAL...
    expect(currentFake.txCalls).toContainEqual({ table: 'client', op: 'updateMany' });
    expect(currentFake.txCalls).toContainEqual({ table: 'invoice', op: 'deleteMany' });
    expect(currentFake.txCalls).toContainEqual({ table: 'invoice', op: 'upsert' });
    // ...y NUNCA con el global (que commitearía por su cuenta).
    expect(currentFake.globalCalls.filter((c) => c.op !== 'findUnique')).toEqual([]);
  });

  it('F3 — si la parte de facturas revienta, la excepción SALE (la tx entera se aborta; el saldo no queda commiteado por su cuenta)', async () => {
    currentFake = makeFakePrisma({ failOn: 'invoice.upsert' });
    const repo = new PrismaClientMirrorRepository();

    await expect(
      repo.updateBalanceAndInvoices({
        grClienteId: 'GR1', amount: 5000, currency: 'ARS', invoices: [invoice('1')], at: AT,
      }),
    ).rejects.toThrow('boom upsert');

    // La escritura del saldo ocurrió DENTRO de la tx abortada — no en el global.
    expect(currentFake.globalCalls.filter((c) => c.op === 'updateMany')).toEqual([]);
  });

  it('F3 — invoices:null (payload NO autoritativo) escribe el saldo y NO toca el espejo de facturas', async () => {
    currentFake = makeFakePrisma();
    const repo = new PrismaClientMirrorRepository();

    await repo.updateBalanceAndInvoices({
      grClienteId: 'GR1', amount: 5000, currency: 'ARS', invoices: null, at: AT,
    });

    expect(currentFake.txCalls).toContainEqual({ table: 'client', op: 'updateMany' });
    expect(currentFake.txCalls.filter((c) => c.table === 'invoice')).toEqual([]);
  });
});
