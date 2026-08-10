import { ClienteSaldoResolver } from '@infrastructure/adapters/assistant/ClienteSaldoResolver';
import { assertFactsArePiiFree } from '@application/use-cases/assistant/assistantPiiGuard';
import type { Customer } from '@domain/entities/customer';
import type { CustomerRepository } from '@domain/ports/CustomerRepository';
import type { AssistantSubjectContext } from '@domain/ports/AssistantDataSourceRegistry';
import { MOTIVO_GUIA, GUIA_SALDO_A_FAVOR, type AssistantMotivo } from '@infrastructure/adapters/assistant/assistantMotivoGuia';
import { RefreshClientBalanceIfStale } from '@application/use-cases/RefreshClientBalanceIfStale';
import { GetClientDetail } from '@application/use-cases/GetClientDetail';
import { buildNumberWhitelist, findUnbackedNumbers } from '@application/use-cases/assistant/assistantNumberVerifier';
import { InMemoryGestionRealPort } from '@infrastructure/adapters/in-memory/InMemoryGestionRealPort';
import { InMemoryClientMirrorRepository } from '@infrastructure/adapters/in-memory/InMemoryClientMirrorRepository';
import { parseClientBalanceResponse } from '@infrastructure/adapters/gestion-real/GestionRealClient';
import { customerFrom, grBalanceRow, grBalancePayload, FIXED_NOW, type FixtureRow } from '../../../helpers/customerFixture';

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
// FW2-2: 3h, no 90min. El TTL efectivo del carril rápido es el configurado más
// el margen que cubre la duración del batch (60 + 60 = 2h).
const STALE_AT = new Date(FIXED_NOW.getTime() - 3 * 60 * 60 * 1000); // 3 h antes — pasó el TTL efectivo
/** 30h antes — pasó el TTL de los DOS carriles (rápido 60min, lento 26h). */
const VERY_STALE_AT = new Date(FIXED_NOW.getTime() - 30 * 60 * 60 * 1000);

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

  /**
   * ⚠️ **FW2-1 — el saldo NEGATIVO no se emite crudo.**
   *
   * El `saldo: -5000` viajaba tal cual a los hechos, y el verificador de números
   * lo recorre para armar el whitelist: `collectFromValue(-5000)` mete `"5000"`
   * como cifra RESPALDADA. Resultado: "tenés una deuda de 5000" pasaba la última
   * red del sistema — el mismo número, con el signo (y la moneda, que acá es
   * `null`) perdidos en el camino.
   *
   * La fila es PRODUCIBLE: `parseGrDebtStrict` acepta negativos, y el parser
   * sintetiza `currency = amount > 0 ? 'ARS' : null` ⇒ un crédito llega SIEMPRE
   * sin denominar. Un monto sin moneda es exactamente lo que el guard de moneda
   * existe para no emitir.
   */
  it('FW2-1 — saldo a favor (debt negativa): el monto NO sale en los hechos (saldo clampeado a 0, tieneDeuda false)', async () => {
    const aFavor = customerFrom({ ...CUSTOMER_ROW, ...grBalanceRow('-5000.00', FRESH_AT) });
    // Premisa: la fila real trae el crédito SIN moneda.
    expect(aFavor.balanceDue).toBe(-5000);
    expect(aFavor.balanceCurrency).toBeNull();

    const facts = await new ClienteSaldoResolver(repoOf(aFavor)).resolve(ctx);

    expect(facts).toMatchObject({
      disponible: true,
      saldo: 0,
      moneda: null,
      tieneDeuda: false,
      // El crédito no se puede decir, pero tampoco se puede ignorar: el copy
      // manda a un asesor en vez de dejar al modelo improvisando.
      guia: GUIA_SALDO_A_FAVOR,
    });
    // El pin que importa: el monto no está, ni con signo ni sin él.
    expect(JSON.stringify(facts)).not.toContain('5000');
    // Y la guía misma no puede meter cifras por la puerta de al lado
    // (todo texto de los hechos alimenta el whitelist del verificador).
    expect(GUIA_SALDO_A_FAVOR).not.toMatch(/\d{3,}/);
  });

  it('FW2-1 — el cliente al día (saldo exactamente 0) NO lleva guía de crédito: no hay nada que confirmar', async () => {
    const alDia = customerFrom({ ...CUSTOMER_ROW, ...grBalanceRow('0.00', FRESH_AT) });

    const facts = await new ClienteSaldoResolver(repoOf(alDia)).resolve(ctx);

    expect(facts).toEqual({
      disponible: true,
      saldo: 0,
      moneda: null,
      tieneDeuda: false,
      estadoCliente: 'active',
    });
  });

  /**
   * FW2-1 (b) — **el pin del verificador**, que es donde el daño se materializaba.
   *
   * `buildNumberWhitelist` recorre los hechos y respalda toda secuencia de 3+
   * dígitos que encuentre. Con el saldo crudo, `5000` quedaba autorizado y el
   * modelo podía escribirlo en cualquier frase — incluida la inversa exacta de la
   * verdad ("tenés una deuda de 5000" sobre un cliente con saldo A FAVOR).
   */
  it('FW2-1b — con esos hechos, 5000 NO está en el whitelist del verificador (y "deuda de 5000" se marca sin respaldo)', async () => {
    const aFavor = customerFrom({ ...CUSTOMER_ROW, ...grBalanceRow('-5000.00', FRESH_AT) });

    const facts = await new ClienteSaldoResolver(repoOf(aFavor)).resolve(ctx);
    const whitelist = buildNumberWhitelist({ facts, profileTexts: [], customerMessages: [] });

    expect(whitelist.has('5000')).toBe(false);
    expect(findUnbackedNumbers('Tenés una deuda de 5000 pesos', whitelist)).toContain('5000');
  });

  /**
   * FW2-1 (c) — **la asimetría es DELIBERADA, no un olvido.**
   *
   * El bot clampa el negativo porque lo lee un modelo que va a repetir la cifra
   * a un cliente por WhatsApp, sin moneda y sin signo. La ficha y el inbox NO lo
   * clampan: los lee un HUMANO de soporte, para quien `-5000` es información
   * legítima (saldo a favor) que puede interpretar y confirmar. Este test pinea
   * las dos mitades juntas para que nadie "unifique" el criterio por prolijidad.
   */
  it('FW2-1c — asimetría deliberada: el bot clampa el negativo, la ficha (humano) ve el crudo', async () => {
    const aFavor = customerFrom({ ...CUSTOMER_ROW, ...grBalanceRow('-5000.00', FRESH_AT) });
    const repo = repoOf(aFavor);

    const facts = await new ClienteSaldoResolver(repo).resolve(ctx);
    const ficha = await new GetClientDetail(repo).execute('client-1');

    expect(facts).toMatchObject({ saldo: 0 });
    expect(JSON.stringify(facts)).not.toContain('5000');
    // El humano SÍ ve el crudo, con signo.
    expect(ficha.balanceDue).toBe(-5000);
  });

  // ── La regla que importa ─────────────────────────────────────────────────
  it('S18 — yesterday balance, refresh fails: NO emite el número cuando el saldo está desactualizado', async () => {
    const stale = customerFrom({ ...CUSTOMER_ROW, lastBalanceAt: STALE_AT });
    const resolver = new ClienteSaldoResolver(repoOf(stale)); // sin refresh collaborator

    const facts = await resolver.resolve(ctx);

    expect(facts).toEqual({ disponible: false, motivo: 'saldo_desactualizado', guia: MOTIVO_GUIA.saldo_desactualizado });
    expect(JSON.stringify(facts)).not.toContain('45000');
  });

  /**
   * ⚠️ fix wave F10 — **la fixture vieja era degenerada.** Usaba
   * `{...CUSTOMER_ROW, grClienteId: null}`, que heredaba `lastBalanceAt:
   * FRESH_AT`: un cliente SIN link GR con un balance recién refrescado. En prod
   * eso no existe — ningún carril de sync toca una fila sin `grClienteId`, así
   * que el no-linkeado llega con `lastBalanceAt: null` (⇒ `balanceStale: true`).
   *
   * Con la fixture degenerada el mutante M1 (invertir el orden de los dos
   * guards) sobrevivía los 10 tests: como `balanceStale` era `false`, el guard
   * de stale no atrapaba nada y el veredicto salía igual por el otro camino. La
   * fila REAL activa los DOS guards a la vez — y ahí el orden pasa a importar.
   */
  it('S20/F10 — no GR link (fila REAL: lastBalanceAt null): saldo_nunca_consultado, y el ORDEN de los guards es el que decide', async () => {
    const unlinked = customerFrom({ ...CUSTOMER_ROW, grClienteId: null, lastBalanceAt: null });
    // Sanity: la fila real dispara AMBOS guards. Sin esto el test no discrimina.
    expect(unlinked.balanceDue).toBeNull();
    expect(unlinked.balanceStale).toBe(true);

    const resolver = new ClienteSaldoResolver(repoOf(unlinked));

    // "Nunca lo consultamos" es más honesto —y más accionable— que "está
    // desactualizado": no hay nada desactualizado, no hay NADA. Invertir los
    // guards le haría decir al bot que el saldo está viejo sobre un cliente del
    // que jamás tuvimos un saldo.
    await expect(resolver.resolve(ctx)).resolves.toEqual({
      disponible: false,
      motivo: 'saldo_nunca_consultado',
      guia: MOTIVO_GUIA.saldo_nunca_consultado,
    });
  });

  it('S20b/F10 — edge: sin link GR pero con lastBalanceAt real (cliente DESVINCULADO) — el guard de balanceDue null va PRIMERO igual', async () => {
    // Posible: un cliente que tuvo link GR y se desvinculó conserva el
    // `lastBalanceAt` en la columna, pero el mapper le anula `balanceDue`
    // (spec `customer-balance-truth`: sin link no hay dato verificado). El
    // veredicto sigue siendo "nunca consultado" — no tenemos un saldo suyo
    // que podamos afirmar, viejo o nuevo.
    const desvinculado = customerFrom({ ...CUSTOMER_ROW, grClienteId: null, lastBalanceAt: FRESH_AT });
    expect(desvinculado.balanceDue).toBeNull();
    expect(desvinculado.balanceStale).toBe(false);

    const resolver = new ClienteSaldoResolver(repoOf(desvinculado));

    await expect(resolver.resolve(ctx)).resolves.toMatchObject({
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
    expect(execute).toHaveBeenCalledWith({ grClienteId: 'GR1', lastBalanceAt: STALE_AT.toISOString(), status: 'active' });
  });

  /**
   * fix wave 2 (FW2-3) — **el CUARTO call site del refresh.**
   *
   * F7 metió el `status` en `RefreshInput` para que el TTL saliera del CARRIL, y
   * lo cableó en la ficha y en el inbox... pero no acá. El bot pedía el refresh
   * sin status ⇒ carril RÁPIDO siempre, incluso para una `baja` cuyo dato ya es
   * todo lo fresco que su carril (1×/día) permite: el gate visible (`balanceStale`
   * del mapper, que SÍ es por carril) y el gate real discrepando en silencio, que
   * es exactamente el defecto que F7 nombró y cerró en las otras dos superficies.
   *
   * Hoy es inerte por ACCIDENTE: el `if` de afuera exige `customer.balanceStale`,
   * que el mapper ya calculó con el TTL del carril, así que una `baja` fresca
   * nunca llega hasta acá. Apoyarse en eso es apoyarse en que dos gates
   * independientes coincidan para siempre — el hermano del defecto, no su ausencia.
   */
  it('FW2-3 — el refresh recibe el status del cliente (el carril del TTL vale también para el bot)', async () => {
    const execute = jest.fn().mockResolvedValue(false);
    // ⚠️ 30h, no 90min: una `baja` de 90min NO es stale (TTL del carril lento =
    // 26h), así que el `if` de afuera ni siquiera llegaría al refresh. Esa es la
    // "inercia por accidente" en vivo — y por eso la fila tiene que ser stale en
    // los DOS carriles para que este test ejercite el paso del status.
    const baja = customerFrom({ ...CUSTOMER_ROW, status: 'baja', lastBalanceAt: VERY_STALE_AT });
    expect(baja.balanceStale).toBe(true);

    await new ClienteSaldoResolver(repoOf(baja), { execute } as never).resolve(ctx);

    expect(execute).toHaveBeenCalledWith({
      grClienteId: 'GR1',
      lastBalanceAt: VERY_STALE_AT.toISOString(),
      status: 'baja',
    });
  });

  /**
   * fix wave F11(b) — mutante M2: quitarle el `customer.balanceStale &&` al
   * gate del refresh. Sobrevivía porque NINGÚN test asserteaba la NO-invocación
   * — sólo la invocación (P3). El costo del mutante no es un test rojo: es una
   * llamada a GR por CADA mensaje de WhatsApp de un cliente ya fresco, o sea el
   * TTL entero convertido en decoración.
   */
  it('F11b — balance FRESCO: el refresh NO se invoca (el TTL sirve para algo)', async () => {
    const execute = jest.fn().mockResolvedValue(true);
    const resolver = new ClienteSaldoResolver(repoOf(CUSTOMER_BASE), { execute } as never);

    await expect(resolver.resolve(ctx)).resolves.toMatchObject({ disponible: true });
    expect(execute).not.toHaveBeenCalled();
  });

  it('F11b — sin grClienteId tampoco se invoca (no hay a quién preguntarle)', async () => {
    const execute = jest.fn();
    const unlinked = customerFrom({ ...CUSTOMER_ROW, grClienteId: null, lastBalanceAt: null });
    const resolver = new ClienteSaldoResolver(repoOf(unlinked), { execute } as never);

    await resolver.resolve(ctx);
    expect(execute).not.toHaveBeenCalled();
  });

  it('conversación sin cliente identificado no aporta hechos', async () => {
    const resolver = new ClienteSaldoResolver(repoOf(CUSTOMER_BASE));

    await expect(resolver.resolve({ ...ctx, clientId: null })).resolves.toEqual({
      disponible: false,
      motivo: 'cliente_no_identificado',
      guia: MOTIVO_GUIA.cliente_no_identificado,
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

    expect(facts).toEqual({ disponible: false, motivo: 'moneda_no_confirmada', guia: MOTIVO_GUIA.moneda_no_confirmada });
    expect(JSON.stringify(facts)).not.toContain('ARS');
  });

  /**
   * fix wave F5 — el `motivo` es un identificador interno en snake_case. Suelto
   * en el prompt, el modelo improvisa: puede leer "saldo_desactualizado" como
   * "el cliente no pagó", o citar igual un número del hilo. Cada
   * `disponible:false` tiene que llevar el copy EXACTO que el bot debe usar.
   *
   * Exhaustivo sobre los CUATRO caminos de negativa del resolver, no sobre uno
   * de muestra: la lección "fix-wave-buscar-el-hermano" en formato test.
   */
  describe('F5 — todo disponible:false lleva su guía', () => {
    const casos: Array<{ motivo: AssistantMotivo; resolver: () => ClienteSaldoResolver; ctx: AssistantSubjectContext }> = [
      {
        motivo: 'cliente_no_identificado',
        resolver: () => new ClienteSaldoResolver(repoOf(CUSTOMER_BASE)),
        ctx: { ...ctx, clientId: null },
      },
      {
        motivo: 'saldo_nunca_consultado',
        resolver: () => new ClienteSaldoResolver(repoOf(customerFrom({ ...CUSTOMER_ROW, grClienteId: null, lastBalanceAt: null }))),
        ctx,
      },
      {
        motivo: 'saldo_desactualizado',
        resolver: () => new ClienteSaldoResolver(repoOf(customerFrom({ ...CUSTOMER_ROW, lastBalanceAt: STALE_AT }))),
        ctx,
      },
      {
        motivo: 'moneda_no_confirmada',
        resolver: () => new ClienteSaldoResolver(repoOf(customerFrom({ ...CUSTOMER_ROW, balanceCurrency: null }))),
        ctx,
      },
    ];

    it.each(casos)('$motivo sale con su guía, nunca crudo', async ({ motivo, resolver, ctx: caseCtx }) => {
      const facts = await resolver().resolve(caseCtx);

      expect(facts).toEqual({ disponible: false, motivo, guia: MOTIVO_GUIA[motivo] });
      expect(String(facts.guia).length).toBeGreaterThan(20);
    });

    it('la guía no rompe la barrera de PII', async () => {
      const facts = await new ClienteSaldoResolver(
        repoOf(customerFrom({ ...CUSTOMER_ROW, lastBalanceAt: STALE_AT })),
      ).resolve(ctx);

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

  /**
   * fix wave F4 — **el efecto lateral DECLARADO** (spec `assistant-balance-guard`,
   * requirement "resolving `cliente.saldo` may mutate the invoice mirror").
   *
   * Resolver el saldo del bot puede disparar un replace-all de las facturas
   * espejadas del cliente, DENTRO del flujo del webhook de Chatwoot. La decisión
   * fue declararlo, no removerlo: es la misma mutación que la ficha ya hacía,
   * del mismo payload, por la misma instancia del colaborador. El espejo
   * poniéndose al día con la verdad. Suprimir la mitad de las facturas dejaría
   * saldo y facturas en desacuerdo — el split-brain que F3 cierra.
   *
   * Este test NO mockea el refresh: usa el colaborador REAL con GR y mirror
   * in-memory, porque lo que hay que pinear es justamente el efecto de punta a
   * punta, no que alguien lo haya llamado.
   */
  it('F4 — el cliente que pagó: el bot resuelve el saldo ⇒ el espejo de facturas se VACÍA y responde "al día"', async () => {
    const gr = new InMemoryGestionRealPort();
    const mirror = new InMemoryClientMirrorRepository();
    // GR ahora dice deuda 0 y NINGUNA factura: el caso autoritativo de "pagó todo".
    gr.balancesByClient.GR1 = parseClientBalanceResponse('GR1', grBalancePayload('0.00', { grClienteId: 'GR1' }));
    // El espejo todavía tiene la factura vieja del cliente.
    await mirror.upsertInvoices('GR1', [{
      tipo: 'FB', sucursal: '00010', numero: '0001', moneda: 'PES',
      fecha: '26-06-2026', fechaVto: '07-07-2026', importe: 45000, saldo: 45000,
      urlPdf: null, cuponPdf: null, paymentUrl: null,
    }], STALE_AT);
    expect(mirror.invoices).toHaveLength(1); // premisa: había algo que borrar

    const refresh = new RefreshClientBalanceIfStale(gr, mirror, {
      now: () => FIXED_NOW,
      ttlMinutes: 60,
    });
    // Primer findById: stale con deuda. Segundo (post-refresh): al día.
    const stale = customerFrom({ ...CUSTOMER_ROW, lastBalanceAt: STALE_AT });
    const alDia = customerFrom({ ...CUSTOMER_ROW, ...grBalanceRow('0.00', FIXED_NOW) });
    let call = 0;
    const repo = { findById: async () => (call++ === 0 ? stale : alDia) } as unknown as CustomerRepository;

    const facts = await new ClienteSaldoResolver(repo, refresh).resolve(ctx);

    // (1) el efecto lateral declarado ocurrió...
    expect(gr.balanceCalls).toEqual(['GR1']);
    expect(mirror.balances.get('GR1')?.amount).toBe(0);
    expect(mirror.invoices).toHaveLength(0);
    // (2) ...y el bot responde al día, sin exigir moneda (F1).
    expect(facts).toMatchObject({ disponible: true, tieneDeuda: false, saldo: 0 });
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
