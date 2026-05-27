import { IClassPort, IClassNode, CreateServiceOrderInput } from '@domain/ports/IClassPort';
import { IClassUnavailableError } from '@domain/errors/iclass';

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
  /** When 'unavailable', both methods throw IClassUnavailableError. */
  failureMode?: 'unavailable';

  private seq = 0;

  async listNodes(): Promise<IClassNode[]> {
    if (this.failureMode === 'unavailable') throw new IClassUnavailableError();
    return this.nodes;
  }

  async createServiceOrder(input: CreateServiceOrderInput): Promise<{ orderCode: string }> {
    if (this.failureMode === 'unavailable') throw new IClassUnavailableError();
    const orderCode = this.nextOrderCode ?? `OS-${++this.seq}`;
    this.nextOrderCode = undefined;
    this.createdOrders.push({ input, orderCode });
    return { orderCode };
  }
}
