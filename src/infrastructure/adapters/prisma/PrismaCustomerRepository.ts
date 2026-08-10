import {
  CustomerRepository,
  ListClientsQuery,
  ListLogsQuery,
  CreateCustomerInput,
  ClientStats,
  UpdateClientLocationInput,
  ActiveClientContact,
  CampaignSegmentSource,
  CampaignSegmentFilter,
  CampaignRecipientCandidate,
  CampaignRecipientLookup,
  ManualRecipientSource,
  OptOutRegistry,
  PortalBalanceSummary,
  PortalBalanceEntry,
  SegmentMembershipChecker,
} from '@domain/ports/CustomerRepository';
import { Customer, CustomerStatus, Contract, ClientLog } from '@domain/entities/customer';
import { Invoice, InvoiceStatus, LineItem } from '@domain/entities/billing';
import { PaginatedResult } from '@application/dto/pagination';
import { ClientNotFoundError } from '@domain/errors';
import { normalizeGrCurrency } from '@domain/services/normalizeGrCurrency';
import { isBalanceOlderThanTtl } from '@application/use-cases/RefreshClientBalanceIfStale';
import { prisma } from '../../database/prisma';

const DEFAULT_BALANCE_TTL_MINUTES = 60;

export function toCustomer(
  row: any,
  balanceTtlMinutes = DEFAULT_BALANCE_TTL_MINUTES,
  now: () => Date = () => new Date(),
): Customer {
  const status = row.status as CustomerStatus;
  // customer-balance-unmask (Decisión 1) — el mapper es un passthrough de la
  // columna para TODO status; ya no existe `isDebtor` acá. La única guarda que
  // queda es "sin link GR, no hay dato verificado" (spec `customer-balance-truth`,
  // requirement "no GR link means no verified data"): ningún carril de sync
  // toca una fila sin `grClienteId`, así que un valor en la columna sería un
  // resto/manual, no un dato confiable.
  const hasGrLink = row.grClienteId !== null && row.grClienteId !== undefined;

  // Map Decimal to number (same pattern as toInvoice)
  const balanceDue: number | null = (() => {
    if (!hasGrLink) return null;
    if (row.balanceDue === null || row.balanceDue === undefined) return null;
    if (typeof row.balanceDue === 'object' && 'toNumber' in row.balanceDue) {
      return (row.balanceDue as { toNumber(): number }).toNumber();
    }
    return Number(row.balanceDue);
  })();
  const balanceCurrency = hasGrLink ? (row.balanceCurrency ?? null) : null;

  const lastBalanceAt = row.lastBalanceAt instanceof Date ? row.lastBalanceAt : null;
  const lastBalanceAtIso = lastBalanceAt ? lastBalanceAt.toISOString() : null;

  return {
    id: row.id,
    grClienteId: row.grClienteId ?? null,
    name: row.name,
    email: row.email,
    phone: row.phone,
    status,
    address: row.address ?? '',
    city: row.city ?? '',
    country: row.country ?? '',
    login: row.login,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    customAttributes: row.customAttributes ?? undefined,
    balanceDue,
    balanceCurrency,
    lastBalanceAt: lastBalanceAtIso,
    // customer-balance-unmask (Decisión 2) — status-agnóstico: el MISMO
    // helper y el MISMO criterio que ya usan `RefreshClientBalanceIfStale` y
    // `GetInboxClientContext` (spec `balance-staleness-helper`). El status
    // dejó de decidir frescura — antes de este change el guard estaba
    // cortocircuitado en abierto para todo no-`late`, sin importar la edad.
    balanceStale: isBalanceOlderThanTtl(lastBalanceAtIso, balanceTtlMinutes, now),
    // client-geolocation — Prominense-owned GPS fields (GR sync NEVER writes these)
    lat: row.lat ?? null,
    lng: row.lng ?? null,
    plusCode: row.plusCode ?? null,
  };
}

