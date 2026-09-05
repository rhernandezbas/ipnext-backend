import { contradictsBalanceState } from '@application/use-cases/assistant/assistantPhraseGuard';

/**
 * ai-assistant-cobranzas (fix wave C5 + N2) — el verificador de FRASE, como función PURA.
 *
 * ⚠️ **Este archivo nació de una regresión que un test end-to-end no cazó.** La primera versión
 * del guard usaba `/deb[eé]s|pendiente|vencid/` contra `debt <= 0`, y con eso descartaba la
 * respuesta CANÓNICA del cliente al día — "No tenés facturas pendientes, estás al día" —
 * mandando a un humano el carril de ~2.300 clientes que FW2-1 peleó por conservar. Los tres
 * asserts que existían vía `ReplyWithAssistant` usaban frases elegidas a mano y ninguna era la
 * respuesta correcta del caso más común.
 *
 * La lección que fija este archivo: **la dirección del regex no alcanza, hay que mirar la
 * POLARIDAD de la oración.** "No tenés deuda" y "Tenés deuda" comparten casi todos los
 * caracteres y afirman lo contrario.
 */

describe('contradictsBalanceState — sin saldo, no opina', () => {
  it('`debt: null` (saldo no disponible) ⇒ nunca contradice', () => {
    expect(contradictsBalanceState('Estás al día.', null)).toBe(false);
    expect(contradictsBalanceState('Tenés una deuda pendiente.', null)).toBe(false);
  });

  it('texto vacío ⇒ nada que contradecir', () => {
    expect(contradictsBalanceState('', 5000)).toBe(false);
    expect(contradictsBalanceState('   ', -100)).toBe(false);
  });
});

describe('contradictsBalanceState — con DEUDA (debt > 0): no se puede decir "al día"', () => {
  it('"estás al día" ⇒ CONTRADICE', () => {
    expect(contradictsBalanceState('¡Hola! Estás al día, no hace falta que pagues nada.', 72589.41)).toBe(true);
  });

  it('"no tenés deuda" ⇒ CONTRADICE', () => {
    expect(contradictsBalanceState('No tenés deuda con nosotros.', 72589.41)).toBe(true);
  });

  it('"no tenés facturas pendientes" ⇒ CONTRADICE', () => {
    expect(contradictsBalanceState('No tenés facturas pendientes.', 100)).toBe(true);
  });

  it('"sin deuda" ⇒ CONTRADICE', () => {
    expect(contradictsBalanceState('Figurás sin deuda en el sistema.', 100)).toBe(true);
  });

  it('N2: "todavía no estás al día" NO contradice — es la verdad', () => {
    expect(contradictsBalanceState('Todavía no estás al día: te queda un saldo pendiente.', 72589.41)).toBe(false);
  });

  it('N2: "no quedaste al día con ese pago" NO contradice', () => {
    expect(contradictsBalanceState('Con ese pago no quedaste al día.', 31178)).toBe(false);
  });

  it('una respuesta correcta de deuda no se marca', () => {
    expect(contradictsBalanceState('Recibimos tu pago y te queda un saldo pendiente.', 72589.41)).toBe(false);
  });
});

describe('contradictsBalanceState — AL DÍA (debt <= 0): no se puede decir que debe', () => {
  /** ⚠️ El caso que rompió el carril rápido: la respuesta CORRECTA del cliente al día. */
  it('N2: "No tenés facturas pendientes, estás al día" NO contradice con debt = 0', () => {
    expect(contradictsBalanceState('No tenés facturas pendientes, estás al día.', 0)).toBe(false);
  });

  it('N2: la misma frase tampoco contradice con saldo A FAVOR', () => {
    expect(contradictsBalanceState('No tenés facturas pendientes, estás al día.', -77997.19)).toBe(false);
  });

  it('N2: "no debés nada" NO contradice', () => {
    expect(contradictsBalanceState('No debés nada, quedaste al día.', 0)).toBe(false);
  });

  it('N2: "no hay deuda registrada" NO contradice', () => {
    expect(contradictsBalanceState('No hay deuda registrada a tu nombre.', 0)).toBe(false);
  });

  it('N2: "no te queda ningún vencimiento" NO contradice', () => {
    expect(contradictsBalanceState('No te quedan vencimientos impagos.', -100)).toBe(false);
  });

  it('"tenés una deuda" ⇒ CONTRADICE', () => {
    expect(contradictsBalanceState('Todavía tenés una deuda con nosotros.', 0)).toBe(true);
  });

  it('"debés" afirmativo ⇒ CONTRADICE', () => {
    expect(contradictsBalanceState('Debés dos facturas.', 0)).toBe(true);
  });

  it('"te quedan facturas pendientes" ⇒ CONTRADICE', () => {
    expect(contradictsBalanceState('Te quedan facturas pendientes de pago.', -50)).toBe(true);
  });

  it('"figura un saldo vencido" ⇒ CONTRADICE', () => {
    expect(contradictsBalanceState('Figura un saldo vencido en tu cuenta.', 0)).toBe(true);
  });

  it('una negación NO puede tapar una afirmación posterior en otra oración', () => {
    // La negación se descarta hasta el corte de cláusula (`,` `;` `.`): lo que viene después
    // se sigue evaluando. Si no, "No tenés problemas de conexión, pero debés $5.000" pasaba.
    expect(contradictsBalanceState('No tenés problemas de conexión, pero debés $5.000.', 0)).toBe(true);
  });

  it('un texto neutro no se marca en ninguna dirección', () => {
    expect(contradictsBalanceState('Gracias por tu mensaje, ya lo verifico.', 0)).toBe(false);
    expect(contradictsBalanceState('Gracias por tu mensaje, ya lo verifico.', 5000)).toBe(false);
  });
});
