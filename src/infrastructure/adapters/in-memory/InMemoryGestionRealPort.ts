import {
  GestionRealPort,
  FetchClientsParams,
  FetchClientsResult,
  FetchClientReceiptsParams,
  FetchClientReceiptsResult,
  FetchContractsDeltaParams,
  FetchContractsDeltaResult,
  FetchReceiptsParams,
  FetchReceiptsResult,
  GetServiceOrdersParams,
} from '@domain/ports/GestionRealPort';
import {
  GrClient,
  GrClientBalance,
  GrContract,
  GrReceipt,
  GrServiceOrder,
} from '@domain/entities/gestionReal';
import { isRealAnnulment } from '@application/use-cases/finance/financeDates';

/**
 * Test double for the GR upstream. Holds an in-memory client/contract dataset
 * and applies the same paging + delta-by-date semantics as the real API so the
 * sync use cases can be exercised without network.
 */
export class InMemoryGestionRealPort implements GestionRealPort {
  clients: GrClient[] = [];
  contractsByClient: Record<string, GrContract[]> = {};
  /** Preset balances by grClienteId for test doubles. */
  balancesByClient: Record<string, GrClientBalance> = {};
  /** Records every fetchClients call for assertions. */
  calls: FetchClientsParams[] = [];
  /** Records every fetchClientBalance call for assertions. */
  balanceCalls: string[] = [];
  /** When set, fetchClientBalance throws this error. */
  balanceError?: Error;
  /** Settable fixture batch returned by getServiceOrders. */
  serviceOrders: GrServiceOrder[] = [];
  /** Records every getServiceOrders call for assertions. */
  serviceOrderCalls: GetServiceOrdersParams[] = [];
  /** Multi-client flat contract list for fetchContractsModifiedSince test doubles. */
  contractsModified: GrContract[] = [];
  /** Records every fetchContractsModifiedSince call for assertions. */
  contractsDeltaCalls: FetchContractsDeltaParams[] = [];
  /** finance-growth Fase 1 — fixture receipts, filtered by `fechaRecibo` day-window + paginated. */
  receipts: GrReceipt[] = [];
  /** Records every fetchReceipts call for assertions. */
  receiptsCalls: FetchReceiptsParams[] = [];
  /** ai-assistant-cobranzas (D9) — records every per-client `fetchClientReceipts` call. */
  clientReceiptsCalls: FetchClientReceiptsParams[] = [];
  /** When set, `fetchClientReceipts` throws it — el carril `recibos_no_disponibles` (D9). */
  clientReceiptsError?: Error;

  async fetchClients(params: FetchClientsParams): Promise<FetchClientsResult> {
    this.calls.push(params);
    let matched = this.clients;
    if (params.fechaTipo === 'm' && params.fechaDesde) {
      const from = parseGrDate(params.fechaDesde);
      matched = matched.filter(c => {
        const mod = c.ultimaModificacion ? parseGrDateTime(c.ultimaModificacion) : null;
        return mod !== null && mod >= from;
      });
    }
    // Mirrors the real GR semantics verified live: fecha_tipo=c filters by
    // fecha_creacion, and rows without a parseable creation date never match.
    if (params.fechaTipo === 'c' && params.fechaDesde) {
      const from = parseGrDate(params.fechaDesde);
      matched = matched.filter(c => {
        const created = c.fechaCreacion ? parseGrDateTime(c.fechaCreacion) : null;
        return created !== null && created >= from;
      });
    }
    if (params.estado) {
      matched = matched.filter(c => c.statusCode === params.estado);
    }
    const page = matched.slice(params.offset, params.offset + params.cantidad);
    return { total: matched.length, clients: page };
  }

  async fetchContractsByClient(grClienteId: string): Promise<GrContract[]> {
    return this.contractsByClient[grClienteId] ?? [];
  }

  async fetchClientBalance(grClienteId: string): Promise<GrClientBalance> {
    this.balanceCalls.push(grClienteId);
    if (this.balanceError) throw this.balanceError;
    return this.balancesByClient[grClienteId] ?? {
      grClienteId,
      amount: 0,
      currency: null,
      invoicesQty: 0,
      paymentUrls: {},
      invoices: [],
      raw: {},
    };
  }

  async getServiceOrders(params: GetServiceOrdersParams): Promise<GrServiceOrder[]> {
    this.serviceOrderCalls.push(params);
    return this.serviceOrders;
  }