export function toService(row: any): Contract {
  return {
    id: row.id,
    // #55 — expose the GR contract code so the FE contract card can show/use it.
    code: row.grContratoId ?? null,
    type: row.type,
    plan: row.plan,
    ip: row.ip ?? '',
    status: row.status,
    startDate: row.startDate instanceof Date ? row.startDate.toISOString() : row.startDate,
    endDate: row.endDate
      ? (row.endDate instanceof Date ? row.endDate.toISOString() : row.endDate)
      : '',
    address: row.address ?? null,
    lat: row.lat ?? null,
    lng: row.lng ?? null,
    // client-geolocation — Prominense-owned GPS on Contract (GR sync NEVER writes gps*)
    gpsLat: row.gpsLat ?? null,
    gpsLng: row.gpsLng ?? null,
    gpsPlusCode: row.gpsPlusCode ?? null,
    // #42 — free-text technology name from the ContractTechnology catalog.
    technology: row.technology ?? null,
    // #43 — manual name (null for GR-synced contracts) + eager-loaded services.
    name: row.name ?? null,
    // vendedor/agente que dio de alta (de GR). Base de la cartera "Mis clientes" por agente.
    vendedor: row.vendedor ?? null,
    // #65 fix wave H3 — tvLogin/tvPassword are deliberately NOT mapped here. The credentials
    // never travel on the contracts list; they are served by the dedicated /tv-credentials endpoint.
    services: (row.contractServices ?? []).map((cs: any) => ({
      id: cs.id,
      serviceCatalogId: cs.serviceCatalogId,
      name: cs.serviceCatalog?.name ?? '',
      label: cs.serviceCatalog?.label ?? null,
      status: cs.status,
      notes: cs.notes ?? null,
      createdAt: cs.createdAt instanceof Date ? cs.createdAt.toISOString() : cs.createdAt,
    })),
  };
}

export function toClientLog(row: any): ClientLog {
  return {
    id: row.id,
    timestamp: row.timestamp instanceof Date ? row.timestamp.toISOString() : row.timestamp,
    eventType: row.eventType,
    description: row.description,
  };
}

/** Prisma Decimal | number | null → number | null (Decimal carries a `.toNumber()`). */
function decimalToNumberOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object' && 'toNumber' in (v as object)) return (v as { toNumber(): number }).toNumber();
  return Number(v);
}

export function toInvoice(row: any): Invoice {
  const lineItems: LineItem[] = Array.isArray(row.lineItems) ? row.lineItems as LineItem[] : [];
  return {
    id: row.id,
    number: row.number,
    customerId: row.clientId,
    customerName: row.customerName,
    issueDate: row.issueDate instanceof Date ? row.issueDate.toISOString() : row.issueDate,
    dueDate: row.dueDate instanceof Date ? row.dueDate.toISOString() : row.dueDate,
    amount: typeof row.amount === 'object' && row.amount !== null && 'toNumber' in row.amount
      ? (row.amount as { toNumber(): number }).toNumber()
      : Number(row.amount),
    status: row.status as InvoiceStatus,
    lineItems,
    grInvoiceId: row.grInvoiceId ?? null,
    balance: decimalToNumberOrNull(row.balance),
    grType: row.grType ?? null,
    currency: row.currency ?? null,
    pdfUrl: row.pdfUrl ?? null,
    couponPdfUrl: row.couponPdfUrl ?? null,
    paymentUrl: row.paymentUrl ?? null,
  };
}

/**
 * fix/portal-balance-from-invoices — pure mapper (molde `toCampaignRecipientCandidate`)
 * de los resultados narrow que arma `getPortalBalanceSummary` en un
 * `PortalBalanceSummary` de dominio, AGRUPADO POR MONEDA ISO. Testeable SIN
 * Prisma real (se le pasan shapes Decimal-like/Date fabricados, mismo
 * criterio que `toInvoice` en `PrismaCustomerRepository.mappers.test.ts`).
 *
 * - `unpaidGroups` — `prisma.invoice.groupBy({ by: ['currency'], where: { clientId,
 *   status: { not: 'pagada' } }, _sum: { balance: true }, _max: { createdAt: true } })`.
 *   UNA fila por código crudo de moneda (`PES`/`DOL`/`null`/...) presente entre las
 *   impagas del cliente — nunca fetch-all + reduce en memoria.
 * - `anyInvoice` — `prisma.invoice.findFirst({ where: { clientId }, orderBy: { createdAt: 'desc' },
 *   select: { currency: true, createdAt: true } })`; `null` si el cliente no tiene NINGUNA
 *   factura espejada (short-circuit a `null` — "sin datos", nunca `balances: []`).
 *
 * Multi-moneda (medido en prod: `PES` 7430 filas / `DOL` 43 filas, 3 clientes
 * con impagas en ambas) — cada grupo se normaliza a ISO 4217 vía
 * `normalizeGrCurrency` y se RE-agrupa (dos códigos crudos distintos, ej.
 * `PES`/`pes`, pueden mapear al mismo ISO y deben sumarse entre sí, pero
 * monedas DISTINTAS jamás se suman). El resultado queda ordenado por `amount`
 * DESC (contrato del port/DTO).
 */
