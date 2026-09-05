/**
 * ai-assistant-cobranzas (3.8 / D11) — selector determinístico post-hechos: decide con un
 * booleano, un signo y un regex — nada probabilístico se le delega al modelo, porque el peor
 * modo de falla (decirle "estás al día" a alguien que debe plata) no puede depender de que el
 * clasificador acierte.
 *
 * Orden de evaluación (design D11):
 *   1. `recibos_hoy` no disponible O sin match ⇒ `comprobante_transferencia` (R1)
 *   2. match ∧ `debt > 0` ∧ promesa en el texto ⇒ `pago_parcial_con_promesa` (R4)
 *   3. match ∧ `debt > 0` (sin promesa) ⇒ `comprobante_mp` (R2, sigue debiendo)
 *   4. match ∧ `debt ≤ 0` ⇒ `comprobante_mp` (R2, al día / saldo a favor)
 *   5. `posibleDoblePago` ⇒ además, label `administracion` (R5)
 *
 * Si la fila del `roleKey` de destino no existe o está deshabilitada en el perfil, el
 * selector NO inventa comportamiento: reporta `missing_role` para que el caller (5.7, Lote G2)
 * derive a `handoff`/`necesita-humano` con el motivo (INT-3/INT-4).
 */

export interface ComprobanteFacts {
  /** `cliente.recibos_hoy.disponible` — `false` = GR no respondió (D9). */
  recibosDisponible: boolean;
  /** `cliente.recibos_hoy.matchOperacion.encontrado`. */
  matchEncontrado: boolean;
  /** `cliente.saldo.debt` de la MISMA corrida. `null` = no disponible. */
  debt: number | null;
  /** `detectPaymentPromise(texto, patterns de la fila promesa_pago)` — ya evaluado por el caller. */
  hasPromise: boolean;
  /** `detectDoublePayment(recibos)` — ya evaluado por el caller. */
  posibleDoblePago: boolean;
}

export type ComprobanteRoleKey = 'comprobante_transferencia' | 'pago_parcial_con_promesa' | 'comprobante_mp';

export type ComprobanteOutcome =
  | { kind: 'roleKey'; roleKey: ComprobanteRoleKey; extraLabels: string[] }
  | { kind: 'missing_role'; roleKey: ComprobanteRoleKey; reason: string };

/** Roles disponibles: el set de `roleKey` de intents HABILITADAS en este perfil. */
export type AvailableRoleKeys = ReadonlySet<string> | readonly string[];

function isAvailable(roleKey: string, available: AvailableRoleKeys): boolean {
  if (available instanceof Set) return available.has(roleKey);
  return (available as readonly string[]).includes(roleKey);
}

function resolve(roleKey: ComprobanteRoleKey, extraLabels: string[], available: AvailableRoleKeys): ComprobanteOutcome {
  if (!isAvailable(roleKey, available)) {
    return {
      kind: 'missing_role',
      roleKey,
      reason: `La intent con roleKey "${roleKey}" no existe o está deshabilitada en este perfil`,
    };
  }
  return { kind: 'roleKey', roleKey, extraLabels };
}

export function selectComprobanteOutcome(
  facts: ComprobanteFacts,
  availableRoleKeys: AvailableRoleKeys,
): ComprobanteOutcome {
  const extraLabels = facts.posibleDoblePago ? ['administracion'] : [];

  // Fila 1 (R1) — sin recibos o sin match: no se puede verificar el pago.
  if (!facts.recibosDisponible || !facts.matchEncontrado) {
    return resolve('comprobante_transferencia', extraLabels, availableRoleKeys);
  }

  // Fila 2 (R4) — pago parcial con promesa: gana ANTES que el acuse simple.
  if (facts.debt !== null && facts.debt > 0 && facts.hasPromise) {
    return resolve('pago_parcial_con_promesa', extraLabels, availableRoleKeys);
  }

  // Filas 3/4 (R2) — comprobante_mp cubre debt>0 (sigue debiendo) y debt≤0 (al día/a favor);
  // el signo exacto lo redacta `renderBalanceSignMessage` (3.7), no este selector.
  return resolve('comprobante_mp', extraLabels, availableRoleKeys);
}
