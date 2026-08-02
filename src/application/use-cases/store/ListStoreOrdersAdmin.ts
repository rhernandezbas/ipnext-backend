import type { StoreOrderRepository } from '@domain/ports/StoreOrderRepository';
import type { StoreProductRepository } from '@domain/ports/StoreProductRepository';
import type { CustomerRepository } from '@domain/ports/CustomerRepository';
import type { TicketRepository } from '@domain/ports/TicketRepository';
import type { StoreOrderAdminDto } from '@application/dto/storeOrders.dto';
import { ClientNotFoundError } from '@domain/errors';

/**
 * ListStoreOrdersAdmin — admin, `GET /api/store/orders`. "pedidos con
 * producto/cliente/ticket para el panel" (spec) — el join se arma ACÁ, N+1
 * DELIBERADO y ACOTADO por pedido (mismo criterio "pocas decenas, nunca
 * miles" que `ListPortalBenefits.buildPromoEntries`): no se agrega un método
 * batch nuevo a ningún port solo para esta pantalla.
 *
 * `productTitle`/`clientName`/`ticketNumber` caen a `null`/placeholder de
 * forma DEFENSIVA cuando el lookup no resuelve (producto borrado — no hay
 * hard-delete hoy, pero el código no debe asumirlo; cliente inexistente en
 * una carrera rarísima; ticket ya no existe tras un `SetNull`) — nunca
 * revienta el listado completo por una fila con un FK huérfano.
 */
export class ListStoreOrdersAdmin {
  constructor(
    private readonly orders: Pick<StoreOrderRepository, 'list'>,
    private readonly products: Pick<StoreProductRepository, 'findById'>,
    private readonly customers: Pick<CustomerRepository, 'findById'>,
    private readonly tickets: Pick<TicketRepository, 'getById'>,
  ) {}

  async execute(): Promise<StoreOrderAdminDto[]> {
    const all = await this.orders.list();
    const dtos: StoreOrderAdminDto[] = [];
    for (const order of all) {
      const product = await this.products.findById(order.productId);
      let clientName: string | null = null;
      try {
        const client = await this.customers.findById(order.clientId);
        clientName = client.name;
      } catch (err) {
        if (!(err instanceof ClientNotFoundError)) throw err;
      }
      const ticket = order.ticketId ? await this.tickets.getById(order.ticketId) : null;

      dtos.push({
        id: order.id,
        productId: order.productId,
        productTitle: product?.title ?? '(producto eliminado)',
        clientId: order.clientId,
        clientName,
        contractId: order.contractId,
        installments: order.installments,
        priceArsAtOrder: order.priceArsAtOrder,
        ticketId: order.ticketId,
        ticketNumber: ticket?.sequenceNumber ?? null,
        createdAt: order.createdAt,
      });
    }
    return dtos;
  }
}
