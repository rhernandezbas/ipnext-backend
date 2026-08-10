import { Prisma } from '@prisma/client';
import {
  ClientMirrorRepository,
  UpdateBalanceAndInvoicesParams,
  UpsertResult,
} from '@domain/ports/ClientMirrorRepository';
import { GrClient, GrContract, GrInvoice } from '@domain/entities/gestionReal';
import { mapContractStatus } from '@application/use-cases/mapContractStatus';
import { mapGrInvoice } from '@application/use-cases/mapGrInvoice';
import { prisma } from '../../database/prisma';

type ClientStatus = 'active' | 'late' | 'blocked' | 'inactive' | 'baja';

/** GR estado.codigo → local ClientStatus enum. */
export function mapStatus(code: string | null): ClientStatus {
  switch (code) {
    case '1': return 'active';     // Activo
    case '2': return 'late';       // Deudor
    case '4': return 'blocked';    // Incobrable
    case '6': return 'baja';       // Baja
    case '3':                      // Inactivo
    default:  return 'inactive';   // fallback (null / '5' / unknown)
  }
}

/** "DD-MM-YYYY" (optionally with time) → Date, or null when unparseable. */
function parseGrDate(s: string | null): Date | null {
  if (!s) return null;
  const [date] = s.split(' ');
  const [d, m, y] = date.split('-').map(Number);
  if (!d || !m || !y) return null;
  return new Date(y, m - 1, d);
}

/**
 * Cliente Prisma o cliente transaccional — las escrituras de abajo son idénticas
 * en los dos, y ésa es toda la gracia: la MISMA sentencia corre suelta
 * (`updateClientBalance`) o dentro de una tx (`updateBalanceAndInvoices`) sin
 * duplicar el cuerpo. Duplicarlo sería el molde clásico de "la función que decide
 * no es la que se testea".
 */
type Db = typeof prisma | Prisma.TransactionClient;

/** Escribe SÓLO las tres columnas de balance — nunca customAttributes, status ni catálogo. */
async function writeBalance(db: Db, grClienteId: string, amount: number, currency: string | null, at: Date): Promise<void> {
  await db.client.updateMany({
    where: { grClienteId },
    data: {
      balanceDue: amount,
      balanceCurrency: currency,
      lastBalanceAt: at,
    },
  });
}

/** Replace-all de las facturas GR del cliente (borra las que GR ya no trae, upsertea las actuales). */
async function replaceGrInvoices(
  db: Db,
  client: { id: string; name: string },
  invoices: GrInvoice[],
  at: Date,
): Promise<void> {
  const mapped = invoices.map((inv) => mapGrInvoice(inv, at));
  const currentIds = mapped.map((m) => m.grInvoiceId);

  await db.invoice.deleteMany({
    where: {
      clientId: client.id,
      grInvoiceId: { not: null },
      NOT: { grInvoiceId: { in: currentIds } },
    },
  });

  for (const m of mapped) {
    const data = {
      number: m.number,
      clientId: client.id,
      customerName: client.name,
      issueDate: m.issueDate ?? at,
      dueDate: m.dueDate ?? at,
      amount: m.amount,
      balance: m.balance,
      grType: m.grType,
      currency: m.currency,
      pdfUrl: m.pdfUrl,
      couponPdfUrl: m.couponPdfUrl,
      paymentUrl: m.paymentUrl,
      status: m.status,
      lineItems: [] as unknown as object, // GR gives no line items
    };
    await db.invoice.upsert({
      where: { grInvoiceId: m.grInvoiceId },
      create: { ...data, grInvoiceId: m.grInvoiceId },
      update: data,
    });
  }
}

/**
 * Prisma write side of the GR mirror. Upserts Client/Service rows keyed by the
 * external GR ids, leaving any pre-existing (e.g. Splynx-sourced) rows untouched.
 */
export class PrismaClientMirrorRepository implements ClientMirrorRepository {
  async upsertClient(c: GrClient): Promise<UpsertResult> {
    const existing = await prisma.client.findUnique({
      where: { grClienteId: c.grClienteId },
      select: { id: true },
    });

    // GUARD: `lat`, `lng`, and `plusCode` are intentionally EXCLUDED from this data object.
    // These are client-geolocation (Prominense-owned GPS) — user-managed fields.
    // The GR sync must NEVER overwrite them; adding them here would silently reset
    // operator-entered GPS data on every sync cycle.
    const data = {
      name: c.name || `Cliente ${c.grClienteId}`,
      email: c.email ?? '',
      phone: c.phone ?? '',
      status: mapStatus(c.statusCode),
      address: c.address,
      city: c.city,
      country: c.province,
      customAttributes: c.raw as object,
    };

    if (existing) {
      await prisma.client.update({ where: { grClienteId: c.grClienteId }, data });
      return { created: false };
    }

    await prisma.client.create({
      data: {
        ...data,
        grClienteId: c.grClienteId,
        // login is unique + required; GR has no login, so namespace by GR id.
        login: `gr:${c.grClienteId}`,
      },
    });
    return { created: true };
  }

  async updateClientBalance(grClienteId: string, amount: number, currency: string | null, at: Date): Promise<void> {
    await writeBalance(prisma, grClienteId, amount, currency, at);
  }

