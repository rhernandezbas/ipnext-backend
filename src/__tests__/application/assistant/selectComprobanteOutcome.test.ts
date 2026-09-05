import { selectComprobanteOutcome, type ComprobanteFacts } from '@application/use-cases/assistant/selectComprobanteOutcome';

/**
 * ai-assistant-cobranzas (3.8 / D11) — selector determinístico post-hechos: decide con un
 * booleano, un signo y un regex — nada probabilístico. Las 5 filas de la tabla D11.
 */

function facts(overrides: Partial<ComprobanteFacts> = {}): ComprobanteFacts {
  return {
    recibosDisponible: true,
    matchEncontrado: true,
    debt: 100,
    hasPromise: false,
    posibleDoblePago: false,
    ...overrides,
  };
}

const ALL_ROLES = new Set(['comprobante_transferencia', 'pago_parcial_con_promesa', 'comprobante_mp']);

describe('selectComprobanteOutcome', () => {
  it('D11 fila 1: recibos_hoy no disponible ⇒ comprobante_transferencia', () => {
    const outcome = selectComprobanteOutcome(facts({ recibosDisponible: false }), ALL_ROLES);

    expect(outcome).toMatchObject({ kind: 'roleKey', roleKey: 'comprobante_transferencia' });
  });

  it('D11 fila 1: sin match ⇒ comprobante_transferencia (R1)', () => {
    const outcome = selectComprobanteOutcome(facts({ matchEncontrado: false }), ALL_ROLES);

    expect(outcome).toMatchObject({ kind: 'roleKey', roleKey: 'comprobante_transferencia' });
  });

  it('D11 fila 2: match + debt>0 + promesa ⇒ pago_parcial_con_promesa (R4)', () => {
    const outcome = selectComprobanteOutcome(
      facts({ debt: 100122.95, hasPromise: true }),
      ALL_ROLES,
    );

    expect(outcome).toMatchObject({ kind: 'roleKey', roleKey: 'pago_parcial_con_promesa' });
  });

  it('D11 fila 3: match + debt>0 sin promesa ⇒ comprobante_mp (R2)', () => {
    const outcome = selectComprobanteOutcome(
      facts({ debt: 72589.41, hasPromise: false }),
      ALL_ROLES,
    );

    expect(outcome).toMatchObject({ kind: 'roleKey', roleKey: 'comprobante_mp' });
  });

  it('D11 fila 4: match + debt=0 ⇒ comprobante_mp (R2, al día)', () => {
    const outcome = selectComprobanteOutcome(facts({ debt: 0 }), ALL_ROLES);

    expect(outcome).toMatchObject({ kind: 'roleKey', roleKey: 'comprobante_mp' });
  });

  it('D11 fila 4: match + debt<0 ⇒ comprobante_mp (R2, saldo a favor)', () => {
    const outcome = selectComprobanteOutcome(facts({ debt: -77997.19 }), ALL_ROLES);

    expect(outcome).toMatchObject({ kind: 'roleKey', roleKey: 'comprobante_mp' });
  });

  it('D11 fila 5 (R5): posibleDoblePago agrega el label administracion', () => {
    const outcome = selectComprobanteOutcome(
      facts({ debt: -77997.19, posibleDoblePago: true }),
      ALL_ROLES,
    );

    expect(outcome).toMatchObject({ kind: 'roleKey', roleKey: 'comprobante_mp' });
    if (outcome.kind === 'roleKey') {
      expect(outcome.extraLabels).toContain('administracion');
    }
  });

  it('sin doble pago, no agrega el label administracion', () => {
    const outcome = selectComprobanteOutcome(facts({ debt: 0, posibleDoblePago: false }), ALL_ROLES);

    if (outcome.kind === 'roleKey') {
      expect(outcome.extraLabels).not.toContain('administracion');
    }
  });

  // ── roleKey de destino ausente o deshabilitado (INT-3/INT-4) ────────────────
  it('roleKey de destino AUSENTE ⇒ handoff necesita-humano con el motivo, nunca comportamiento inventado', () => {
    const missingRoles = new Set(['pago_parcial_con_promesa', 'comprobante_mp']); // sin comprobante_transferencia

    const outcome = selectComprobanteOutcome(facts({ matchEncontrado: false }), missingRoles);

    expect(outcome.kind).toBe('missing_role');
    if (outcome.kind === 'missing_role') {
      expect(outcome.roleKey).toBe('comprobante_transferencia');
      expect(outcome.reason).toMatch(/comprobante_transferencia/);
    }
  });

  it('roleKey de destino DESHABILITADO (no está en availableRoleKeys) ⇒ missing_role', () => {
    const noRoles = new Set<string>();

    const outcome = selectComprobanteOutcome(facts({ debt: 100, hasPromise: true }), noRoles);

    expect(outcome).toMatchObject({ kind: 'missing_role', roleKey: 'pago_parcial_con_promesa' });
  });
});
