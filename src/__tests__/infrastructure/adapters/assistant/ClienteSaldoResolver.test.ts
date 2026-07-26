import { ClienteSaldoResolver } from '@infrastructure/adapters/assistant/ClienteSaldoResolver';
import { assertFactsArePiiFree } from '@application/use-cases/assistant/assistantPiiGuard';
import type { Customer } from '@domain/entities/customer';
import type { CustomerRepository } from '@domain/ports/CustomerRepository';
import type { AssistantSubjectContext } from '@domain/ports/AssistantDataSourceRegistry';

/**
 * ai-assistant-multiagent — el resolver de saldo.
 *
 * Lo que se prueba acá NO es "trae el número". Es **cuándo se niega a traerlo**: un saldo
 * desactualizado dicho con seguridad es un número equivocado sobre la plata de un cliente, y
 * ése lo produciríamos nosotros con datos "reales", no el modelo alucinando.
 */

const CUSTOMER_BASE: Customer = {
  id: 'client-1',
  name: 'Juan Pérez',
  email: 'juan@gmail.com',
  phone: '+5492964123456',
  status: 'active',
  address: 'Av. Mitre 1234',
  city: 'Río Grande',
  country: 'AR',
  login: 'jperez',
  createdAt: '2024-01-01T00:00:00.000Z',
  balanceDue: 45000,
  balanceCurrency: 'ARS',
  lastBalanceAt: '2026-07-26T10:00:00.000Z',
  balanceStale: false,
};

function repoOf(customer: Customer): CustomerRepository {
  return {
    findById: async () => customer,
  } as unknown as CustomerRepository;
}

const ctx: AssistantSubjectContext = {
  clientId: 'client-1',
  conversationId: 'conv-1',
  areaId: 'area-1',
};

describe('ClienteSaldoResolver', () => {
  it('devuelve el saldo cuando está fresco', async () => {
    const resolver = new ClienteSaldoResolver(repoOf(CUSTOMER_BASE));

    await expect(resolver.resolve(ctx)).resolves.toMatchObject({
      disponible: true,
      saldo: 45000,
      moneda: 'ARS',
      tieneDeuda: true,
    });
  });

  it('marca tieneDeuda:false cuando el saldo es 0', async () => {
    const resolver = new ClienteSaldoResolver(repoOf({ ...CUSTOMER_BASE, balanceDue: 0 }));

    await expect(resolver.resolve(ctx)).resolves.toMatchObject({ tieneDeuda: false, saldo: 0 });
  });

  // ── La regla que importa ─────────────────────────────────────────────────
  it('NO emite el número cuando el saldo está desactualizado', async () => {
    const resolver = new ClienteSaldoResolver(
      repoOf({ ...CUSTOMER_BASE, balanceStale: true, grClienteId: null }),
    );

    const facts = await resolver.resolve(ctx);

    expect(facts).toEqual({ disponible: false, motivo: 'saldo_desactualizado' });
    expect(JSON.stringify(facts)).not.toContain('45000');
  });

  it('NO emite nada cuando el saldo nunca se consultó', async () => {
    const resolver = new ClienteSaldoResolver(repoOf({ ...CUSTOMER_BASE, balanceDue: null }));

    await expect(resolver.resolve(ctx)).resolves.toEqual({
      disponible: false,
      motivo: 'saldo_nunca_consultado',
    });
  });

  it('intenta refrescar contra GR antes de rendirse, y usa el valor fresco', async () => {
    const stale: Customer = { ...CUSTOMER_BASE, balanceStale: true, grClienteId: 'gr-9' };
    const fresh: Customer = { ...CUSTOMER_BASE, balanceDue: 51000, balanceStale: false };
    let call = 0;
    const repo = {
      findById: async () => (call++ === 0 ? stale : fresh),
    } as unknown as CustomerRepository;
    const refresh = { execute: async () => true } as never;

    const resolver = new ClienteSaldoResolver(repo, refresh);

    await expect(resolver.resolve(ctx)).resolves.toMatchObject({ disponible: true, saldo: 51000 });
  });

  it('si el refresh no logra actualizar, sigue sin emitir el número', async () => {
    const stale: Customer = { ...CUSTOMER_BASE, balanceStale: true, grClienteId: 'gr-9' };
    const refresh = { execute: async () => false } as never;

    const resolver = new ClienteSaldoResolver(repoOf(stale), refresh);

    await expect(resolver.resolve(ctx)).resolves.toMatchObject({
      motivo: 'saldo_desactualizado',
    });
  });

  it('conversación sin cliente identificado no aporta hechos', async () => {
    const resolver = new ClienteSaldoResolver(repoOf(CUSTOMER_BASE));

    await expect(resolver.resolve({ ...ctx, clientId: null })).resolves.toEqual({
      disponible: false,
      motivo: 'cliente_no_identificado',
    });
  });

  // ── SEC-1 ────────────────────────────────────────────────────────────────
  it('SEC-1: la salida pasa la barrera de PII aunque el Customer esté lleno de identidad', async () => {
    const resolver = new ClienteSaldoResolver(repoOf(CUSTOMER_BASE));

    const facts = await resolver.resolve(ctx);

    // El Customer de origen tiene nombre, email, teléfono y domicilio. Ninguno sale.
    expect(() =>
      assertFactsArePiiFree(facts, [
        CUSTOMER_BASE.name,
        CUSTOMER_BASE.email,
        CUSTOMER_BASE.phone,
        CUSTOMER_BASE.address,
      ]),
    ).not.toThrow();
  });
});
