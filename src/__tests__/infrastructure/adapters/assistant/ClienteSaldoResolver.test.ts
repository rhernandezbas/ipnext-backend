import { ClienteSaldoResolver } from '@infrastructure/adapters/assistant/ClienteSaldoResolver';
import { assertFactsArePiiFree } from '@application/use-cases/assistant/assistantPiiGuard';
import type { Customer } from '@domain/entities/customer';
import type { CustomerRepository } from '@domain/ports/CustomerRepository';
import type { AssistantSubjectContext } from '@domain/ports/AssistantDataSourceRegistry';
import { customerFrom, grBalanceRow, FIXED_NOW, type FixtureRow } from '../../../helpers/customerFixture';

/**
 * ai-assistant-multiagent — el resolver de saldo.
 *
 * Lo que se prueba acá NO es "trae el número". Es **cuándo se niega a traerlo**: un saldo
 * desactualizado dicho con seguridad es un número equivocado sobre la plata de un cliente, y
 * ése lo produciríamos nosotros con datos "reales", no el modelo alucinando.
 *
 * customer-balance-unmask (Fase 4, tarea 4.8, design.md Decisión 7) — fixtures reescritas para
 * pasar por `customerFrom()` (el mapper REAL). El archivo original armaba `Customer` a mano con
 * pares `status:'active'`/`balanceDue:45000` que `toCustomer` JAMÁS producía antes de este change
 * (proposal.md, "Por qué los tests no lo cazaron") — cobertura verde sobre un cliente que no podía
 * existir. Ahora TODO fixture nace de una fila plausible.
 */

const FRESH_AT = new Date(FIXED_NOW.getTime() - 10 * 60 * 1000); // 10 min antes — dentro del TTL
const STALE_AT = new Date(FIXED_NOW.getTime() - 90 * 60 * 1000); // 90 min antes — pasó el TTL (60)

const CUSTOMER_ROW: Partial<FixtureRow> = {
  id: 'client-1',
  name: 'Juan Pérez',
  email: 'juan@gmail.com',
  phone: '+5492964123456',
  status: 'active',
  address: 'Av. Mitre 1234',
  city: 'Río Grande',
  country: 'AR',
  login: 'jperez',
  createdAt: new Date('2024-01-01T00:00:00.000Z'),
  // fix wave (F1): los campos de balance salen del PARSER real, no a mano.
  ...grBalanceRow('45000.00', FRESH_AT),
};