  /**
   * fix wave F3 — saldo + facturas en UNA transacción (ver el docstring del puerto).
   *
   * Las DOS escrituras corren con el cliente transaccional `tx`: si la de
   * facturas revienta, Postgres tira abajo también la del saldo. Antes, la del
   * saldo ya estaba commiteada y la inconsistencia quedaba sellada con
   * `lastBalanceAt` fresco.
   */
  async updateBalanceAndInvoices(params: UpdateBalanceAndInvoicesParams): Promise<void> {
    const { grClienteId, amount, currency, invoices, at } = params;

    // La resolución del cliente local va FUERA de la tx: es una lectura y no
    // participa del rollback (mismo criterio que `upsertInvoices`, que ya la
    // hacía afuera). Sin cliente local, el espejo de facturas no aplica —
    // pero la escritura del saldo sigue siendo un no-op inofensivo, igual que
    // en `updateClientBalance`.
    const client = invoices === null
      ? null
      : await prisma.client.findUnique({ where: { grClienteId }, select: { id: true, name: true } });

    await prisma.$transaction(async (tx) => {
      await writeBalance(tx, grClienteId, amount, currency, at);
      if (invoices !== null && client) {
        await replaceGrInvoices(tx, client, invoices, at);
      }
    });
  }

  /**
   * Replace-all sync of a client's GR invoices into the local Invoice table.
   *
   * Resolve the local client by grClienteId (no-op if absent — same contract as
   * updateClientBalance). Then, in ONE transaction:
   *   1. deleteMany the client's GR-sourced invoices (grInvoiceId NOT NULL) whose
   *      grInvoiceId is NOT in the current set → the `{ not: null }` guard means
   *      manual invoices (grInvoiceId null) are NEVER deleted. An empty current
   *      set deletes all of the client's GR invoices (paid off → disappears).
   *   2. upsert each current invoice by its composite grInvoiceId.
   */
  async upsertInvoices(grClienteId: string, invoices: GrInvoice[], at: Date): Promise<void> {
    const client = await prisma.client.findUnique({
      where: { grClienteId },
      select: { id: true, name: true },
    });
    if (!client) return; // unknown client → no-op (mirror of updateClientBalance)

    await prisma.$transaction(async (tx) => {
      await replaceGrInvoices(tx, client, invoices, at);
    });
  }

  async upsertContract(k: GrContract): Promise<UpsertResult> {
    const parent = await prisma.client.findUnique({
      where: { grClienteId: k.grClienteId },
      select: { id: true },
    });
    // Parent must exist — the client sync always runs before contracts.
    // Return skipped:true so the delta use case can distinguish "orphan skip"
    // from "contract updated" and report accurate counters.
    if (!parent) return { created: false, skipped: true };

    const existing = await prisma.contract.findUnique({
      where: { grContratoId: k.grContratoId },
      select: { id: true },
    });

    // GUARD: `technology`, `name`, `gpsLat`, `gpsLng`, and `gpsPlusCode` are intentionally
    // EXCLUDED from this data object.
    // - `technology` is backed by the ContractTechnology catalog (user-managed).
    // - `name` (#43) is a manual-only identifier (user-managed).
    // - `gpsLat`, `gpsLng`, `gpsPlusCode` are client-geolocation (Prominense-owned GPS).
    // The GR sync must NEVER overwrite any of these — adding them here would silently reset
    // operator-entered data on every sync cycle (spec CN-3.1/3.2 + client-geolocation).
    // If you add new GR fields, double-check they are not user-owned.
    // NOTE: `lat` and `lng` below ARE GR-owned (install address coords) and ARE synced.
    const data = {
      type: 'internet',
      plan: k.plan ?? 'Sin plan',
      // Canonicalize the raw GR estado ("Vigente"/"Baja"/…) → FE enum, symmetric with
      // the client mapStatus above. Keeps NEW mirror rows canonical; computed-on-read
      // (ListContracts/clients route/external) still covers any legacy raw rows.
      status: mapContractStatus(k.status),
      startDate: parseGrDate(k.startDate) ?? new Date(),
      address: k.address ?? null,
      lat: k.lat ?? null,
      lng: k.lng ?? null,
      // GR-owned: el vendedor/agente que dio de alta. NO es user-managed → GR-wins en cada sync.
      vendedor: k.vendedor ?? null,
      // GR-owned (recapture-active-client-match, Decisión 5): motivo de baja del contrato.
      // Forward-only, GR-wins en cada sync — igual que vendedor.
      motivoBaja: k.motivoBaja ?? null,
      // REQ-DELTA-12: include clientId in the shared data block so the UPDATE branch also
      // reassigns the owner. GR creates a new grContratoId on ownership change, so this is
      // defensive robustness — but cheap and eliminates a latent inconsistency.
      clientId: parent.id,
    };

    if (existing) {
      await prisma.contract.update({ where: { grContratoId: k.grContratoId }, data });
      return { created: false };
    }

    await prisma.contract.create({
      data: { ...data, grContratoId: k.grContratoId },
    });
    return { created: true };
  }
}
