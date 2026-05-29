import {
  GestionRealPort,
  FetchClientsParams,
  FetchClientsResult,
  GetServiceOrdersParams,
} from '@domain/ports/GestionRealPort';
import {
  GrClient,
  GrClientBalance,
  GrContract,
  GrServiceOrder,
} from '@domain/entities/gestionReal';

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
      raw: {},
    };
  }

  async getServiceOrders(params: GetServiceOrdersParams): Promise<GrServiceOrder[]> {
    this.serviceOrderCalls.push(params);
    return this.serviceOrders;
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