  async fetchContractsModifiedSince(p: FetchContractsDeltaParams): Promise<FetchContractsDeltaResult> {
    this.contractsDeltaCalls.push(p);
    const from = parseGrDate(p.fechaDesde);
    // fechaHasta is a date string (no time). GR includes the entire day, so we
    // treat it as exclusive next-day midnight: any timestamp on fechaHasta day
    // satisfies ts < nextDay (i.e. ts <= end-of-day of fechaHasta).
    const toExclusive = parseGrDate(p.fechaHasta) + 24 * 60 * 60 * 1000;

    // Mirrors the real GR server-side filtering verified live:
    //   fecha_tipo=m → filter by modificado (rows without modificado are excluded)
    //   fecha_tipo=c → filter by fechaCreacion (rows without fechaCreacion are excluded)
    // Both apply a [fechaDesde, fechaHasta] window (inclusive on both ends, day-granular).
    const matched = this.contractsModified.filter(c => {
      if (p.fechaTipo === 'c') {
        const created = c.fechaCreacion ? parseGrDateTime(c.fechaCreacion) : null;
        return created !== null && created >= from && created < toExclusive;
      }
      // Default: fecha_tipo=m (or undefined → backward compat with tests that omit fechaTipo)
      const mod = c.modificado ? parseGrDateTime(c.modificado) : null;
      return mod !== null && mod >= from && mod < toExclusive;
    });
    const page = matched.slice(p.offset, p.offset + p.cantidad);
    return { total: matched.length, contracts: page };
  }

  /**
   * finance-growth Fase 1 — mirrors the real `recibos` server-side filtering:
   * a day-granular `[fechaDesde, fechaHasta]` window over `fechaRecibo`, paged
   * by offset. Real annulments are ALREADY excluded upstream (parser-level in
   * `GestionRealClient`), so this fixture is not expected to hold voided rows.
   */
  async fetchReceipts(p: FetchReceiptsParams): Promise<FetchReceiptsResult> {
    this.receiptsCalls.push(p);
    const from = parseGrDate(p.fechaDesde);
    const toExclusive = parseGrDate(p.fechaHasta) + 24 * 60 * 60 * 1000;
    const matched = this.receipts.filter((r) => {
      if (!r.fechaRecibo) return false;
      const ts = parseGrDateTime(r.fechaRecibo);
      return ts >= from && ts < toExclusive;
    });
    const page = matched.slice(p.offset, p.offset + p.cantidad);
    return { total: matched.length, receipts: page };
  }

  /**
   * ai-assistant-cobranzas (4.7 / D9) — gemelo de la llamada per-cliente EN VIVO.
   *
   * Replica campo a campo la semántica del adapter real, incluidos los DOS filtros que en el
   * real no son opcionales: el ancla por `cliente_id` (sin ella GR devuelve los recibos de
   * todos — fuga de PII por omisión) y la exclusión de los ANULADOS. Un twin más permisivo
   * dejaría verde un resolver que en producción cuenta un recibo dado de baja como un pago.
   */
  async fetchClientReceipts(p: FetchClientReceiptsParams): Promise<FetchClientReceiptsResult> {
    this.clientReceiptsCalls.push(p);
    if (this.clientReceiptsError) throw this.clientReceiptsError;

    const from = parseGrDate(p.fechaDesde);
    const toExclusive = parseGrDate(p.fechaHasta) + 24 * 60 * 60 * 1000;

    const matched = this.receipts.filter((r) => {
      if (r.clienteGrId !== p.grClienteId) return false;
      if (!r.fechaRecibo) return false;
      const ts = parseGrDateTime(r.fechaRecibo);
      return ts >= from && ts < toExclusive;
    });

    return {
      // `total` = lo que GR dice haber encontrado, ANTES del filtro de anulados (igual que
      // el `resultados` del real).
      total: matched.length,
      receipts: matched.filter((r) => !isRealAnnulment(r.fechaAnulacion, r.grReceiptId)),
    };
  }
}

/** "DD-MM-AAAA" → epoch ms at local midnight. */
function parseGrDate(s: string): number {
  const [d, m, y] = s.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}

/** "DD-MM-YYYY HH:MM:SS" → epoch ms. */
function parseGrDateTime(s: string): number {
  const [date, time = '00:00:00'] = s.split(' ');
  const [d, m, y] = date.split('-').map(Number);
  const [hh, mm, ss] = time.split(':').map(Number);
  return new Date(y, m - 1, d, hh || 0, mm || 0, ss || 0).getTime();
}
