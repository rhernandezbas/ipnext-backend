import {
  IClassPort,
  IClassNodeDescriptor,
  IClassSoTypeDescriptor,
  IClassResultCodeDescriptor,
  CreateServiceOrderInput,
  ListServiceOrdersParams,
  ServiceOrderSnapshot,
  CloseServiceOrderInput,
  IClassTeamDescriptor,
  UpdateServiceOrderInput,
} from '@domain/ports/IClassPort';
import {
  ClosedServiceOrderSummary,
  SoStatusHistoryEntry,
  SoChecklist,
  SoMaterial,
  SoEquipmentEvent,
} from '@domain/entities/iclass-closed-order';
import { IClassUnavailableError, IClassRejectedError } from '@domain/errors/iclass';

interface CreatedOrder {
  input: CreateServiceOrderInput;
  orderCode: string;
}

/**
 * Test double for the IClass upstream. Holds an in-memory node list, records
 * every created OS for assertions, and can simulate an unavailable upstream.
 */
export class InMemoryIClassClient implements IClassPort {
  /** Nodes returned by listNodes(). */
  nodes: IClassNodeDescriptor[] = [];
  /** SO type descriptors returned by listServiceOrderTypes(). Settable for tests. */
  serviceOrderTypes: IClassSoTypeDescriptor[] = [];
  /** Every OS created, for assertions. */
  createdOrders: CreatedOrder[] = [];
  /** When set, the next createServiceOrder returns this code instead of an auto one. */
  nextOrderCode?: string;
  /**
   * 'unavailable' → all methods throw IClassUnavailableError.
   * 'rejected'    → createServiceOrder throws IClassRejectedError (listNodes still works).
   */
  failureMode?: 'unavailable' | 'rejected';
  /** Detail used when failureMode === 'rejected'. */
  rejectionDetail = 'ICLERR_0045: codigoCliente ultrapassou o limite de caracteres';

  private seq = 0;

  async listNodes(): Promise<IClassNodeDescriptor[]> {
    if (this.failureMode === 'unavailable') throw new IClassUnavailableError();
    return this.nodes;
  }

  async listServiceOrderTypes(): Promise<IClassSoTypeDescriptor[]> {
    if (this.failureMode === 'unavailable') throw new IClassUnavailableError();
    return [...this.serviceOrderTypes];
  }

  async createServiceOrder(input: CreateServiceOrderInput): Promise<{ orderCode: string }> {
    if (this.failureMode === 'unavailable') throw new IClassUnavailableError();
    if (this.failureMode === 'rejected') throw new IClassRejectedError(this.rejectionDetail);
    const orderCode = this.nextOrderCode ?? `OS-${++this.seq}`;
    this.nextOrderCode = undefined;
    this.createdOrders.push({ input, orderCode });
    return { orderCode };
  }

  // ── Closure loop (read path) — settable test data ─────────────────────────

  /** Returned by listServiceOrders (filtered by serviceOrderCode when provided). */
  serviceOrders: ClosedServiceOrderSummary[] = [];
  historyByOrder: Record<string, SoStatusHistoryEntry[]> = {};
  checklistsByOrder: Record<string, SoChecklist[]> = {};
  materialsByOrder: Record<string, SoMaterial[]> = {};
  equipmentEventsByOrder: Record<string, SoEquipmentEvent[]> = {};
  resultCodes: IClassResultCodeDescriptor[] = [];
  /** Records each listServiceOrders call for assertions (e.g. backfill by code). */
  listCalls: ListServiceOrdersParams[] = [];

  async listServiceOrders(params: ListServiceOrdersParams): Promise<ClosedServiceOrderSummary[]> {
    if (this.failureMode === 'unavailable') throw new IClassUnavailableError();
    this.listCalls.push(params);
    const all = this.serviceOrders.map(o => ({ ...o }));
    return params.serviceOrderCode
      ? all.filter(o => o.iclassCodigo === params.serviceOrderCode)
      : all;
  }

  async getServiceOrderHistory(iclassId: string): Promise<SoStatusHistoryEntry[]> {
    return (this.historyByOrder[iclassId] ?? []).map(e => ({ ...e }));
  }

  async getServiceOrderChecklists(iclassId: string): Promise<SoChecklist[]> {
    return (this.checklistsByOrder[iclassId] ?? []).map(c => ({ ...c, answers: c.answers.map(a => ({ ...a })) }));
  }

  async getServiceOrderMaterials(iclassId: string): Promise<SoMaterial[]> {
    return (this.materialsByOrder[iclassId] ?? []).map(m => ({ ...m }));
  }

