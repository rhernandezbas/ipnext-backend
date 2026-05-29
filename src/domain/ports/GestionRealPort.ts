import { GrClient, GrClientBalance, GrContract, GrServiceOrder } from '../entities/gestionReal';

export interface FetchClientsParams {
  /** 'c' = creación, 'm' = modificación. Omit for a full unfiltered scan. */
  fechaTipo?: 'c' | 'm';
  /** Lower bound, format "DD-MM-AAAA". Required when fechaTipo is set. */
  fechaDesde?: string;
  /** Upper bound, format "DD-MM-AAAA". */
  fechaHasta?: string;
  /** Estado filter: 1=Activo, 2=Deudor, 3=Inactivo, 4=Incobrable, 6=Baja. */
  estado?: string;
  /** Page size — GR caps at 100. */
  cantidad: number;
  offset: number;
}

export interface FetchClientsResult {
  /** Total rows matching the filter (GR "resultados"), used to drive paging. */
  total: number;
  clients: GrClient[];
}

/** Params for the `ordenesdeservicio` (service orders) GR action. */
export interface GetServiceOrdersParams {
  /** State filter; default 'PEND'. */
  estado?: string;
  /** Date axis: 'c' = creación, 'm' = modificación, 'co' = cierre. Default 'c'. */
  fechaTipo?: 'c' | 'm' | 'co';
  /** Lower bound, format "DD-MM-AAAA" (now − windowMonths). */
  fechaDesde?: string;
  /** Upper bound, format "DD-MM-AAAA" (today). */
  fechaHasta?: string;
}

/**
 * Upstream port for the Gestión Real external API. The adapter owns auth,
 * transport and payload normalization; the application layer only sees this.
 */
export interface GestionRealPort {
  fetchClients(params: FetchClientsParams): Promise<FetchClientsResult>;
  fetchContractsByClient(grClienteId: string): Promise<GrContract[]>;
  /** Fetch the balance/debt for a single client via the `cliente` action. */
  fetchClientBalance(grClienteId: string): Promise<GrClientBalance>;
  /** Fetch service orders via the `ordenesdeservicio` action, normalized to a flat array. */
  getServiceOrders(params: GetServiceOrdersParams): Promise<GrServiceOrder[]>;
}
