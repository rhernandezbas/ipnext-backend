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
  OptOutRegistry,
} from '@domain/ports/CustomerRepository';
import { Customer, CustomerStatus, Contract, ClientLog } from '@domain/entities/customer';
import { Invoice, InvoiceStatus, LineItem } from '@domain/entities/billing';
import { PaginatedResult } from '@application/dto/pagination';
import { ClientNotFoundError } from '@domain/errors';
import { prisma } from '../../database/prisma';

const DEFAULT_BALANCE_TTL_MINUTES = 60;

/**
 * Derive balanceStale: true when the client is a debtor (status=late) AND
 * either lastBalanceAt is null (never fetched) or older than the TTL.
 */
function isBalanceStale(status: string, lastBalanceAt: Date | null, ttlMinutes: number): boolean {
  if (status !== 'late') return false; // non-debtors are never stale
  if (!lastBalanceAt) return true; // never fetched
  const ageMs = Date.now() - lastBalanceAt.getTime();
  return ageMs > ttlMinutes * 60 * 1000;
}

export function toCustomer(row: any, balanceTtlMinutes = DEFAULT_BALANCE_TTL_MINUTES): Customer {
  const status = row.status as CustomerStatus;
  const isDebtor = status === 'late';

  // Map Decimal to number (same pattern as toInvoice)
  const balanceDue: number | null = (() => {
    if (!isDebtor) return 0;
    if (row.balanceDue === null || row.balanceDue === undefined) return null;
    if (typeof row.balanceDue === 'object' && 'toNumber' in row.balanceDue) {
      return (row.balanceDue as { toNumber(): number }).toNumber();
    }
    return Number(row.balanceDue);
  })();

  const lastBalanceAt = row.lastBalanceAt instanceof Date ? row.lastBalanceAt : null;

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
    balanceCurrency: isDebtor ? (row.balanceCurrency ?? null) : null,
    lastBalanceAt: lastBalanceAt ? lastBalanceAt.toISOString() : null,
    balanceStale: isBalanceStale(status, lastBalanceAt, balanceTtlMinutes),
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
  return where;
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
  implements CustomerRepository, CampaignSegmentSource, CampaignRecipientLookup, OptOutRegistry
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