export function toPortalBalanceSummary(
  unpaidGroups: ReadonlyArray<{
    currency: string | null;
    _sum: { balance: unknown };
    _max: { createdAt: Date | null };
  }>,
  anyInvoice: { currency: string | null; createdAt: Date } | null,
): PortalBalanceSummary | null {
  if (!anyInvoice) return null;

  if (unpaidGroups.length === 0) {
    // Sin impagas (todas pagadas): una sola entrada en 0, con la moneda de la
    // factura más reciente overall — seguimos teniendo datos, solo que
    // ninguno es deuda viva (ver doc de `balances`/`lastUpdatedAt` en el port).
    return {
      balances: [{ currency: normalizeGrCurrency(anyInvoice.currency) ?? 'DESCONOCIDA', amount: 0 }],
      lastUpdatedAt: anyInvoice.createdAt.toISOString(),
    };
  }

  // Frescura GLOBAL del número mostrado: la más reciente entre TODAS las
  // monedas impagas (una sola fecha para todo el objeto — el port documenta
  // que `lastUpdatedAt` no distingue por moneda).
  const lastUpdated = unpaidGroups.reduce<Date | null>((latest, g) => {
    const gMax = g._max.createdAt;
    return gMax && (!latest || gMax > latest) ? gMax : latest;
  }, null) ?? anyInvoice.createdAt;

  // Re-agrupa por ISO normalizado; `null` (currency ausente) se acumula
  // aparte porque su etiqueta final depende de si conviven o no monedas
  // conocidas (ver `normalizeGrCurrency`).
  const merged = new Map<string, number>();
  let unknownCurrencyAmount: number | null = null;
  for (const group of unpaidGroups) {
    const amount = decimalToNumberOrNull(group._sum.balance) ?? 0;
    const iso = normalizeGrCurrency(group.currency);
    if (iso === null) {
      unknownCurrencyAmount = (unknownCurrencyAmount ?? 0) + amount;
      continue;
    }
    merged.set(iso, (merged.get(iso) ?? 0) + amount);
  }

  if (unknownCurrencyAmount !== null) {
    // `Invoice.currency` ausente: si es la ÚNICA moneda con deuda del
    // cliente, asumir ARS es seguro (nada real con qué confundirse). Si
    // coexiste con monedas conocidas, se etiqueta 'DESCONOCIDA' — fusionarla
    // con una moneda real mentiría sobre el total de esa moneda.
    const label = merged.size === 0 ? 'ARS' : 'DESCONOCIDA';
    merged.set(label, (merged.get(label) ?? 0) + unknownCurrencyAmount);
  }

  const balances: PortalBalanceEntry[] = Array.from(merged.entries())
    .map(([currency, amount]) => ({ currency, amount }))
    .sort((a, b) => b.amount - a.amount);

  return { balances, lastUpdatedAt: lastUpdated.toISOString() };
}

/**
 * recapture-active-client-match batch 1 — maps a narrow Prisma `Client` row
 * (id/name/phone/email only) into the candidate-contact shape consumed by
 * `matchActiveClient`. Defensive on phone/email: `Client.phone`/`Client.email`
 * are non-null columns today, but the mapper never leaks `undefined` and stays
 * honest with `null` for any row that doesn't carry a value.
 */
