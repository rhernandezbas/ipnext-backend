/**
 * store-backend — route-level coverage de los casos TDD sobre la app Express
 * real + repos in-memory (molde `portalPromos.routes.test.ts` — sin
 * Prisma/DB real).
 */
import express from 'express';
import request from 'supertest';

import { createPortalRouter } from '@infrastructure/http/routes/portal.routes';
import { createPortalAuthMiddleware } from '@infrastructure/http/middleware/portalAuthMiddleware';
import { createPortalKillSwitchMiddleware } from '@infrastructure/http/middleware/portalKillSwitchMiddleware';
import { createPortalGeneralRateLimiter, createPortalStoreOrderRateLimiter } from '@infrastructure/http/middleware/rateLimiters';

import { InMemoryPortalAccountRepository } from '@infrastructure/adapters/in-memory/InMemoryPortalAccountRepository';
import { InMemoryPortalSessionRepository } from '@infrastructure/adapters/in-memory/InMemoryPortalSessionRepository';
import { InMemoryPasswordHasher } from '@infrastructure/adapters/in-memory/InMemoryPasswordHasher';
import { InMemorySettingsRepository } from '@infrastructure/adapters/in-memory/InMemorySettingsRepository';
import { JwtPortalTokenService } from '@infrastructure/adapters/jwt/JwtPortalTokenService';
import { InMemoryTicketRepository } from '@infrastructure/adapters/in-memory/InMemoryTicketRepository';
import { InMemoryTicketCommentRepository } from '@infrastructure/adapters/in-memory/InMemoryTicketCommentRepository';
import { InMemoryTicketAreaCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryTicketAreaCatalogRepository';
import { InMemoryStoreProductRepository } from '@infrastructure/adapters/in-memory/InMemoryStoreProductRepository';
import { InMemoryStoreOrderRepository } from '@infrastructure/adapters/in-memory/InMemoryStoreOrderRepository';
import { InMemoryFileStorage } from '@infrastructure/adapters/in-memory/InMemoryFileStorage';

import { PortalLogin } from '@application/use-cases/portal/PortalLogin';
import { ListPortalStoreProducts } from '@application/use-cases/portal/store/ListPortalStoreProducts';
import { GetPortalStoreProduct } from '@application/use-cases/portal/store/GetPortalStoreProduct';
import { GetPortalStoreProductImage } from '@application/use-cases/portal/store/GetPortalStoreProductImage';
import { PlaceStorePortalOrder } from '@application/use-cases/portal/store/PlaceStorePortalOrder';
import { computeInstallmentArs } from '@application/dto/portal/storeProduct.dto';

import type { CustomerRepository } from '@domain/ports/CustomerRepository';
import type { Contract } from '@domain/entities/customer';
import type { StoreProduct } from '@domain/entities/storeProduct';
import type { CreateStoreProductData } from '@domain/ports/StoreProductRepository';

const TEST_SECRET = 'test-jwt-secret-32chars-minimum!';

/** Fake narrow — mismo criterio que `portalPromos.routes.test.ts` (sin InMemoryCustomerRepository). */
function fakeCustomers(byClient: Record<string, Contract[]> = {}): Pick<CustomerRepository, 'listContracts'> {
  return { listContracts: async (clientId: string) => byClient[clientId] ?? [] };
}

function buildStack(customers: Pick<CustomerRepository, 'listContracts'> = fakeCustomers(), storeOrderRateLimit = { windowMs: 60_000, limit: 1000 }) {
  const accounts = new InMemoryPortalAccountRepository();
  const sessions = new InMemoryPortalSessionRepository();
  const hasher = new InMemoryPasswordHasher();
  const settingsRepo = new InMemorySettingsRepository();
  const tokenService = new JwtPortalTokenService(TEST_SECRET);

  const portalLogin = new PortalLogin(accounts, sessions, hasher, tokenService);
  const portalAuthMiddleware = createPortalAuthMiddleware(tokenService, accounts);
  const killSwitch = createPortalKillSwitchMiddleware(settingsRepo, 30_000);
  const generalRateLimiter = createPortalGeneralRateLimiter({ windowMs: 60_000, limit: 1000 });
  const storeOrderRateLimiter = createPortalStoreOrderRateLimiter(storeOrderRateLimit);

  const products = new InMemoryStoreProductRepository();
  const orders = new InMemoryStoreOrderRepository();
  const fileStorage = new InMemoryFileStorage();
  const tickets = new InMemoryTicketRepository();
  const comments = new InMemoryTicketCommentRepository();
  const areas = new InMemoryTicketAreaCatalogRepository();
  tickets.seedAreas(areas);

  const listPortalStoreProducts = new ListPortalStoreProducts(products);
  const getPortalStoreProduct = new GetPortalStoreProduct(products);
  const getPortalStoreProductImage = new GetPortalStoreProductImage(products, fileStorage);
  const placeStorePortalOrder = new PlaceStorePortalOrder(products, orders, tickets, comments, areas, customers);

  const app = express();
  app.use(express.json());
  app.use(
    '/api/portal',
    createPortalRouter({
      portalLogin,
      refreshPortalSession: { execute: async () => { throw new Error('not used'); } } as never,
      logoutPortal: { execute: async () => {} } as never,
      changePortalPassword: { execute: async () => {} } as never,
      portalAuthMiddleware,
      killSwitch,
      generalRateLimiter,
      listPortalStoreProducts,
      getPortalStoreProduct,
      getPortalStoreProductImage,
      placeStorePortalOrder,
      storeOrderRateLimiter,
    }),
  );

  return { app, accounts, sessions, hasher, products, orders, fileStorage, tickets, comments, areas };
}

async function loginAs(
  app: express.Express,
  accounts: InMemoryPortalAccountRepository,
  hasher: InMemoryPasswordHasher,
  clientId: string,
): Promise<string> {
  const dni = `dni-${clientId}`;
  await accounts.create({ clientId, dni, passwordHash: await hasher.hash('Secret123') });
  const res = await request(app).post('/api/portal/auth/login').send({ dni, password: 'Secret123' });
  return res.body.accessToken as string;
}

function makeProductInput(overrides: Partial<CreateStoreProductData> = {}): CreateStoreProductData {
  return {
    title: 'Router WiFi 6',
    summary: 'Cobertura total en tu casa',
    description: 'Detalle largo del producto, con todas las especificaciones técnicas.',
    priceArs: 45000,
    maxInstallments: 3,
    warrantyText: '6 meses de garantía legal + 12 del fabricante.',
    active: true,
    ...overrides,
  };
}

const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

describe('store-backend — GET /api/portal/store/products (+ :id, :id/image, :id/order)', () => {
  it('caso 1 — borrador (active=false) y archivado NO aparecen; ≥2 visibles + ≥2 ocultos', async () => {
    const { app, accounts, hasher, products } = buildStack();
    const token = await loginAs(app, accounts, hasher, 'client-a');

    const visible1 = await products.create(makeProductInput({ title: 'Visible 1' }));
    const visible2 = await products.create(makeProductInput({ title: 'Visible 2' }));
    const draft = await products.create(makeProductInput({ title: 'Borrador', active: false }));
    const archivedSeed = await products.create(makeProductInput({ title: 'Archivado' }));
    await products.update(archivedSeed.id, { archivedAt: new Date() });

    const res = await request(app).get('/api/portal/store/products').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    const ids = (res.body.data as Array<{ id: string }>).map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining([visible1.id, visible2.id]));
    expect(ids).not.toContain(draft.id);
    expect(ids).not.toContain(archivedSeed.id);
  });

  it('caso 2 — detalle de un producto inactivo -> 404', async () => {
    const { app, accounts, hasher, products } = buildStack();
    const token = await loginAs(app, accounts, hasher, 'client-a');
    const draft = await products.create(makeProductInput({ active: false }));

    const res = await request(app).get(`/api/portal/store/products/${draft.id}`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('STORE_PRODUCT_NOT_FOUND');
  });

  it('detalle de un producto archivado -> 404', async () => {
    const { app, accounts, hasher, products } = buildStack();
    const token = await loginAs(app, accounts, hasher, 'client-a');
    const seed = await products.create(makeProductInput());
    await products.update(seed.id, { archivedAt: new Date() });

    const res = await request(app).get(`/api/portal/store/products/${seed.id}`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  describe('caso 3 — installmentArs (redondeo a 2 decimales, "half away from zero")', () => {
    it('45000 / 3 = 15000.00 (división exacta)', async () => {
      const { app, accounts, hasher, products } = buildStack();
      const token = await loginAs(app, accounts, hasher, 'client-a');
      await products.create(makeProductInput({ priceArs: 45000, maxInstallments: 3 }));

      const res = await request(app).get('/api/portal/store/products').set('Authorization', `Bearer ${token}`);
      expect(res.body.data[0].installmentArs).toBe(15000);
    });

    it('10000 / 3 = 3333.33 (NO divisible exacto — documentado: la última cuota NO absorbe el resto)', async () => {
      const { app, accounts, hasher, products } = buildStack();
      const token = await loginAs(app, accounts, hasher, 'client-a');
      await products.create(makeProductInput({ priceArs: 10000, maxInstallments: 3 }));

      const res = await request(app).get('/api/portal/store/products').set('Authorization', `Bearer ${token}`);
      expect(res.body.data[0].installmentArs).toBe(3333.33);
      expect(computeInstallmentArs(10000, 3)).toBe(3333.33);
    });
  });

  describe('caso 4 — validaciones de POST .../order', () => {
    it('installments fuera de rango (0 y maxInstallments+1) -> 400', async () => {
      const { app, accounts, hasher, products } = buildStack();
      const token = await loginAs(app, accounts, hasher, 'client-a');
      const product = await products.create(makeProductInput({ maxInstallments: 3 }));

      const zero = await request(app)
        .post(`/api/portal/store/products/${product.id}/order`)
        .set('Authorization', `Bearer ${token}`)
        .send({ installments: 0 });
      expect(zero.status).toBe(400);
      expect(zero.body.code).toBe('STORE_ORDER_INSTALLMENTS_INVALID');

      const overMax = await request(app)
        .post(`/api/portal/store/products/${product.id}/order`)
        .set('Authorization', `Bearer ${token}`)
        .send({ installments: 4 });
      expect(overMax.status).toBe(400);
    });

    it('producto inactivo -> 404', async () => {
      const { app, accounts, hasher, products } = buildStack();
      const token = await loginAs(app, accounts, hasher, 'client-a');
      const draft = await products.create(makeProductInput({ active: false }));

      const res = await request(app)
        .post(`/api/portal/store/products/${draft.id}/order`)
        .set('Authorization', `Bearer ${token}`)
        .send({ installments: 1 });
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('STORE_PRODUCT_NOT_FOUND');
    });

    it('contrato ajeno (id que no pertenece al cliente) -> 404 indistinguible (PORTAL_CONTRACT_NOT_FOUND)', async () => {
      const customers = fakeCustomers({ 'client-a': [{ id: 'contract-a', plan: 'Fibra 100' } as Contract] });
      const { app, accounts, hasher, products } = buildStack(customers);
      const token = await loginAs(app, accounts, hasher, 'client-a');
      const product = await products.create(makeProductInput());

      const res = await request(app)
        .post(`/api/portal/store/products/${product.id}/order`)
        .set('Authorization', `Bearer ${token}`)
        .send({ installments: 1, contractId: 'contract-de-otro-cliente' });
      expect(res.status).toBe(404);
    });

    it('cliente CON contratos sin mandar contractId -> 400 (PortalContractRequiredError, misma regla que CreatePortalTicket)', async () => {
      const customers = fakeCustomers({ 'client-a': [{ id: 'contract-a', plan: 'Fibra 100' } as Contract] });
      const { app, accounts, hasher, products } = buildStack(customers);
      const token = await loginAs(app, accounts, hasher, 'client-a');
      const product = await products.create(makeProductInput());

      const res = await request(app)
        .post(`/api/portal/store/products/${product.id}/order`)
        .set('Authorization', `Bearer ${token}`)
        .send({ installments: 1 });
      expect(res.status).toBe(400);
    });
  });

  describe('caso 5 — order crea ticket + StoreOrder con SNAPSHOT del precio', () => {
    it('crea el ticket, un comentario público del cliente, y el StoreOrder con el precio snapshoteado', async () => {
      const { app, accounts, hasher, products, orders, tickets, comments } = buildStack();
      const token = await loginAs(app, accounts, hasher, 'client-a');
      const product = await products.create(makeProductInput({ priceArs: 45000, maxInstallments: 3 }));

      const res = await request(app)
        .post(`/api/portal/store/products/${product.id}/order`)
        .set('Authorization', `Bearer ${token}`)
        .send({ installments: 3 });

      expect(res.status).toBe(201);
      expect(res.body.ticketNumber).toEqual(expect.any(Number));

      const listedTickets = await tickets.list({ customerId: 'client-a' });
      expect(listedTickets.data).toHaveLength(1);
      const ticket = listedTickets.data[0]!;
      expect(ticket.subject).toContain(product.title);

      const publicComments = await comments.listPublicByTicket(ticket.id);
      expect(publicComments).toHaveLength(1);
      expect(publicComments[0]!.authorKind).toBe('client');
      expect(publicComments[0]!.body).toContain('arrepentimiento');
      expect(publicComments[0]!.body).toContain(product.title);

      const allOrders = await orders.list();
      expect(allOrders).toHaveLength(1);
      expect(allOrders[0]).toMatchObject({
        productId: product.id,
        clientId: 'client-a',
        installments: 3,
        priceArsAtOrder: 45000,
        ticketId: ticket.id,
      });
    });

    it('REVERT-PROBE: cambiar el precio del catálogo DESPUÉS del pedido no altera el snapshot ya guardado', async () => {
      const { app, accounts, hasher, products, orders } = buildStack();
      const token = await loginAs(app, accounts, hasher, 'client-a');
      const product = await products.create(makeProductInput({ priceArs: 45000, maxInstallments: 1 }));

      await request(app)
        .post(`/api/portal/store/products/${product.id}/order`)
        .set('Authorization', `Bearer ${token}`)
        .send({ installments: 1 });

      // El operador sube el precio DESPUÉS del pedido.
      await products.update(product.id, { priceArs: 90000 });

      const allOrders = await orders.list();
      expect(allOrders).toHaveLength(1);
      // El pedido conserva el precio VIEJO, no el precio vivo actual del catálogo.
      expect(allOrders[0]!.priceArsAtOrder).toBe(45000);
      expect(allOrders[0]!.priceArsAtOrder).not.toBe((await products.findById(product.id))!.priceArs);
    });
  });

  describe('caso 6 — imagen: sirve con contentType, 404 sin imagen', () => {
    it('producto sin imagen -> imageUrl null en el DTO, y GET .../image da 404', async () => {
      const { app, accounts, hasher, products } = buildStack();
      const token = await loginAs(app, accounts, hasher, 'client-a');
      const product = await products.create(makeProductInput());

      const detail = await request(app).get(`/api/portal/store/products/${product.id}`).set('Authorization', `Bearer ${token}`);
      expect(detail.body.imageUrl).toBeNull();

      const image = await request(app).get(`/api/portal/store/products/${product.id}/image`).set('Authorization', `Bearer ${token}`);
      expect(image.status).toBe(404);
    });

    it('producto CON imagen -> imageUrl determinístico, y GET .../image sirve el binario con el Content-Type correcto', async () => {
      const { app, accounts, hasher, products, fileStorage } = buildStack();
      const token = await loginAs(app, accounts, hasher, 'client-a');
      const product = await products.create(makeProductInput());
      const key = `store-products/${product.id}/foto.jpg`;
      await fileStorage.save({ key, buffer: JPEG_BYTES, mimeType: 'image/jpeg' });
      await products.update(product.id, { imageStorageKey: key });

      const detail = await request(app).get(`/api/portal/store/products/${product.id}`).set('Authorization', `Bearer ${token}`);
      expect(detail.body.imageUrl).toBe(`/api/portal/store/products/${product.id}/image`);

      const image = await request(app).get(`/api/portal/store/products/${product.id}/image`).set('Authorization', `Bearer ${token}`);
      expect(image.status).toBe(200);
      expect(image.headers['content-type']).toContain('image/jpeg');
      expect(Buffer.compare(image.body as Buffer, JPEG_BYTES)).toBe(0);
    });

    it('la imagen de un producto en borrador NO se sirve (404) — mismo re-chequeo de elegibilidad que el detalle', async () => {
      const { app, accounts, hasher, products, fileStorage } = buildStack();
      const token = await loginAs(app, accounts, hasher, 'client-a');
      const product = await products.create(makeProductInput({ active: false }));
      const key = `store-products/${product.id}/foto.jpg`;
      await fileStorage.save({ key, buffer: JPEG_BYTES, mimeType: 'image/jpeg' });
      await products.update(product.id, { imageStorageKey: key });

      const image = await request(app).get(`/api/portal/store/products/${product.id}/image`).set('Authorization', `Bearer ${token}`);
      expect(image.status).toBe(404);
    });
  });

  it('caso 8 — rate limit de order: 6ta request en la ventana -> 429', async () => {
    const { app, accounts, hasher, products } = buildStack(fakeCustomers(), { windowMs: 60_000, limit: 5 });
    const token = await loginAs(app, accounts, hasher, 'client-a');
    const product = await products.create(makeProductInput({ maxInstallments: 1 }));

    let last: request.Response | undefined;
    for (let i = 0; i < 6; i++) {
      last = await request(app)
        .post(`/api/portal/store/products/${product.id}/order`)
        .set('Authorization', `Bearer ${token}`)
        .send({ installments: 1 });
    }
    expect(last!.status).toBe(429);
  });

  it('anti-IDOR — sin token, 401 en las 4 rutas', async () => {
    const { app, products } = buildStack();
    const product = await products.create(makeProductInput());

    const list = await request(app).get('/api/portal/store/products');
    const detail = await request(app).get(`/api/portal/store/products/${product.id}`);
    const image = await request(app).get(`/api/portal/store/products/${product.id}/image`);
    const order = await request(app).post(`/api/portal/store/products/${product.id}/order`).send({ installments: 1 });

    expect(list.status).toBe(401);
    expect(detail.status).toBe(401);
    expect(image.status).toBe(401);
    expect(order.status).toBe(401);
  });
});

// Tipo auxiliar solo para que `makeProductInput` compile con el shape exacto del port.
type _Unused = StoreProduct;
