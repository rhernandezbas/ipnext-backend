import { PrismaClientMirrorRepository } from '@infrastructure/adapters/prisma/PrismaClientMirrorRepository';
import { RefreshClientBalanceIfStale } from '@application/use-cases/RefreshClientBalanceIfStale';
import { InMemoryGestionRealPort } from '@infrastructure/adapters/in-memory/InMemoryGestionRealPort';
import { parseClientBalanceResponse } from '@infrastructure/adapters/gestion-real/GestionRealClient';
import { grBalancePayload } from '../helpers/customerFixture';
import type { ClientMirrorRepository, UpdateBalanceAndInvoicesParams } from '@domain/ports/ClientMirrorRepository';
import { prisma } from '@infrastructure/database/prisma';

/**
 * ai-assistant-cobranzas (4.5 / DAT-3 / D8) — `Client.grPaymentUrl` se escribe en la MISMA
 * transacción que el saldo y las facturas.
 *
 * Por qué importa la transacción y no sólo la columna: el bot cita el saldo y el link de pago
 * EN EL MISMO MENSAJE. Si el link se escribiera aparte y esa segunda escritura fallara, el
 * cliente recibiría un saldo nuevo con el link de pago de otro momento — el mismo split-brain
 * que F3 cerró para saldo+facturas, reabierto por la puerta de al lado.
 *
 * Y la regla inversa, la que de verdad puede romper prod: un payload SIN
 * `payments_url_saldos` (drift de schema, o GR que un día no lo manda) **no puede vaciar** el
 * link que ya teníamos. `undefined` = no tocar; `null` explícito = vaciar a propósito.
 */
describe('PrismaClientMirrorRepository — grPaymentUrl (DAT-3)', () => {
  afterEach(() => jest.restoreAllMocks());

  /** Espía la escritura real: captura el `data` del `updateMany` dentro de la transacción. */
  function espiar() {
    const updates: Record<string, unknown>[] = [];
    const tx = {
      client: {
        updateMany: async (a: Record<string, unknown>) => {
          updates.push(a);
          return { count: 1 };
        },
      },
      invoice: {
        deleteMany: async () => ({ count: 0 }),
        upsert: async () => ({}),
      },
    };
    jest
      .spyOn(prisma, '$transaction')
      .mockImplementation((async (fn: (t: unknown) => Promise<unknown>) => fn(tx)) as never);
    jest.spyOn(prisma.client, 'findUnique').mockImplementation((async () => ({
      id: 'client-1',
      name: 'Juan Pérez',
    })) as never);
    return updates;
  }

  it('DAT-3 — el link llega a la MISMA escritura que saldo y facturas', async () => {
    const updates = espiar();

    await new PrismaClientMirrorRepository().updateBalanceAndInvoices({
      grClienteId: 'GR1',
      amount: 41410.56,
      currency: 'ARS',
      invoices: [],
      at: new Date('2026-09-04T12:00:00.000Z'),
      paymentUrl: 'https://mp.example/total',
    });

    // UNA sola escritura de columnas del cliente, con las cuatro cosas juntas.
    expect(updates).toHaveLength(1);
    expect(updates[0].data).toMatchObject({
      balanceDue: 41410.56,
      balanceCurrency: 'ARS',
      grPaymentUrl: 'https://mp.example/total',
    });
  });

  it('DAT-3 scenario 2 — payload SIN el campo NO vacía el link anterior', async () => {
    const updates = espiar();

    await new PrismaClientMirrorRepository().updateBalanceAndInvoices({
      grClienteId: 'GR1',
      amount: 41410.56,
      currency: 'ARS',
      invoices: null,
      at: new Date('2026-09-04T12:00:00.000Z'),
      // sin `paymentUrl` — el caller no lo conoce, o GR no lo mandó
    });

    // La clave NO puede estar presente: `grPaymentUrl: null` o `undefined` en el `data` de
    // Prisma son cosas distintas, y sólo una de las dos borra el dato.
    expect(Object.keys(updates[0].data as object)).not.toContain('grPaymentUrl');
  });

  it('DAT-3 — `null` EXPLÍCITO sí vacía (GR confirmó que no hay link)', async () => {
    const updates = espiar();

    await new PrismaClientMirrorRepository().updateBalanceAndInvoices({
      grClienteId: 'GR1',
      amount: 0,
      currency: null,
      invoices: [],
      at: new Date('2026-09-04T12:00:00.000Z'),
      paymentUrl: null,
    });

    expect((updates[0].data as Record<string, unknown>).grPaymentUrl).toBeNull();
  });
});

/**
 * El OTRO lado del contrato: quien arma los params. Sin esto la columna existe, la escritura
 * funciona… y nadie le pasa nunca el link — feature inerte (`feature-sin-perilla-inerte`).
 */
describe('RefreshClientBalanceIfStale — propaga payments_url_saldos.MercadoPago (DAT-3)', () => {
  function mirrorSpy() {
    const calls: UpdateBalanceAndInvoicesParams[] = [];
    const mirror = {
      updateBalanceAndInvoices: async (p: UpdateBalanceAndInvoicesParams) => {
        calls.push(p);
      },
    } as unknown as ClientMirrorRepository;
    return { mirror, calls };
  }

  function grWith(payload: Record<string, unknown>) {
    const gr = new InMemoryGestionRealPort();
    gr.balancesByClient.GR1 = parseClientBalanceResponse('GR1', payload);
    return gr;
  }

  it('el link del payload REAL viaja como `paymentUrl` a la escritura', async () => {
    // Fixture producible: el payload pasa por el parser REAL, no se arma el objeto a mano.
    const payload = grBalancePayload('41410.56', { grClienteId: 'GR1' }) as Record<string, unknown>;
    const clientes = (payload.clientes as Record<string, unknown>[])[0];
    (clientes.cuentas as Record<string, unknown>).payments_url_saldos = {
      MercadoPago: 'https://mp.example/total',
    };

    const { mirror, calls } = mirrorSpy();
    await new RefreshClientBalanceIfStale(grWith(payload), mirror, {}).execute({
      grClienteId: 'GR1',
      lastBalanceAt: null,
    });

    expect(calls[0].paymentUrl).toBe('https://mp.example/total');
  });

  it('payload sin `payments_url_saldos` ⇒ la key ni se manda (no vacía el link viejo)', async () => {
    const payload = grBalancePayload('41410.56', { grClienteId: 'GR1' }) as Record<string, unknown>;

    const { mirror, calls } = mirrorSpy();
    await new RefreshClientBalanceIfStale(grWith(payload), mirror, {}).execute({
      grClienteId: 'GR1',
      lastBalanceAt: null,
    });

    expect('paymentUrl' in calls[0]).toBe(false);
  });
});
