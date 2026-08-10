/**
 * customer-balance-unmask (design.md Decisión 7) — helper compartido para
 * construir fixtures de `Customer` que PASAN POR EL MAPPER REAL (`toCustomer`).
 *
 * El bug que este change corrige (`toCustomer` enmascaraba `balanceDue` a 0
 * para todo no-`late`) sobrevivió porque varios tests armaban `Customer` a
 * mano con pares `status`/`balanceDue` que el mapper real JAMÁS produce
 * (`{status:'active', balanceDue:45000, balanceStale:false}`) — cobertura
 * verde sobre un mundo imposible. `customerFrom()` cierra ese hueco: todo
 * `Customer` de fixture nace de `toCustomer(row, ttl, now)`, con reloj fijo
 * por defecto (nunca fake timers — lección "reloj fijo al gate del journey",
 * `fdd05af0`).
 */
import { toCustomer } from '@infrastructure/adapters/prisma/PrismaCustomerRepository';
import { parseClientBalanceResponse } from '@infrastructure/adapters/gestion-real/GestionRealClient';
import type { Customer } from '@domain/entities/customer';

/** Reloj fijo por defecto — deterministico, sin fake timers. */
export const FIXED_NOW = new Date('2026-08-10T12:00:00.000Z');

/** Row Prisma-like: la forma cruda que `toCustomer` espera (ver PrismaCustomerRepository.ts). */
export interface FixtureRow {
  id: string;
  name: string;
  email: string;
  phone: string;
  status: string;
  address: string;
  city: string;
  country: string;
  login: string;
  createdAt: Date;
  customAttributes: Record<string, string> | null;
  grClienteId: string | null;
  balanceDue: number | { toNumber(): number } | null;
  balanceCurrency: string | null;
  lastBalanceAt: Date | null;
}

/** Row Prisma-like plausible: unlinked por defecto (sin grClienteId, sin balance). */
export const BASE_ROW: FixtureRow = {
  id: 'c-1',
  name: 'Test Client',
  email: 'test@test.com',
  phone: '123',
  status: 'active',
  address: 'Calle 1',
  city: 'Mercedes',
  country: 'AR',
  login: 'test',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  customAttributes: null,
  grClienteId: null,
  balanceDue: null,
  balanceCurrency: null,
  lastBalanceAt: null,
};

export interface CustomerFromOptions {
  ttlMinutes?: number;
  now?: () => Date;
}

/**
 * Construye un `Customer` corriendo `toCustomer` de verdad sobre
 * `{...BASE_ROW, ...row}`. Ningún estado se inventa a mano: si el par que le
 * pasás no es producible por el mapper real, `toCustomer` lo va a dejar en
 * evidencia (por ejemplo, `balanceDue` en un row sin `grClienteId` siempre
 * sale `null`, nunca el valor que le pasaste — spec `customer-balance-truth`).
 */
export function customerFrom(
  row: Partial<FixtureRow> & Record<string, unknown> = {},
  opts: CustomerFromOptions = {},
): Customer {
  return toCustomer(
    { ...BASE_ROW, ...row },
    opts.ttlMinutes ?? 60,
    opts.now ?? (() => FIXED_NOW),
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * fix wave (F1) — REGLA DE FIXTURES DE BALANCE
 *
 * `customerFrom` cerró el hueco "Customer a mano" ⇒ "Customer del mapper real".
 * Pero quedó un hueco MÁS ADENTRO: la FILA. Un review adversarial encontró un
 * CRITICAL que vivía exactamente ahí — `{balanceDue: 0, balanceCurrency: 'ARS'}`
 * es una fila plausible a ojo, pero la escritura real JAMÁS la produce: la moneda
 * la SINTETIZA `parseClientBalanceResponse` como `amount > 0 ? 'ARS' : null`, así
 * que "sin deuda" ⟺ "moneda null". Con una fila imposible, el guard de moneda
 * parecía inofensivo; con la fila REAL, apagaba el "estás al día" de ~2.300
 * clientes.
 *
 * Regla: **todo fixture de balance nace de un payload GR pasado por el parser
 * real**, nunca de un par `{balanceDue, balanceCurrency}` escrito a mano.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Payload GR mínimo y REALISTA para `action: 'cliente'` (forma medida en vivo). */
export function grBalancePayload(
  debt: string | number,
  opts: { invoices?: unknown[]; grClienteId?: string } = {},
): Record<string, unknown> {
  return {
    error: '0',
    clientes: [
      {
        idcustomer: opts.grClienteId ?? 'GR1',
        cuentas: {
          debt,
          invoices_qty: String(opts.invoices?.length ?? 0),
          invoices: opts.invoices ?? [],
        },
      },
    ],
  };
}

/**
 * Campos de balance de una `FixtureRow` tal como la ESCRITURA REAL los deja:
 * payload GR → `parseClientBalanceResponse` → `updateBalanceAndInvoices({amount,
 * currency, at, ...})` → columnas. No hay forma de inventar acá un par
 * `{balanceDue, balanceCurrency}` que el pipeline no pueda producir.
 */
export function grBalanceRow(
  debt: string | number,
  lastBalanceAt: Date | null,
  opts: { grClienteId?: string; invoices?: unknown[] } = {},
): Pick<FixtureRow, 'grClienteId' | 'balanceDue' | 'balanceCurrency' | 'lastBalanceAt'> {
  const grClienteId = opts.grClienteId ?? 'GR1';
  const parsed = parseClientBalanceResponse(
    grClienteId,
    grBalancePayload(debt, { invoices: opts.invoices, grClienteId }),
  );
  return {
    grClienteId,
    balanceDue: parsed.amount,
    balanceCurrency: parsed.currency,
    lastBalanceAt,
  };
}
