/**
 * ContractServiceEventRepository — domain port for the non-TV contract service history log (#110).
 *
 * Records every activated / deactivated / reactivated event for a NON-TV contract service.
 * The log is append-only: record() inserts a new row, no updates or deletes.
 *
 * Lives in the domain layer. Zero imports from @infrastructure/* or Prisma.
 */

export type ServiceEventType = 'activated' | 'deactivated' | 'reactivated' | 'reduced' | 'blocked' | 'restored' | 'modified';

export interface RecordContractServiceEventInput {
  contractId: string;
  serviceCatalogId: string;
  eventType: ServiceEventType;
  actorId?: string | null;
  actorName?: string;
  notes?: string | null;
  // internet-history-plan-direction — snapshot de los CÓDIGOS de plan del cambio (solo 'modified').
  // La DIRECCIÓN (upgrade/downgrade) NO se persiste: se deriva al leer contra el catálogo de planes.
  oldPlan?: string | null;
  newPlan?: string | null;
  // pppoe-change-audit — discrimina el tipo de cambio de un evento 'modified' cuando NO es un cambio
  // de plan: 'ip' | 'password' | 'status'. null = cambio de plan (usa oldPlan/newPlan) o evento no-modified.
  changeKind?: string | null;
  // pppoe-change-audit — valor viejo/nuevo del campo cambiado (ip/status). SEGURIDAD: en 'password'
  // ambos van null — la clave NUNCA se persiste.
  oldValue?: string | null;
  newValue?: string | null;
  // #127 - optional cancellation reason.
  reason?: string | null;
}

export interface ContractServiceEvent {
  id: string;
  contractId: string;
  serviceCatalogId: string;
  eventType: ServiceEventType;
  actorId: string | null;
  actorName: string;
  notes: string | null;
  // internet-history-plan-direction — códigos de plan viejo/nuevo; null salvo en cambios de plan.
  oldPlan: string | null;
  newPlan: string | null;
  // pppoe-change-audit — tipo de cambio ('ip' | 'password' | 'status') y valor viejo/nuevo. null en
  // eventos que no son cambios de campo (plan / activated / etc.). password: oldValue/newValue = null.
  changeKind: string | null;
  oldValue: string | null;
  newValue: string | null;
  // #127 - optional cancellation reason; null for legacy events.
  reason: string | null;
  createdAt: string; // ISO string
}

/**
 * internet-history — event row enriched with the contract's client (resolved via JOIN
 * contract_service_events → Contract → Client). Used by the GLOBAL history list so the
 * use case never re-queries per row. customerName is best-effort (may be null).
 */
export interface ContractServiceEventWithClient extends ContractServiceEvent {
  clientId: string | null;
  customerName: string | null;
}

/**
 * internet-history — cross-contract filters for the GLOBAL events list. `serviceCatalogId`
 * narrows to a single service (e.g. the INTERNET catalog id), which is how the history page
 * isolates internet events from TV/other-service events.
 */
export interface ListContractServiceEventsFilter {
  serviceCatalogId?: string;
  contractId?: string;
  /**
   * internet-history-plan-direction — narrows to a single event TÓPICO (eventType), e.g. 'modified'.
   * Push-down filter (SQL `eventType = ?`) so the tópico select of the history page filters at the DB.
   */
  eventType?: string;
  /**
   * internet-history — narrows to events whose contract is in this set (SQL `contractId IN (...)`).
   * Push-down filter so the createdBy enrichment of a page is bounded by the page's contracts,
   * NOT by the full historical event count. An empty array yields no rows.
   */
  contractIds?: string[];
  clientId?: string;
  actorId?: string;
  from?: Date;
  to?: Date;
}

/**
 * internet-history — operador (actorId + actorName) que produjo eventos de servicio. Es el
 * item del <select> de operadores del historial. Shape mínimo, wire-friendly.
 */
export interface ContractServiceEventOperator {
  actorId: string;
  actorName: string;
}

export interface ContractServiceEventRepository {
  /** Append a new event. Best-effort callers wrap in try/catch. */
  record(input: RecordContractServiceEventInput): Promise<ContractServiceEvent>;
  /** List events for a contract, newest-first (callers re-sort as needed). */
  listByContract(contractId: string): Promise<ContractServiceEvent[]>;
  /**
   * internet-history — GLOBAL list with optional cross-contract filters, newest-first,
   * enriched with the contract's client (clientId + customerName via JOIN). Mirrors the
   * TvActivationEventRepository.list() shape so the internet history page mirrors TV.
   */
  list(filters: ListContractServiceEventsFilter): Promise<ContractServiceEventWithClient[]>;
  /**
   * internet-history — operadores DISTINCT (actorId + actorName) que produjeron eventos de un
   * servicio (ej. INTERNET). Excluye eventos con actorId null. Orden por actorName asc. Habilita
   * el <select> de operadores con gate pppoe.read (sin admin/rbac).
   */
  listDistinctOperators(filters: { serviceCatalogId?: string }): Promise<ContractServiceEventOperator[]>;
}
