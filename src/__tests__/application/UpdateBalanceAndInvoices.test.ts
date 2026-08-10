import { InMemoryClientMirrorRepository } from '@infrastructure/adapters/in-memory/InMemoryClientMirrorRepository';
import { GrClient } from '@domain/entities/gestionReal';

/**
 * fix wave 2 (FW2-4) — **el camino no-atómico dejó de estar publicado.**
 *
 * F3 mató el split-brain moviendo la escritura de saldo + facturas a UNA
 * transacción (`updateBalanceAndInvoices`), y `updateClientBalance` —la
 * escritura suelta, la que commiteaba el saldo y recién después intentaba las
 * facturas— quedó con CERO callers de producción... pero seguía en el puerto.
 * Un método en un port no es código muerto: es una OFERTA. El próximo que
 * necesite "solo actualizar el saldo" lo encuentra publicado, documentado y
 * verde de tests, y reabre el defecto sin enterarse.
 *
 * Este archivo era `UpdateClientBalance.test.ts` y probaba exactamente esa
 * oferta. Migrado al método atómico: los mismos cinco casos, con
 * `invoices: null` (el payload no autoritativo, que es como se pide hoy una
 * escritura de saldo sola y sin tocar el espejo de facturas).
 */

function makeGrClient(id: string, statusCode = '2'): GrClient {
  return {
    grClienteId: id,
    name: `Cliente ${id}`,
    documento: id,
    email: `c${id}@mail.com`,
    phone: '123',
    status: 'Deudor',
    statusCode,
    address: 'Calle 1',
    city: 'Mercedes',
    province: 'Buenos Aires',
    ultimaModificacion: '01-01-2026 10:00:00',
    fechaCreacion: null,
    raw: { original: true },
  };
}

describe('InMemoryClientMirrorRepository.updateBalanceAndInvoices — escritura de saldo', () => {
  let repo: InMemoryClientMirrorRepository;
  const at = new Date('2026-05-27T10:00:00Z');

  /** Saldo solo, sin tocar el espejo de facturas (`invoices: null`). */
  const writeBalance = (grClienteId: string, amount: number, currency: string | null, when = at) =>
    repo.updateBalanceAndInvoices({ grClienteId, amount, currency, invoices: null, at: when });

  beforeEach(async () => {
    repo = new InMemoryClientMirrorRepository();
    // Upsert a client first
    await repo.upsertClient(makeGrClient('100011'));
  });

  it('sets balance fields on the client', async () => {
    await writeBalance('100011', 65722.07, 'ARS');
    const stored = repo.balances.get('100011');
    expect(stored?.amount).toBe(65722.07);
    expect(stored?.currency).toBe('ARS');
    expect(stored?.lastBalanceAt).toEqual(at);
  });

  it('does NOT clobber the original client raw / status', async () => {
    await writeBalance('100011', 1000, 'ARS');
    const client = repo.clients.get('100011');
    // The original raw payload should still be intact
    expect(client?.raw).toEqual({ original: true });
    expect(client?.statusCode).toBe('2');
  });

  it('can update an existing balance (idempotent overwrite)', async () => {
    await writeBalance('100011', 1000, 'ARS');
    const at2 = new Date('2026-05-27T11:00:00Z');
    await writeBalance('100011', 2000, 'ARS', at2);
    const stored = repo.balances.get('100011');
    expect(stored?.amount).toBe(2000);
    expect(stored?.lastBalanceAt).toEqual(at2);
  });

  it('stores amount=0 for a paid-off client', async () => {
    await writeBalance('100011', 0, 'ARS');
    const stored = repo.balances.get('100011');
    expect(stored?.amount).toBe(0);
  });

  it('is a no-op for an unknown grClienteId (does not throw)', async () => {
    await expect(writeBalance('UNKNOWN', 100, 'ARS')).resolves.toBeUndefined();
  });

  it('con invoices: null NO toca el espejo de facturas', async () => {
    await repo.upsertInvoices('100011', [{
      tipo: 'FB', sucursal: '00010', numero: '0001', moneda: 'PES',
      fecha: '26-06-2026', fechaVto: '07-07-2026', importe: 45000, saldo: 45000,
      urlPdf: null, cuponPdf: null, paymentUrl: null,
    }], at);

    await writeBalance('100011', 45000, 'ARS');

    expect(repo.invoices).toHaveLength(1);
  });

  /**
   * El pin de la eliminación. Es un chequeo de RUNTIME a propósito: el tipo del
   * puerto ya lo impide en compilación, pero un adapter puede seguir exponiendo
   * el método de más (TypeScript no lo prohíbe) y ahí vuelve a estar disponible
   * para el que lo busque con un cast.
   */
  it('FW2-4 — el camino no-atómico ya no existe en el twin in-memory', () => {
    const suelto = (repo as unknown as Record<string, unknown>).updateClientBalance;
    expect(suelto).toBeUndefined();
  });
});
