import { IClassPort, IClassNode, CreateServiceOrderInput } from '@domain/ports/IClassPort';
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
  nodes: IClassNode[] = [];
  /** Every OS created, for assertions. */
  createdOrders: CreatedOrder[] = [];
  /** When set, the next createServiceOrder returns this code instead of an auto one. */
  nextOrderCode?: string;
  /**
   * 'unavailable' → both methods throw IClassUnavailableError.
   * 'rejected'    → createServiceOrder throws IClassRejectedError (listNodes still works).
   */
  failureMode?: 'unavailable' | 'rejected';
  /** Detail used when failureMode === 'rejected'. */
  rejectionDetail = 'ICLERR_0045: codigoCliente ultrapassou o limite de caracteres';

  private seq = 0;

  async listNodes(): Promise<IClassNode[]> {
    if (this.failureMode === 'unavailable') throw new IClassUnavailableError();
    return this.nodes;
  }

  async createServiceOrder(input: CreateServiceOrderInput): Promise<{ orderCode: string }> {
    if (this.failureMode === 'unavailable') throw new IClassUnavailableError();
    if (this.failureMode === 'rejected') throw new IClassRejectedError(this.rejectionDetail);
    const orderCode = this.nextOrderCode ?? `OS-${++this.seq}`;
    this.nextOrderCode = undefined;
    this.createdOrders.push({ input, orderCode });
    return { orderCode };
  }
}