export function toActiveClientContact(row: any): ActiveClientContact {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone ?? null,
    email: row.email ?? null,
  };
}

/**
 * Folds Prisma `groupBy(status)` results into a ClientStats breakdown.
 * `total` is the sum of every group; recognized statuses land in their own
 * bucket (active/inactive/blocked/late/baja). Pure + exported for testing.
 */
export function foldClientStats(
  groups: ReadonlyArray<{ status: string; _count: { _all: number } }>,
): ClientStats {
  const out: ClientStats = { total: 0, active: 0, inactive: 0, blocked: 0, late: 0, baja: 0 };
  for (const g of groups) {
    const count = g._count._all;
    out.total += count;
    const key = g.status as keyof Omit<ClientStats, 'total'>;
    if (key in out) out[key] = count;
  }
  return out;
}

/**
 * messaging-bulk (F2, Batch 6, T6.1) — construye el `where` de `list()` de
 * forma PURA y testeable sin Prisma (molde `foldClientStats`). `statuses`
 * (multi, NUEVO) gana sobre `status` (single, F1) SOLO si viene con al menos
 * un elemento — el path F1 (un solo `status`) queda idéntico si `statuses`
 * nunca llega, cero riesgo de regresión (tasks.md T6.2).
 */
export function buildClientListWhere(query: ListClientsQuery): Record<string, unknown> {
  const where: Record<string, unknown> = {};
  if (query.statuses?.length) {
    where['status'] = { in: query.statuses as never };
  } else if (query.status) {
    where['status'] = query.status as never;
  }
  if (query.balanceMin != null || query.balanceMax != null) {
    where['balanceDue'] = {
      ...(query.balanceMin != null ? { gte: query.balanceMin } : {}),
      ...(query.balanceMax != null ? { lte: query.balanceMax } : {}),
    };
  }
  if (query.search) {
    where['OR'] = [
      { name: { contains: query.search, mode: 'insensitive' } },
      { email: { contains: query.search, mode: 'insensitive' } },
      { login: { contains: query.search, mode: 'insensitive' } },
      // manual-recipients (MAN-6) — encontrar por fragmento de teléfono al armar
      // la lista manual del composer (`Client.phone` es NOT NULL en el schema).
      { phone: { contains: query.search, mode: 'insensitive' } },
    ];
  }
  return where;
}

/**
 * messaging-bulk (F2, Batch 6, T6.3, design §4.2) — `where` de
 * `listSegmentRecipients`, PURO y testeable sin Prisma. `statuses` vacío
 * (`[]`) es el escape hatch de OPT-2 (T6.5): resuelve el universo COMPLETO de
 * `Client` sin filtro de status — necesario para matchear un teléfono inbound
 * contra CUALQUIER estado (`late`/`blocked`/`baja`, el público del bulk).
 *
 * ── fix wave 2 (FIX-11): opt-out NO se pre-filtra en el query ────────────────
 * Antes, con `statuses` no vacío, este where agregaba `whatsappOptOutAt: null` a
 * nivel query. Efecto colateral: los opt-out NUNCA llegaban a `resolveRecipients`
 * → el contador `skipped.optedOut` daba SIEMPRE 0 en prod (viola SEG-2), aunque
 * los tests pasaban porque el fake in-memory no filtraba (mock infiel). Ahora el
 * where NO toca opt-out: `resolveRecipients` (SEG-2) los excluye del envío Y los
 * CUENTA, y el SEND path re-chequea opt-out per-destinatario (SEND-5) — no hay
 * hueco de compliance y el fake ahora matchea prod.
 *
 * ── fix wave 2 (FIX-12): rango de deuda y las filas balanceDue = NULL ────────
 * `balanceDue:{gte,lte}` EXCLUYE en silencio las filas `balanceDue = NULL`
 * (deudores never-synced desde GR). Semántica de producto: cuando NO hay piso
 * real (`balanceMin` ausente o 0) se INCLUYEN esos NULL (vía `OR balanceDue:null`)
 * — son deudores válidos aunque no tengamos el monto; cuando hay piso `> 0` se
 * EXCLUYEN (no se puede confirmar que su monto ≥ piso).
 *
 * ── node-segment: filtro por nodo/AP vía relación a contratos ────────────────
 * `contracts: { some: {...} }` — un cliente entra si tiene ≥1 contrato cuyo
 * `networkSiteId` matchea (y cuyo `accessPointId` matchea, si se pasó); ambos
 * en el MISMO `some` = mismo contrato. Sigue siendo UNA query (el join lo
 * resuelve Postgres sobre los índices de `Contract.networkSiteId`/
 * `accessPointId` — sin N+1, sin fetch de contratos en memoria). AND con
 * statuses/deuda (keys top-level). `''` cuenta como ausente (truthy-check,
 * mismo criterio que `segmentHasCriteria` — un some con `''` no matchearía
 * ningún contrato).
 *
 * ── node-segment fix wave (H1): contratos de BAJA no cuentan para el filtro ──
 * `Contract.networkSiteId`/`accessPointId` NO se limpian al dar de baja: sin
 * exclusión, un contrato VIEJO de baja en el nodo X matchearía el some y el
 * cliente mudado/dado de baja recibiría el "aviso de corte del nodo X" de un
 * nodo que ya no lo sirve. El `NOT status='baja'` (case-insensitive, molde
 * `PrismaContractPairingReader`) vive DENTRO del mismo `some`: el contrato que
 * matchea nodo/AP debe además estar vigente — un cliente con baja en X y
 * contrato activo en Y entra por Y y NO por X. Aplica SOLO cuando hay nodo/AP
 * en el segmento; un segmento sin nodo/AP genera un where byte-idéntico al
 * previo (cero riesgo para statuses/deuda).
 */
