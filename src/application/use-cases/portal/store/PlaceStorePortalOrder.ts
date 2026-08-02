import type { StoreProductRepository } from '@domain/ports/StoreProductRepository';
import type { StoreOrderRepository } from '@domain/ports/StoreOrderRepository';
import type { TicketRepository } from '@domain/ports/TicketRepository';
import type { TicketCommentRepository } from '@domain/ports/TicketCommentRepository';
import type { TicketAreaCatalogRepository } from '@domain/ports/TicketAreaCatalogRepository';
import type { CustomerRepository } from '@domain/ports/CustomerRepository';
import type { TicketComment } from '@domain/entities/ticketComment';
import { randomUUID } from 'crypto';
import {
  PORTAL_TICKET_SUBJECT_MAX_LEN,
  DEFAULT_PORTAL_TICKET_AREA_NAME,
} from '@application/use-cases/portal/CreatePortalTicket';
import { resolvePortalTicketContract } from '@application/use-cases/portal/resolvePortalTicketContract';
import { StoreOrderInstallmentsInvalidError } from '@domain/errors/storeProduct.errors';
import { isStoreProductVisible } from './storeProductEligibility';

export interface PlaceStorePortalOrderInput {
  contractId?: string | null;
  installments: number;
}

export interface PlaceStorePortalOrderResult {
  ticketNumber: number;
}

/**
 * PlaceStorePortalOrder — store-backend, `POST
 * /api/portal/store/products/:id/order`. "Lo quiero" del cliente: valida el
 * producto y las cuotas, resuelve el contrato con la MISMA regla que
 * `CreatePortalTicket`/`InterestInPortalPromo` (`resolvePortalTicketContract`,
 * reusada 1:1 — tercera vez que la comparten, ver su docblock), abre un
 * `Ticket` con el área del producto (o la default del portal) y un asunto
 * "Pedido: {title}", agrega el PRIMER comentario público del cliente con el
 * resumen legal (producto, precio SNAPSHOT, cuotas, mención del derecho de
 * arrepentimiento de 10 días), y persiste el `StoreOrder`.
 *
 * SNAPSHOT del precio: `priceArsAtOrder` = `product.priceArs` leído EN ESTE
 * MOMENTO, nunca recalculado después — si el operador cambia el precio del
 * catálogo más tarde, los pedidos YA hechos conservan lo que el cliente vio
 * y aceptó. Este es el invariante central del change (ver el revert-probe en
 * el reporte).
 *
 * Devuelve `null` cuando el producto no existe o no está visible
 * (borrador/archivado) — 404 en la ruta, mismo criterio "no distinguir cuál"
 * que el resto del portal. Puede lanzar `StoreOrderInstallmentsInvalidError`
 * (400) o `PortalContractRequiredError`/`PortalContractNotFoundError`
 * (400/404, mapeados igual que en `POST /promos/:id/interest`).
 */
export class PlaceStorePortalOrder {
  constructor(
    private readonly products: Pick<StoreProductRepository, 'findById'>,
    private readonly orders: Pick<StoreOrderRepository, 'create'>,
    private readonly tickets: Pick<TicketRepository, 'create'>,
    private readonly comments: Pick<TicketCommentRepository, 'create'>,
    private readonly areas: Pick<TicketAreaCatalogRepository, 'getById' | 'getByName' | 'list'>,
    private readonly customers: Pick<CustomerRepository, 'listContracts'>,
    private readonly defaultAreaName: string = DEFAULT_PORTAL_TICKET_AREA_NAME,
  ) {}

  async execute(
    clientId: string,
    accountId: string,
    productId: string,
    input: PlaceStorePortalOrderInput,
  ): Promise<PlaceStorePortalOrderResult | null> {
    const product = await this.products.findById(productId);
    if (!product || !isStoreProductVisible(product)) return null;

    if (!Number.isInteger(input.installments) || input.installments < 1 || input.installments > product.maxInstallments) {
      throw new StoreOrderInstallmentsInvalidError(product.maxInstallments);
    }

    const requestedContractId = input.contractId?.trim() || null;
    const contract = await resolvePortalTicketContract(this.customers, clientId, requestedContractId);

    const areaId = await this.resolveAreaId(product.ticketAreaId);
    const subject = `Pedido: ${product.title}`.slice(0, PORTAL_TICKET_SUBJECT_MAX_LEN);
    const description = `El cliente pidió "${product.title}" desde la tienda de la app.`;

    const ticket = await this.tickets.create({
      subject,
      description,
      customerId: clientId,
      areaId,
      contractId: contract?.id ?? null,
    });

    const comment: TicketComment = {
      id: randomUUID(),
      ticketId: ticket.id,
      authorId: accountId,
      authorKind: 'client',
      visibility: 'public',
      authorName: 'Cliente',
      body: buildOrderSummaryComment(product.title, product.priceArs, input.installments),
      createdAt: new Date().toISOString(),
      attachments: [],
    };
    await this.comments.create(comment);

    await this.orders.create({
      productId: product.id,
      clientId,
      contractId: contract?.id ?? null,
      installments: input.installments,
      // Snapshot deliberado — ver docblock de la clase.
      priceArsAtOrder: product.priceArs,
      ticketId: ticket.id,
    });

    return { ticketNumber: ticket.sequenceNumber };
  }

  private async resolveAreaId(productAreaId: string | null): Promise<string | null> {
    if (productAreaId) {
      const area = await this.areas.getById(productAreaId);
      if (area) return area.id;
    }
    const configured = await this.areas.getByName(this.defaultAreaName);
    if (configured) return configured.id;
    const all = await this.areas.list();
    return all[0]?.id ?? null;
  }
}

/** Resumen legal AR — precio final, cuotas y el derecho de arrepentimiento de
 * 10 días quedan mencionados en el PRIMER mensaje del hilo, texto plano
 * (v1, sin plantillas). */
function buildOrderSummaryComment(title: string, priceArs: number, installments: number): string {
  const priceLabel = priceArs.toLocaleString('es-AR', { style: 'currency', currency: 'ARS' });
  const installmentsLabel = installments > 1 ? `en ${installments} cuotas sin interés` : 'en 1 pago';
  return (
    `Pedido: ${title}.\n` +
    `Precio: ${priceLabel} (${installmentsLabel}, a cargo en la factura).\n` +
    `Recordatorio: tenés derecho de arrepentimiento de 10 días desde la compra.`
  );
}
