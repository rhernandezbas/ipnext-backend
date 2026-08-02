/**
 * store-backend — PlaceStorePortalOrder, test de UNIDAD (use case + repos
 * in-memory, sin HTTP) enfocado en el invariante central del change: el
 * `StoreOrder.priceArsAtOrder` es un SNAPSHOT tomado UNA sola vez (la
 * `product` ya resuelta al principio de `execute`), nunca un re-fetch.
 *
 * `caseA` (arriba, "no retroactivo") ya vive en `portalStore.routes.test.ts`
 * caso 5 — cambia el precio DESPUÉS de que el pedido HTTP ya respondió y
 * confirma que el pedido viejo no se mueve. Ese test por sí solo NO alcanza
 * como revert-probe: si el código hiciera un SEGUNDO `findById` justo antes
 * de `orders.create` (en vez de reusar la `product` ya leída), ese segundo
 * test seguiría en VERDE — el cambio de precio del test llega DESPUÉS de que
 * el request entero ya terminó, no hay ventana de carrera que lo exponga.
 *
 * Este archivo SÍ construye esa ventana: un `StoreProductRepository` decorado
 * cuyo `findById` simula una escritura CONCURRENTE de otro admin que sube el
 * precio justo DESPUÉS de la primera lectura (la que hace `execute()` al
 * principio, para validar el producto) — exactamente el punto donde un
 * eventual segundo `findById` (el bug que probamos) vería el precio YA
 * cambiado.
 */
import { PlaceStorePortalOrder } from '@application/use-cases/portal/store/PlaceStorePortalOrder';
import { InMemoryStoreProductRepository } from '@infrastructure/adapters/in-memory/InMemoryStoreProductRepository';
import { InMemoryStoreOrderRepository } from '@infrastructure/adapters/in-memory/InMemoryStoreOrderRepository';
import { InMemoryTicketRepository } from '@infrastructure/adapters/in-memory/InMemoryTicketRepository';
import { InMemoryTicketCommentRepository } from '@infrastructure/adapters/in-memory/InMemoryTicketCommentRepository';
import { InMemoryTicketAreaCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryTicketAreaCatalogRepository';
import type { StoreProductRepository } from '@domain/ports/StoreProductRepository';
import type { StoreProduct } from '@domain/entities/storeProduct';
import type { CustomerRepository } from '@domain/ports/CustomerRepository';

/**
 * Decorador de `findById`: la PRIMERA llamada devuelve el producto tal cual
 * está (precio "viejo", lo que el cliente vio y aceptó) y DISPARA una
 * escritura concurrente que lo sube a `bumpedPriceArs` — simula OTRO admin
 * cambiando el precio del catálogo en el instante exacto después de que
 * `execute()` lee el producto por primera vez. Cualquier llamada SIGUIENTE a
 * `findById` (la que haría el bug: un segundo re-fetch antes de persistir el
 * pedido) ve el precio YA BUMPEADO.
 */
function withConcurrentPriceBumpAfterFirstRead(
  inner: StoreProductRepository,
  bumpedPriceArs: number,
): StoreProductRepository {
  let calls = 0;
  return {
    ...inner,
    findById: async (id: string): Promise<StoreProduct | null> => {
      const result = await inner.findById(id);
      calls += 1;
      if (calls === 1 && result) {
        await inner.update(id, { priceArs: bumpedPriceArs });
      }
      return result;
    },
  };
}

function fakeCustomersNoContracts(): Pick<CustomerRepository, 'listContracts'> {
  return { listContracts: async () => [] };
}

describe('PlaceStorePortalOrder — invariante SNAPSHOT del precio (revert-probe)', () => {
  it('persiste el precio leído en la PRIMERA lectura (lo que el cliente aceptó), no un precio re-leído más tarde', async () => {
    const productsInner = new InMemoryStoreProductRepository();
    const orders = new InMemoryStoreOrderRepository();
    const tickets = new InMemoryTicketRepository();
    const comments = new InMemoryTicketCommentRepository();
    const areas = new InMemoryTicketAreaCatalogRepository();
    tickets.seedAreas(areas);

    const product = await productsInner.create({
      title: 'Router WiFi 6',
      summary: 'x',
      description: 'x',
      priceArs: 45000,
      maxInstallments: 1,
      warrantyText: 'x',
      active: true,
    });

    const products = withConcurrentPriceBumpAfterFirstRead(productsInner, 90000);
    const useCase = new PlaceStorePortalOrder(products, orders, tickets, comments, areas, fakeCustomersNoContracts());

    const result = await useCase.execute('client-a', 'account-a', product.id, { installments: 1 });
    expect(result).not.toBeNull();

    const allOrders = await orders.list();
    expect(allOrders).toHaveLength(1);
    // EL PUNTO: 45000 (snapshot de la primera lectura), NUNCA 90000 (el bump concurrente).
    expect(allOrders[0]!.priceArsAtOrder).toBe(45000);
  });
});