export function buildSegmentWhere(segment: CampaignSegmentFilter): Record<string, unknown> {
  const where: Record<string, unknown> = {};
  if (segment.statuses.length > 0) {
    where['status'] = { in: segment.statuses as never };
  }
  if (segment.balanceMin != null || segment.balanceMax != null) {
    const range: Record<string, number> = {};
    if (segment.balanceMin != null) range['gte'] = segment.balanceMin;
    if (segment.balanceMax != null) range['lte'] = segment.balanceMax;
    // FIX-12 — sin piso real (piso ausente o ≤ 0), incluir también los NULL.
    const includeNulls = segment.balanceMin == null || segment.balanceMin <= 0;
    if (includeNulls) {
      where['OR'] = [{ balanceDue: range }, { balanceDue: null }];
    } else {
      where['balanceDue'] = range;
    }
  }
  if (segment.networkSiteId || segment.accessPointId) {
    where['contracts'] = {
      some: {
        ...(segment.networkSiteId ? { networkSiteId: segment.networkSiteId } : {}),
        ...(segment.accessPointId ? { accessPointId: segment.accessPointId } : {}),
        // H1 — el contrato que matchea nodo/AP debe estar VIGENTE (ver doc arriba).
        NOT: { status: { equals: 'baja', mode: 'insensitive' } },
      },
    };
  }
  return where;
}

/**
 * portal-promos — construye el WHERE de `clientMatchesSegment` reusando
 * `buildSegmentWhere` TAL CUAL (spread, sin tocar ninguna de sus keys) y
 * agregándole `id: clientId`. Es la ÚNICA razón por la que
 * `listSegmentRecipients` (universo del segmento) y `clientMatchesSegment`
 * (¿este cliente entra?) no pueden divergir en silencio — ver el docblock de
 * `SegmentMembershipChecker` en el port. Extraída como función pura (mismo
 * criterio que `buildSegmentWhere`/`buildClientListWhere`) para poder pinear
 * la forma exacta del WHERE sin Prisma/DB (`PrismaCustomerRepository
 * .clientMatchesSegment.test.ts`).
 */
export function buildClientMatchesSegmentWhere(clientId: string, segment: CampaignSegmentFilter): Record<string, unknown> {
  return { ...buildSegmentWhere(segment), id: clientId };
}

/**
 * messaging-bulk (F2, Batch 6, T6.3) — mapea una fila narrow de Prisma
 * (`id/name/phone/balanceDue/whatsappOptOutAt`) al candidato de dominio. Molde
 * `toActiveClientContact`/`toInvoice` (Decimal→number, Date→ISO string).
 */