const CUSTOMER_BASE: Customer = customerFrom(CUSTOMER_ROW);

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
  it('S17 — active client with real debt, fresh (the bug is dead): devuelve el saldo tal como el mapper real lo produjo', async () => {
    const resolver = new ClienteSaldoResolver(repoOf(CUSTOMER_BASE));

    await expect(resolver.resolve(ctx)).resolves.toEqual({
      disponible: true,
      saldo: 45000,
      moneda: 'ARS',
      tieneDeuda: true,
      estadoCliente: 'active',
    });
  });

  /**
   * ⚠️ **F1 — el CRITICAL de la fix wave.** El fixture viejo era
   * `{...CUSTOMER_ROW, balanceDue: 0}`, que dejaba `balanceCurrency:'ARS'`
   * heredado: una fila que la escritura real NUNCA produce. El parser sintetiza
   * `currency = amount > 0 ? 'ARS' : null`, así que en PROD "sin deuda" ⟺
   * "moneda null" — y el guard de moneda mandaba a un humano a TODO cliente al
   * día (~2.300 del carril rápido). Con la fila REAL (`debt: "0.00"` por el
   * parser) este test es el que caza la regresión.
   */
  it('F1 — cliente al día (payload GR debt "0.00" ⇒ currency null): responde "al día", NO deriva a humano por moneda', async () => {
    const alDia = customerFrom({ ...CUSTOMER_ROW, ...grBalanceRow('0.00', FRESH_AT) });
    // Sanity de la premisa: la fila que la escritura real produce trae moneda null.
    expect(alDia.balanceDue).toBe(0);
    expect(alDia.balanceCurrency).toBeNull();

    const resolver = new ClienteSaldoResolver(repoOf(alDia));

    await expect(resolver.resolve(ctx)).resolves.toMatchObject({
      disponible: true,
      tieneDeuda: false,
      saldo: 0,
    });
  });

  it('F1b — saldo a favor (debt negativa ⇒ currency null): tampoco deriva a humano', async () => {
    const aFavor = customerFrom({ ...CUSTOMER_ROW, ...grBalanceRow('-1500.50', FRESH_AT) });
    expect(aFavor.balanceCurrency).toBeNull();

    const resolver = new ClienteSaldoResolver(repoOf(aFavor));

    await expect(resolver.resolve(ctx)).resolves.toMatchObject({
      disponible: true,
      tieneDeuda: false,
      saldo: -1500.5,
    });
  });

  // ── La regla que importa ─────────────────────────────────────────────────
  it('S18 — yesterday balance, refresh fails: NO emite el número cuando el saldo está desactualizado', async () => {
    const stale = customerFrom({ ...CUSTOMER_ROW, lastBalanceAt: STALE_AT });
    const resolver = new ClienteSaldoResolver(repoOf(stale)); // sin refresh collaborator

    const facts = await resolver.resolve(ctx);

    expect(facts).toEqual({ disponible: false, motivo: 'saldo_desactualizado' });
    expect(JSON.stringify(facts)).not.toContain('45000');
  });

  it('S20 — no GR link: NO emite nada cuando el saldo nunca se consultó', async () => {
    const unlinked = customerFrom({ ...CUSTOMER_ROW, grClienteId: null });
    const resolver = new ClienteSaldoResolver(repoOf(unlinked));

    await expect(resolver.resolve(ctx)).resolves.toEqual({
      disponible: false,
      motivo: 'saldo_nunca_consultado',
    });
  });

  it('S19 — stale, but the refresh succeeds: intenta refrescar contra GR antes de rendirse, y usa el valor fresco', async () => {
    const stale = customerFrom({ ...CUSTOMER_ROW, lastBalanceAt: STALE_AT });
    const fresh = customerFrom({ ...CUSTOMER_ROW, balanceDue: 51000, lastBalanceAt: FRESH_AT });
    let call = 0;
    const repo = {
      findById: async () => (call++ === 0 ? stale : fresh),
    } as unknown as CustomerRepository;
    const refresh = { execute: async () => true } as never;

    const resolver = new ClienteSaldoResolver(repo, refresh);

    await expect(resolver.resolve(ctx)).resolves.toMatchObject({ disponible: true, saldo: 51000 });
  });

  it('P3 — si el refresh no logra actualizar, sigue sin emitir el número Y el refresh SÍ fue invocado (assert de invocación, antes ausente)', async () => {
    const stale = customerFrom({ ...CUSTOMER_ROW, lastBalanceAt: STALE_AT });
    const execute = jest.fn().mockResolvedValue(false);
    const refresh = { execute } as never;

    const resolver = new ClienteSaldoResolver(repoOf(stale), refresh);

    await expect(resolver.resolve(ctx)).resolves.toMatchObject({
      motivo: 'saldo_desactualizado',
    });
    expect(execute).toHaveBeenCalledWith({ grClienteId: 'GR1', lastBalanceAt: STALE_AT.toISOString() });
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

  // ─── customer-balance-unmask (Fase 4) — guard de moneda (spec assistant-balance-guard) ───

  /**
   * ⚠️ Fila **legacy/defensiva a propósito**, y la única de este archivo que NO
   * sale del parser: hoy `parseClientBalanceResponse` nunca produce
   * `{amount > 0, currency: null}`. La combinación puede existir en la columna
   * igual — filas escritas antes de que el parser sintetizara la moneda, o una
   * moneda futura no-ARS que el parser todavía no sepa nombrar. El guard cubre
   * ESE caso: monto positivo que el bot iba a emitir, sin moneda confirmada.
   * (post-F1 el guard ya NO se dispara con monto <= 0 — ver F1/F1b arriba.)
   */
  it('S21 — trusted balance, unconfirmed currency: balanceCurrency:null sobre un monto POSITIVO ⇒ handoff, NUNCA asume ARS', async () => {
    const unconfirmedCurrency = customerFrom({ ...CUSTOMER_ROW, balanceCurrency: null });
    const resolver = new ClienteSaldoResolver(repoOf(unconfirmedCurrency));

    const facts = await resolver.resolve(ctx);

    expect(facts).toEqual({ disponible: false, motivo: 'moneda_no_confirmada' });
    expect(JSON.stringify(facts)).not.toContain('ARS');
  });

  it('S22 — regression: confirmed currency still emits normally', async () => {
    const confirmedCurrency = customerFrom({ ...CUSTOMER_ROW, balanceDue: 1000, balanceCurrency: 'ARS' });
    const resolver = new ClienteSaldoResolver(repoOf(confirmedCurrency));

    await expect(resolver.resolve(ctx)).resolves.toMatchObject({
      disponible: true,
      saldo: 1000,
      moneda: 'ARS',
    });
  });
});
