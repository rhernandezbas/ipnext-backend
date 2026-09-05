import { ClienteFacturasResolver } from '@infrastructure/adapters/assistant/ClienteFacturasResolver';
import { InMemoryAssistantInvoicesReader } from '@infrastructure/adapters/in-memory/InMemoryAssistantInvoicesReader';
import { MOTIVO_GUIA } from '@infrastructure/adapters/assistant/assistantMotivoGuia';
import { assertFactsArePiiFree } from '@application/use-cases/assistant/assistantPiiGuard';
import type { Customer } from '@domain/entities/customer';
import type { CustomerRepository } from '@domain/ports/CustomerRepository';
import type { AssistantSubjectContext } from '@domain/ports/AssistantDataSourceRegistry';
import type { RefreshClientBalanceIfStale } from '@application/use-cases/RefreshClientBalanceIfStale';
import { customerFrom, grBalanceRow, FIXED_NOW, type FixtureRow } from '../../../helpers/customerFixture';

/**
 * ai-assistant-cobranzas (4.3 / DAT-1 / D7-D8) — el resolver de `cliente.facturas`.
 *
 * Mismo espíritu que `ClienteSaldoResolver`: lo que se prueba NO es "trae las facturas", es
 * **cuándo se niega a traerlas**. Dos modos de falla, y los dos son peores que un handoff:
 *   1. citar una factura vieja (el espejo quedó stale y GR no contestó);
 *   2. concluir "estás al día" porque la lista vino vacía — esa afirmación es EXCLUSIVA de
 *      `cliente.saldo` (D7/DFT-2), y acá se produciría con datos "reales".
 */

const FRESH_AT = new Date(FIXED_NOW.getTime() - 10 * 60 * 1000);
const STALE_AT = new Date(FIXED_NOW.getTime() - 3 * 60 * 60 * 1000);

function customer(row: Partial<FixtureRow>): Customer {
  return customerFrom({ id: 'client-1', name: 'Juan Pérez', status: 'active', ...row });
}

/** Repo que devuelve el customer ACTUAL: el resolver lo re-lee tras un refresh exitoso. */
function repoOf(get: () => Customer): CustomerRepository {
  return { findById: async () => get() } as unknown as CustomerRepository;
}

interface RefreshDouble {
  refresh: RefreshClientBalanceIfStale;
  calls: number;
}

/** Doble in-memory de `RefreshClientBalanceIfStale`: `ok` decide si el espejo se corrige. */
function refreshDouble(ok: boolean, onOk?: () => void): RefreshDouble {
  const state = { calls: 0 };
  const refresh = {
    execute: async () => {
      state.calls += 1;
      if (ok) onOk?.();
      return ok;
    },
  } as unknown as RefreshClientBalanceIfStale;
  return {
    refresh,
    get calls() {
      return state.calls;
    },
  } as RefreshDouble;
}

const FACTURAS = [
  {
    tipo: 'FC A',
    numero: '0001-00012345',
    vencimiento: '2026-09-10',
    saldo: 41410.56,
    pdfUrl: 'https://gr.example/pdf/1',
    couponPdfUrl: null,
    paymentUrl: 'https://mp.example/pay/1',
  },
];

const ctx: AssistantSubjectContext = {
  clientId: 'client-1',
  conversationId: 'conv-1',
  areaId: 'area-1',
};

function readerWith(invoices = FACTURAS, paymentUrl: string | null = 'https://mp.example/total') {
  const reader = new InMemoryAssistantInvoicesReader();
  reader.seed('client-1', invoices);
  reader.seedTotalPaymentUrl('client-1', paymentUrl);
  return reader;
}

describe('ClienteFacturasResolver', () => {
  it('balance FRESCO ⇒ devuelve las facturas y NO vuelve a refrescar', async () => {
    const fresco = customer(grBalanceRow('41410.56', FRESH_AT));
    const refresh = refreshDouble(true);

    const facts = await new ClienteFacturasResolver(
      repoOf(() => fresco),
      readerWith(),
      refresh.refresh,
    ).resolve(ctx);

    expect(refresh.calls).toBe(0); // el refresh es caro: no se paga si el dato ya es fresco
    expect(facts).toMatchObject({ disponible: true, cantidad: 1 });
    expect((facts.facturas as unknown[])).toHaveLength(1);
    expect(facts.linkPagoTotal).toBe('https://mp.example/total');
  });

  it('DAT-1 — sigue STALE tras el intento de refresh ⇒ motivo, NUNCA una factura vieja', async () => {
    const viejo = customer(grBalanceRow('41410.56', STALE_AT));
    const refresh = refreshDouble(false); // GR caído

    const facts = await new ClienteFacturasResolver(
      repoOf(() => viejo),
      readerWith(),
      refresh.refresh,
    ).resolve(ctx);

    expect(refresh.calls).toBe(1);
    expect(facts).toEqual({
      disponible: false,
      motivo: 'facturas_no_disponibles',
      guia: MOTIVO_GUIA.facturas_no_disponibles,
    });
    // Lo que NO tiene que estar: ni un rastro de la factura del espejo viejo.
    expect(JSON.stringify(facts)).not.toContain('0001-00012345');
  });

  it('DAT-1/D7 — el refresh corrige el stale pero la lista viene VACÍA ⇒ no afirma "al día"', async () => {
    // El caso peligroso: los datos son frescos y confiables, y aun así una lista vacía NO
    // prueba que el cliente no deba nada — eso lo dice `cliente.saldo`, no este resolver.
    let actual = customer(grBalanceRow('41410.56', STALE_AT));
    const refresh = refreshDouble(true, () => {
      actual = customer(grBalanceRow('0', FRESH_AT));
    });

    const facts = await new ClienteFacturasResolver(
      repoOf(() => actual),
      readerWith([]),
      refresh.refresh,
    ).resolve(ctx);

    expect(refresh.calls).toBe(1);
    expect(facts.disponible).toBe(false);
    expect(facts.motivo).toBe('facturas_no_disponibles');
    expect(JSON.stringify(facts).toLowerCase()).not.toMatch(/estas al dia|está al día/);
  });

  it('conversación sin cliente matcheado ⇒ `cliente_no_identificado`, sin tocar el reader', async () => {
    const reader = readerWith();
    const spy = jest.spyOn(reader, 'listOpenByClientId');

    const facts = await new ClienteFacturasResolver(
      repoOf(() => customer(grBalanceRow('0', FRESH_AT))),
      reader,
    ).resolve({ ...ctx, clientId: null });

    expect(facts.motivo).toBe('cliente_no_identificado');
    expect(spy).not.toHaveBeenCalled();
  });

  it('SEC-1 — los hechos no llevan identidad del cliente', async () => {
    const facts = await new ClienteFacturasResolver(
      repoOf(() => customer(grBalanceRow('41410.56', FRESH_AT))),
      readerWith(),
    ).resolve(ctx);

    expect(() => assertFactsArePiiFree({ 'cliente.facturas': facts }, ['Juan Pérez'])).not.toThrow();
  });
});