export function toCampaignRecipientCandidate(row: any): CampaignRecipientCandidate {
  return {
    clientId: row.id,
    name: row.name,
    phone: row.phone ?? null,
    balanceDue: decimalToNumberOrNull(row.balanceDue),
    whatsappOptOutAt: row.whatsappOptOutAt instanceof Date
      ? row.whatsappOptOutAt.toISOString()
      : (row.whatsappOptOutAt ?? null),
    // messaging-bulk v1.1 (statusCounts) — solo presente cuando el `select` de
    // la query lo pide (`listSegmentRecipients`); `findRecipientCandidate`
    // (re-check per-envío, SEND-5) NO lo selecciona — queda `undefined`,
    // `resolveRecipients` ya lo trata como opcional ('unknown' fallback).
    status: row.status,
  };
}

export class PrismaCustomerRepository
  implements
    CustomerRepository,
    CampaignSegmentSource,
    CampaignRecipientLookup,
    ManualRecipientSource,
    OptOutRegistry,
    SegmentMembershipChecker
{
  /**
   * @param balanceTtlMinutes - TTL for balance staleness in minutes. Defaults to 60.
   *   Pass `config.gestionReal.balanceStaleTtlMinutes` from app.ts.
   */
  constructor(private readonly balanceTtlMinutes = 60) {}

  private get ttl() { return this.balanceTtlMinutes; }

  async list(query: ListClientsQuery): Promise<PaginatedResult<Customer>> {
    const page = query.page && query.page > 0 ? query.page : 1;
    const limit = query.limit && query.limit > 0 ? query.limit : 25;
    // messaging-bulk (F2, T6.2) — where-builder extraído a función pura
    // (buildClientListWhere, arriba) para poder testear la precedencia
    // statuses>status SIN Prisma. Comportamiento idéntico al inline anterior.
    const where = buildClientListWhere(query);
    const [rows, total] = await Promise.all([
      prisma.client.findMany({
        where,
        orderBy: { name: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.client.count({ where }),
    ]);
    return { data: rows.map(r => toCustomer(r, this.ttl)), total, page, limit };
  }

  async findById(id: string): Promise<Customer> {
    const row = await prisma.client.findUnique({ where: { id } });
    if (!row) throw new ClientNotFoundError(id);
    return toCustomer(row, this.ttl);
  }

  async stats(): Promise<ClientStats> {
    const groups = await prisma.client.groupBy({
      by: ['status'],
      _count: { _all: true },
    });
    return foldClientStats(groups);
  }

  async delete(id: string): Promise<boolean> {
    try {
      await prisma.client.delete({ where: { id } });
      return true;
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      // Prisma P2025 -> row to delete does not exist; treat as a not-found.
      if (code === 'P2025') return false;
      throw err;
    }
  }

  async create(data: CreateCustomerInput): Promise<Customer> {
    const row = await prisma.client.create({
      data: {
        name: data.name,
        email: data.email,
        phone: data.phone,
        login: data.login,
        status: (data.status ?? 'active') as never,
        address: data.address ?? null,
        city: data.city ?? null,
        country: data.country ?? null,
        splynxId: data.splynxId ?? null,
        customAttributes: (data.customAttributes as never) ?? undefined,
      },
    });
    return toCustomer(row, this.ttl);
  }

  async listContracts(clientId: string): Promise<Contract[]> {
    const rows = await prisma.contract.findMany({
      where: { clientId },
      orderBy: { startDate: 'desc' },
      // #43 — eager-load services in a SINGLE query (spec CSV-4.4, no N+1).
      // `as any` scoped to the include only (generated types lag the new relation),
      // so where/orderBy keep full type-checking.
      include: {
        contractServices: {
          include: { serviceCatalog: true },
          orderBy: { createdAt: 'asc' },
        },
      } as any,
    });
    return rows.map(toService);
  }

  async listInvoices(clientId: string): Promise<Invoice[]> {
    const rows = await prisma.invoice.findMany({
      where: { clientId },
      orderBy: { issueDate: 'desc' },
    });
    return rows.map(toInvoice);
  }

  /**
   * fix/portal-balance-from-invoices — saldo del portal calculado EN LA DB
   * sobre `Invoice`, jamás sobre `Client.balanceDue` (el agregado del sync de
   * GR, que puede quedar desincronizado de las facturas espejadas — visto en
   * prod con HERNANDEZ RONALD: GR decía `balanceDue = 0` con 5 facturas
   * vencidas por $100.886,90). DOS queries agregadas/narrow (`groupBy` por
   * moneda + `findFirst`), NUNCA `findMany` + reduce en memoria — el costo es
   * O(monedas distintas), no O(facturas), independientemente de cuántas
   * facturas tenga el cliente.
   *
   * Multi-moneda (fix wave) — `groupBy(['currency'])` reemplaza al `aggregate`
   * anterior: medido en prod, `Invoice.currency` tiene `PES`/`DOL` (códigos de
   * GR, no ISO) y hay clientes con impagas en las dos monedas al mismo tiempo.
   * Sumarlas en un `aggregate` plano (sin agrupar) era el bug — un solo
   * número mezclando pesos con dólares. La normalización a ISO 4217 pasa
   * DESPUÉS del groupBy, en el mapper puro `toPortalBalanceSummary`.
   */
  async getPortalBalanceSummary(clientId: string): Promise<PortalBalanceSummary | null> {
    const [unpaidGroups, anyInvoice] = await Promise.all([
      prisma.invoice.groupBy({
        by: ['currency'],
        where: { clientId, status: { not: 'pagada' as never } },
        _sum: { balance: true },
        _max: { createdAt: true },
      }),
      prisma.invoice.findFirst({
        where: { clientId },
        orderBy: { createdAt: 'desc' },
        select: { currency: true, createdAt: true },
      }),
    ]);
    return toPortalBalanceSummary(unpaidGroups, anyInvoice);
  }

  async listLogs(query: ListLogsQuery): Promise<PaginatedResult<ClientLog>> {
    const page = query.page && query.page > 0 ? query.page : 1;
    const limit = query.limit && query.limit > 0 ? query.limit : 25;
    const where = { clientId: query.clientId };
    const [rows, total] = await Promise.all([
      prisma.clientLog.findMany({
        where,
        orderBy: { timestamp: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.clientLog.count({ where }),
    ]);
    return { data: rows.map(toClientLog), total, page, limit };
  }

  /**
   * recapture-active-client-match batch 1 — ONE query, pure Prisma (no
   * `$queryRaw`, no new index needed: `status` is already indexed). Returns
   * every active client's id/name/phone/email; the caller matches in memory
   * via `matchActiveClient` (design.md Decisión 1 — recall over query-side
   * normalization, since `Client.phone` is stored dirty/unnormalized).
   */
  async listActiveContacts(): Promise<ActiveClientContact[]> {
    const rows = await prisma.client.findMany({
      where: { status: 'active' as never },
      select: { id: true, name: true, phone: true, email: true },
    });
    return rows.map(toActiveClientContact);
  }

  /**
   * messaging-bulk (F2, Batch 6, T6.3, design §4.2) — implementa
   * `CampaignSegmentSource`. UNA query, columnas narrow (molde
   * `listActiveContacts`), sin paginar (el bulk necesita el universo completo,
   * no una página — mismo tradeoff recall-over-pagination). `buildSegmentWhere`
   * decide el escape hatch de OPT-2 (`statuses: []`, ver su doc arriba).
   */
  async listSegmentRecipients(segment: CampaignSegmentFilter): Promise<CampaignRecipientCandidate[]> {
    const rows = await prisma.client.findMany({
      where: buildSegmentWhere(segment),
      // messaging-bulk v1.1 (statusCounts) — `status` agregado al select: el
      // preview/paginado de destinatarios necesita el estado ACTUAL de cada
      // candidato para agrupar `statusCounts` + completar `status` por-item.
      select: { id: true, name: true, phone: true, balanceDue: true, whatsappOptOutAt: true, status: true },
    });
    return rows.map(toCampaignRecipientCandidate);
  }

  /**
   * portal-promos — implementa `SegmentMembershipChecker`. UNA query dirigida
   * (`count` con `id: clientId` ANDeado al WHERE del segmento) — nunca trae el
   * universo completo a memoria para responder una pregunta de un solo
   * cliente. El WHERE sale de `buildClientMatchesSegmentWhere`, que reusa
   * `buildSegmentWhere` (la MISMA función de `listSegmentRecipients`) — ver el
   * docblock del port para el porqué esto es la garantía anti-divergencia.
   */
  async clientMatchesSegment(clientId: string, segment: CampaignSegmentFilter): Promise<boolean> {
    const count = await prisma.client.count({ where: buildClientMatchesSegmentWhere(clientId, segment) });
    return count > 0;
  }

  /**
   * messaging-bulk (F2, Batch 4/6, SEND-5) — implementa `CampaignRecipientLookup`.
   * Re-check per-cliente INMEDIATAMENTE antes de cada envío (`SendCampaign`) —
   * `null` cuando el `Client` ya no resuelve (borrado).
   */
  async findRecipientCandidate(clientId: string): Promise<CampaignRecipientCandidate | null> {
    const row = await prisma.client.findUnique({
      where: { id: clientId },
      select: { id: true, name: true, phone: true, balanceDue: true, whatsappOptOutAt: true },
    });
    return row ? toCampaignRecipientCandidate(row) : null;
  }

  /**
   * manual-recipients (MAN-1..MAN-3) — implementa `ManualRecipientSource`. UNA
   * query batch `id IN (...)`, columnas narrow (molde `listSegmentRecipients`,
   * incluye `status` para `statusCounts` del preview). Devuelve SOLO los ids que
   * EXISTEN (subset); el caller (`resolveCombinedRecipients`) detecta faltantes
   * por set-diff → `ManualRecipientsNotFoundError`. `[]` para input vacío (no
   * dispara query).
   */
  async findRecipientCandidatesByIds(clientIds: string[]): Promise<CampaignRecipientCandidate[]> {
    if (clientIds.length === 0) return [];
    const rows = await prisma.client.findMany({
      where: { id: { in: clientIds } },
      select: { id: true, name: true, phone: true, balanceDue: true, whatsappOptOutAt: true, status: true },
    });
    return rows.map(toCampaignRecipientCandidate);
  }

  /**
   * messaging-bulk (F2, Batch 6, T6.4, OPT-1) — implementa `OptOutRegistry`.
   * `updateMany` con `whatsappOptOutAt: null` en el WHERE hace la idempotencia
   * primer-en-ganar ESTRUCTURAL (garantizada por el motor, no por un branch de
   * código): si el cliente ya tenía `whatsappOptOutAt` seteado, el UPDATE no
   * matchea ninguna fila y el timestamp original se preserva intacto. Sin
   * test unitario propio contra Prisma real (no hay DB local, regla CLAUDE.md
   * — mismo criterio documentado que `PrismaCampaignRepository`, Batch 7); el
   * contrato OPT-1/OPT-2 se ejercita end-to-end vía
   * `ReceiveChatwootWebhook.optout.test.ts` (Batch 6, T6.5) con un fake
   * in-memory que implementa el mismo criterio primer-en-ganar.
   */
  async registerOptOut(clientId: string): Promise<void> {
    await prisma.client.updateMany({
      where: { id: clientId, whatsappOptOutAt: null },
      data: { whatsappOptOutAt: new Date() },
    });
  }

  async updateLocation(id: string, data: UpdateClientLocationInput): Promise<Customer | null> {
    try {
      // Whitelist: ONLY update lat, lng, plusCode (Prominense-owned GPS).
      // GR fields (name, email, phone, address, city, country, status, etc.) are NEVER in this data object.
      const row = await prisma.client.update({
        where: { id },
        data: {
          lat: data.lat,
          lng: data.lng,
          plusCode: data.plusCode,
        },
      });
      return toCustomer(row, this.ttl);
    } catch (err: unknown) {
      // P2025 — record to update not found
      if ((err as { code?: string })?.code === 'P2025') return null;
      throw err;
    }
  }
}