  async getServiceOrderEquipmentEvents(iclassId: string): Promise<SoEquipmentEvent[]> {
    return (this.equipmentEventsByOrder[iclassId] ?? []).map(e => ({ ...e }));
  }

  async listResultCodes(): Promise<IClassResultCodeDescriptor[]> {
    if (this.failureMode === 'unavailable') throw new IClassUnavailableError();
    return this.resultCodes.map(r => ({ ...r }));
  }

  // ── Ola A: getServiceOrder + closeServiceOrder ─────────────────────────────

  /**
   * Scripted snapshots keyed by serviceOrderCode.
   * null = simulate 404 (IClass doesn't know this OS).
   * undefined key = use failureMode for getServiceOrder.
   */
  private snapshotsByCode: Map<string, ServiceOrderSnapshot | null> = new Map();

  /** Mode for closeServiceOrder: undefined = success, 'rejected' = IClassRejectedError, 'unavailable' = IClassUnavailableError */
  private closeMode?: 'rejected' | 'unavailable';

  /** Recorded calls to closeServiceOrder for assertions. */
  private closeCalls: CloseServiceOrderInput[] = [];

  /** Recorded calls to getServiceOrder for assertions. */
  private getServiceOrderCalls: string[] = [];

  /** Recorded calls to updateServiceOrder for assertions. */
  private updateServiceOrderCalls: UpdateServiceOrderInput[] = [];

  /** Configure snapshot returned by getServiceOrder for a given orderCode. */
  setServiceOrderSnapshot(orderCode: string, snapshot: ServiceOrderSnapshot | null): void {
    this.snapshotsByCode.set(orderCode, snapshot);
  }

  /** Configure how closeServiceOrder behaves. */
  setCloseMode(mode: 'rejected' | 'unavailable' | undefined): void {
    this.closeMode = mode;
  }

  getCloseCalls(): CloseServiceOrderInput[] {
    return [...this.closeCalls];
  }

  getGetServiceOrderCalls(): string[] {
    return [...this.getServiceOrderCalls];
  }

  getUpdateServiceOrderCalls(): UpdateServiceOrderInput[] {
    return [...this.updateServiceOrderCalls];
  }

  async getServiceOrder(iclassId: string): Promise<ServiceOrderSnapshot | null> {
    if (this.failureMode === 'unavailable') throw new IClassUnavailableError();
    this.getServiceOrderCalls.push(iclassId);
    if (this.snapshotsByCode.has(iclassId)) {
      const snap = this.snapshotsByCode.get(iclassId)!;
      return snap ? { ...snap } : null;
    }
    return null;
  }

  async closeServiceOrder(input: CloseServiceOrderInput): Promise<void> {
    if (this.failureMode === 'unavailable' || this.closeMode === 'unavailable') throw new IClassUnavailableError();
    if (this.closeMode === 'rejected') throw new IClassRejectedError('ICLERR_CLOSE: motivo rechazo de prueba');
    this.closeCalls.push({ ...input });
  }

  // ── Ola B: listTeams + updateServiceOrder ─────────────────────────────────

  /** Teams returned by listTeams(). */
  teams: IClassTeamDescriptor[] = [];

  /** Mode for updateServiceOrder. */
  private updateMode?: 'rejected' | 'unavailable';

  /** Mode for listTeams — isolated so we can test the use case without affecting other methods. */
  private listTeamsMode?: 'unavailable';

  setUpdateMode(mode: 'rejected' | 'unavailable' | undefined): void {
    this.updateMode = mode;
  }

  setListTeamsMode(mode: 'unavailable' | undefined): void {
    this.listTeamsMode = mode;
  }

  async listTeams(): Promise<IClassTeamDescriptor[]> {
    if (this.failureMode === 'unavailable' || this.listTeamsMode === 'unavailable') throw new IClassUnavailableError();
    return this.teams.map(t => ({ ...t }));
  }

  async updateServiceOrder(input: UpdateServiceOrderInput): Promise<void> {
    if (this.failureMode === 'unavailable' || this.updateMode === 'unavailable') throw new IClassUnavailableError();
    if (this.updateMode === 'rejected') throw new IClassRejectedError('ICLERR_UPDATE: rechazo de prueba');
    this.updateServiceOrderCalls.push({
      serviceOrderCode: input.serviceOrderCode,
      requiredTeam: input.requiredTeam,
      scheduleStart: input.scheduleStart,
      scheduleEnd: input.scheduleEnd,
    });
  }
}
