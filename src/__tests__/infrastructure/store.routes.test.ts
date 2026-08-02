/**
 * store-backend — admin CRUD (`/api/store`), calco EXACTO del fixture de
 * `promos.routes.test.ts` (EchoAuthProvider + RBAC in-memory), 3 usuarios:
 * manage / read-only / sin permiso.
 *
 * Read guard:  store.read
 * Write guard: store.manage (incluye subir/borrar imagen)
 *
 * Casos TDD cubiertos acá: 1 (admin ve borrador/archivado), 6 (imagen: sube,
 * magic bytes acepta PNG-renombrado-.jpg, rechaza .exe, sirve con
 * contentType), 7 (403 sin store.manage en TODAS las escrituras).
 */
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';

import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import type { RbacUserRepository } from '@domain/ports/RbacUserRepository';
import { InMemoryRbacRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRoleRepository';
import { InMemoryRbacUserRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRoleRepository';
import { InMemoryRbacPermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacPermissionRepository';
import { InMemoryRbacRolePermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRolePermissionRepository';
import { InMemoryPasswordHasher } from '@infrastructure/adapters/in-memory/InMemoryPasswordHasher';
import { InMemoryStoreProductRepository } from '@infrastructure/adapters/in-memory/InMemoryStoreProductRepository';
import { InMemoryStoreOrderRepository } from '@infrastructure/adapters/in-memory/InMemoryStoreOrderRepository';
import { InMemoryFileStorage } from '@infrastructure/adapters/in-memory/InMemoryFileStorage';
import { InMemoryTicketRepository } from '@infrastructure/adapters/in-memory/InMemoryTicketRepository';

import { requirePermission } from '@infrastructure/http/middleware/requirePermission';
import { errorHandler } from '@infrastructure/http/middleware/errorHandler';
import { createStoreRouter } from '@infrastructure/http/routes/store.routes';

import { ListStoreProductsAdmin } from '@application/use-cases/store/ListStoreProductsAdmin';
import { GetStoreProductAdmin } from '@application/use-cases/store/GetStoreProductAdmin';
import { CreateStoreProduct } from '@application/use-cases/store/CreateStoreProduct';
import { UpdateStoreProduct } from '@application/use-cases/store/UpdateStoreProduct';
import { UploadStoreProductImage } from '@application/use-cases/store/UploadStoreProductImage';
import { DeleteStoreProductImage } from '@application/use-cases/store/DeleteStoreProductImage';
import { GetStoreProductImage } from '@application/use-cases/store/GetStoreProductImage';
import { ListStoreOrdersAdmin } from '@application/use-cases/store/ListStoreOrdersAdmin';

import { AuthProvider } from '@domain/ports/AuthProvider';
import { User } from '@domain/entities/auth';
import type { RbacModuleCode, PermissionAction } from '@domain/entities/rbac';
import type { CustomerRepository } from '@domain/ports/CustomerRepository';
import { ClientNotFoundError } from '@domain/errors';

/** token IS the userId (echoed, molde news.routes.test.ts / promos.routes.test.ts). */
class EchoAuthProvider implements AuthProvider {
  constructor(private readonly userRepo: RbacUserRepository) {}
  async login() {
    return {
      user: { id: 'x', username: 't', email: 't@t.com', role: 'admin' as const },
      cookieValue: 'x',
      cookieOptions: { httpOnly: true, secure: false, sameSite: 'lax' as const, maxAge: 3600, path: '/' },
    };
  }
  logout() {
    return { cookieOptions: { httpOnly: true, secure: false, sameSite: 'lax' as const, maxAge: 0, path: '/' } };
  }
  async getSession(token: string): Promise<User> {
    const user = await this.userRepo.findById(token);
    if (!user) return { id: token, username: token, email: `${token}@test.com`, role: 'admin' };
    return { id: user.id, username: user.login, email: user.email, role: 'admin' };
  }
}

/** Fake narrow — sin InMemoryCustomerRepository en este repo (mismo criterio que promos.routes.test.ts). */
function fakeCustomers(names: Record<string, string> = {}): Pick<CustomerRepository, 'findById'> {
  return {
    findById: async (id: string) => {
      if (!(id in names)) throw new ClientNotFoundError(id);
      return { id, name: names[id] } as never;
    },
  };
}

interface Fixture {
  app: express.Express;
  productRepo: InMemoryStoreProductRepository;
  orderRepo: InMemoryStoreOrderRepository;
  fileStorage: InMemoryFileStorage;
  tickets: InMemoryTicketRepository;
  manageUserId: string;
  readOnlyUserId: string;
  noPermUserId: string;
}

async function buildApp(customerNames: Record<string, string> = {}): Promise<Fixture> {
  const roleRepo = new InMemoryRbacRoleRepository();
  const userRoleRepo = new InMemoryRbacUserRoleRepository();
  const permRepo = new InMemoryRbacPermissionRepository();
  const rolePermRepo = new InMemoryRbacRolePermissionRepository();
  const hasher = new InMemoryPasswordHasher();
  const userRepo = new InMemoryRbacUserRepository(userRoleRepo, roleRepo);

  userRepo.listRolesForUser = async (userId: string) => {
    const roleIds = await userRoleRepo.listForUser(userId);
    const roles = await Promise.all(roleIds.map((id) => roleRepo.findById(id)));
    return roles.filter((r): r is NonNullable<typeof r> => r !== null);
  };
  userRepo.listPermissionsForUser = async (userId: string) => {
    const roleIds = await userRoleRepo.listForUser(userId);
    const perms: import('@domain/entities/rbac').RbacPermission[] = [];
    const allPerms = await permRepo.listAll();
    for (const roleId of roleIds) {
      const permIds = await rolePermRepo.listForRole(roleId);
      for (const permId of permIds) {
        const p = allPerms.find((ap) => ap.id === permId);
        if (p) perms.push(p);
      }
    }
    return perms;
  };

  const managerRole = await roleRepo.create({ code: 'store_manager', label: 'Store Manager', isSystem: false });
  const readerRole = await roleRepo.create({ code: 'store_reader', label: 'Store Reader', isSystem: false });

  const managePerm = await permRepo.seed({ moduleCode: 'store', action: 'manage' });
  const readPerm = await permRepo.seed({ moduleCode: 'store', action: 'read' });

  await rolePermRepo.grant(managerRole.id, managePerm.id);
  await rolePermRepo.grant(managerRole.id, readPerm.id);
  await rolePermRepo.grant(readerRole.id, readPerm.id);

  const pwHash = await hasher.hash('pw');
  const mkUser = (login: string) =>
    userRepo.create({ name: login, email: `${login}@x.com`, login, passwordHash: pwHash, status: 'active' });

  const manageUser = await mkUser('manager');
  await userRoleRepo.assign(manageUser.id, managerRole.id);
  const readUser = await mkUser('reader');
  await userRoleRepo.assign(readUser.id, readerRole.id);
  const noPermUser = await mkUser('noperm');

  const productRepo = new InMemoryStoreProductRepository();
  const orderRepo = new InMemoryStoreOrderRepository();
  const fileStorage = new InMemoryFileStorage();
  const tickets = new InMemoryTicketRepository();
  const customers = fakeCustomers(customerNames);

  const requirePerm = (m: RbacModuleCode, a: PermissionAction) => requirePermission(userRepo, m, a);

  const listStoreProductsAdmin = new ListStoreProductsAdmin(productRepo);
  const getStoreProductAdmin = new GetStoreProductAdmin(productRepo);
  const createStoreProduct = new CreateStoreProduct(productRepo);
  const updateStoreProduct = new UpdateStoreProduct(productRepo);
  const uploadStoreProductImage = new UploadStoreProductImage(productRepo, fileStorage);
  const deleteStoreProductImage = new DeleteStoreProductImage(productRepo, fileStorage);
  const listStoreOrdersAdmin = new ListStoreOrdersAdmin(orderRepo, productRepo, customers, tickets);
  const getStoreProductImage = new GetStoreProductImage(productRepo, fileStorage);

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use(
    '/api/store',
    createStoreRouter(
      new EchoAuthProvider(userRepo),
      undefined,
      requirePerm,
      listStoreProductsAdmin,
      getStoreProductAdmin,
      createStoreProduct,
      updateStoreProduct,
      uploadStoreProductImage,
      deleteStoreProductImage,
      listStoreOrdersAdmin,
      getStoreProductImage,
    ),
  );
  app.use(errorHandler);

  return { app, productRepo, orderRepo, fileStorage, tickets, manageUserId: manageUser.id, readOnlyUserId: readUser.id, noPermUserId: noPermUser.id };
}

function asUser(req: request.Test, userId: string): request.Test {
  return req.set('Cookie', `auth_token=${userId}`);
}

function validProductBody(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Router WiFi 6',
    summary: 'Cobertura total en tu casa',
    description: 'Detalle largo del producto, con todas las especificaciones.',
    priceArs: 45000,
    maxInstallments: 3,
    warrantyText: '6 meses de garantía legal + 12 del fabricante.',
    ...overrides,
  };
}

// JPEG real (magic bytes FF D8 FF D9) — molde ticketMessages.routes.test.ts / taskAttachments.routes.test.ts.
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
// PNG real (magic bytes 89 50 4E 47).
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// Ejecutable Windows (magic bytes "MZ") — nunca matchea NINGÚN sniffer de imagen.
const EXE_BYTES = Buffer.from([0x4d, 0x5a, 0x90, 0x00]);

describe('GET /api/store/products — auth/RBAC', () => {
  it('sin cookie -> 401', async () => {
    const { app } = await buildApp();
    const res = await request(app).get('/api/store/products');
    expect(res.status).toBe(401);
  });

  it('sin store.read -> 403', async () => {
    const fx = await buildApp();
    const res = await asUser(request(fx.app).get('/api/store/products'), fx.noPermUserId);
    expect(res.status).toBe(403);
  });

  it('con store.read -> 200', async () => {
    const fx = await buildApp();
    const res = await asUser(request(fx.app).get('/api/store/products'), fx.readOnlyUserId);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('caso 1 — el admin VE productos en borrador y archivados (a diferencia del portal)', async () => {
    const fx = await buildApp();
    const draft = await fx.productRepo.create(validProductBody() as never);
    const archivedSeed = await fx.productRepo.create({ ...validProductBody(), active: true } as never);
    await fx.productRepo.update(archivedSeed.id, { archivedAt: new Date() });

    const res = await asUser(request(fx.app).get('/api/store/products'), fx.readOnlyUserId);
    expect(res.status).toBe(200);
    const ids = (res.body.data as Array<{ id: string }>).map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining([draft.id, archivedSeed.id]));
  });
});

describe('POST /api/store/products — create (store.manage)', () => {
  it('con SOLO store.read -> 403', async () => {
    const fx = await buildApp();
    const res = await asUser(request(fx.app).post('/api/store/products').send(validProductBody()), fx.readOnlyUserId);
    expect(res.status).toBe(403);
  });

  it('con store.manage -> 201, nace en borrador (active=false) por default', async () => {
    const fx = await buildApp();
    const res = await asUser(request(fx.app).post('/api/store/products').send(validProductBody()), fx.manageUserId);
    expect(res.status).toBe(201);
    expect(res.body.active).toBe(false);
    expect(res.body.imageStorageKey).toBeNull();
  });

  it('payload inválido (sin title) -> 400', async () => {
    const fx = await buildApp();
    const body = validProductBody();
    delete (body as Record<string, unknown>)['title'];
    const res = await asUser(request(fx.app).post('/api/store/products').send(body), fx.manageUserId);
    expect(res.status).toBe(400);
  });
});

describe('GET /:id + PATCH — 404 sobre id inexistente, archivar', () => {
  it('GET /:id inexistente -> 404', async () => {
    const fx = await buildApp();
    const res = await asUser(request(fx.app).get('/api/store/products/no-existe'), fx.readOnlyUserId);
    expect(res.status).toBe(404);
  });

  it('PATCH /:id inexistente -> 404', async () => {
    const fx = await buildApp();
    const res = await asUser(request(fx.app).patch('/api/store/products/no-existe').send({ title: 'x' }), fx.manageUserId);
    expect(res.status).toBe(404);
  });

  it('PATCH sin store.manage -> 403', async () => {
    const fx = await buildApp();
    const created = await asUser(request(fx.app).post('/api/store/products').send(validProductBody()), fx.manageUserId);
    const res = await asUser(request(fx.app).patch(`/api/store/products/${created.body.id}`).send({ active: true }), fx.readOnlyUserId);
    expect(res.status).toBe(403);
  });

  it('PATCH archivedAt: <fecha> archiva; archivedAt: null desarchiva', async () => {
    const fx = await buildApp();
    const created = await asUser(request(fx.app).post('/api/store/products').send(validProductBody({ active: true })), fx.manageUserId);

    const archived = await asUser(
      request(fx.app).patch(`/api/store/products/${created.body.id}`).send({ archivedAt: new Date().toISOString() }),
      fx.manageUserId,
    );
    expect(archived.status).toBe(200);
    expect(archived.body.archivedAt).not.toBeNull();

    const unarchived = await asUser(
      request(fx.app).patch(`/api/store/products/${created.body.id}`).send({ archivedAt: null }),
      fx.manageUserId,
    );
    expect(unarchived.status).toBe(200);
    expect(unarchived.body.archivedAt).toBeNull();
  });
});

describe('caso 6 — imagen: subir, servir, magic bytes', () => {
  it('sube una imagen válida con store.manage -> 200, setea imageStorageKey', async () => {
    const fx = await buildApp();
    const created = await asUser(request(fx.app).post('/api/store/products').send(validProductBody()), fx.manageUserId);

    const res = await asUser(
      request(fx.app).post(`/api/store/products/${created.body.id}/image`).attach('file', JPEG_BYTES, { filename: 'foto.jpg', contentType: 'image/jpeg' }),
      fx.manageUserId,
    );

    expect(res.status).toBe(200);
    expect(res.body.imageStorageKey).toEqual(expect.stringContaining(created.body.id));
  });

  it('subir imagen sin store.manage (solo read) -> 403', async () => {
    const fx = await buildApp();
    const created = await asUser(request(fx.app).post('/api/store/products').send(validProductBody()), fx.manageUserId);

    const res = await asUser(
      request(fx.app).post(`/api/store/products/${created.body.id}/image`).attach('file', JPEG_BYTES, { filename: 'foto.jpg', contentType: 'image/jpeg' }),
      fx.readOnlyUserId,
    );
    expect(res.status).toBe(403);
  });

  it('un PNG renombrado a .jpg PASA (el chequeo mira el contenido real vs el Content-Type declarado, nunca la extensión del filename)', async () => {
    const fx = await buildApp();
    const created = await asUser(request(fx.app).post('/api/store/products').send(validProductBody()), fx.manageUserId);

    const res = await asUser(
      request(fx.app)
        .post(`/api/store/products/${created.body.id}/image`)
        .attach('file', PNG_BYTES, { filename: 'foto.jpg', contentType: 'image/png' }),
      fx.manageUserId,
    );

    expect(res.status).toBe(200);
    expect(res.body.imageStorageKey).toEqual(expect.stringContaining('.png'));
  });

  it('un .exe con Content-Type de imagen se rechaza -> 415 (magic bytes no matchean)', async () => {
    const fx = await buildApp();
    const created = await asUser(request(fx.app).post('/api/store/products').send(validProductBody()), fx.manageUserId);

    const res = await asUser(
      request(fx.app)
        .post(`/api/store/products/${created.body.id}/image`)
        .attach('file', EXE_BYTES, { filename: 'malware.jpg', contentType: 'image/jpeg' }),
      fx.manageUserId,
    );

    expect(res.status).toBe(415);
    expect(res.body.code).toBe('UNSUPPORTED_STORE_PRODUCT_IMAGE_TYPE');
  });

  it('imagen sobre producto inexistente -> 404 (no queda un binario huérfano en storage)', async () => {
    const fx = await buildApp();
    const res = await asUser(
      request(fx.app).post('/api/store/products/no-existe/image').attach('file', JPEG_BYTES, { filename: 'foto.jpg', contentType: 'image/jpeg' }),
      fx.manageUserId,
    );
    expect(res.status).toBe(404);
    expect(fx.fileStorage.store.size).toBe(0);
  });

  it('DELETE /:id/image -> 204, borra la key y el producto queda sin imagen', async () => {
    const fx = await buildApp();
    const created = await asUser(request(fx.app).post('/api/store/products').send(validProductBody()), fx.manageUserId);
    await asUser(
      request(fx.app).post(`/api/store/products/${created.body.id}/image`).attach('file', JPEG_BYTES, { filename: 'foto.jpg', contentType: 'image/jpeg' }),
      fx.manageUserId,
    );

    const del = await asUser(request(fx.app).delete(`/api/store/products/${created.body.id}/image`), fx.manageUserId);
    expect(del.status).toBe(204);

    const after = await asUser(request(fx.app).get(`/api/store/products/${created.body.id}`), fx.readOnlyUserId);
    expect(after.body.imageStorageKey).toBeNull();
    expect(fx.fileStorage.store.size).toBe(0);
  });

  it('DELETE /:id/image sin store.manage -> 403', async () => {
    const fx = await buildApp();
    const created = await asUser(request(fx.app).post('/api/store/products').send(validProductBody()), fx.manageUserId);
    const res = await asUser(request(fx.app).delete(`/api/store/products/${created.body.id}/image`), fx.readOnlyUserId);
    expect(res.status).toBe(403);
  });
});

describe('GET /api/store/orders — panel (producto/cliente/ticket joined)', () => {
  it('sin store.read -> 403', async () => {
    const fx = await buildApp();
    const res = await asUser(request(fx.app).get('/api/store/orders'), fx.noPermUserId);
    expect(res.status).toBe(403);
  });

  it('con store.read -> 200, cada fila trae productTitle/clientName/ticketNumber resueltos', async () => {
    const fx = await buildApp({ 'client-1': 'Juan Pérez' });
    const product = await fx.productRepo.create({ ...validProductBody(), active: true } as never);
    const ticket = await fx.tickets.create({ subject: 'Pedido', description: 'x', customerId: 'client-1', areaId: null });
    await fx.orderRepo.create({
      productId: product.id,
      clientId: 'client-1',
      installments: 3,
      priceArsAtOrder: 45000,
      ticketId: ticket.id,
    });

    const res = await asUser(request(fx.app).get('/api/store/orders'), fx.readOnlyUserId);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({
      productTitle: product.title,
      clientName: 'Juan Pérez',
      ticketNumber: ticket.sequenceNumber,
      priceArsAtOrder: 45000,
      installments: 3,
    });
  });

  it('ajuste de contrato FE — el DTO trae AMBOS ticketId (UUID, para el link a /admin/tickets/:id → getById) Y ticketNumber (display)', async () => {
    const fx = await buildApp({ 'client-1': 'Juan Pérez' });
    const product = await fx.productRepo.create({ ...validProductBody(), active: true } as never);
    const ticket = await fx.tickets.create({ subject: 'Pedido', description: 'x', customerId: 'client-1', areaId: null });
    await fx.orderRepo.create({
      productId: product.id,
      clientId: 'client-1',
      installments: 1,
      priceArsAtOrder: 45000,
      ticketId: ticket.id,
    });

    const res = await asUser(request(fx.app).get('/api/store/orders'), fx.readOnlyUserId);
    expect(res.status).toBe(200);
    // ticketId = el UUID REAL (lo que resuelve TicketRepository.getById), NUNCA el sequenceNumber.
    expect(res.body.data[0].ticketId).toBe(ticket.id);
    expect(typeof res.body.data[0].ticketId).toBe('string');
    // ticketNumber = el sequenceNumber, para el display — DISTINTO del ticketId.
    expect(res.body.data[0].ticketNumber).toBe(ticket.sequenceNumber);
    expect(res.body.data[0].ticketId).not.toBe(res.body.data[0].ticketNumber);
  });
});

describe('GET /api/store/products/:id/image — ADMIN (store.read, thumbnail para el panel)', () => {
  it('sin cookie -> 401', async () => {
    const fx = await buildApp();
    const created = await asUser(request(fx.app).post('/api/store/products').send(validProductBody()), fx.manageUserId);
    await asUser(
      request(fx.app).post(`/api/store/products/${created.body.id}/image`).attach('file', JPEG_BYTES, { filename: 'foto.jpg', contentType: 'image/jpeg' }),
      fx.manageUserId,
    );

    const res = await request(fx.app).get(`/api/store/products/${created.body.id}/image`);
    expect(res.status).toBe(401);
  });

  it('sin store.read -> 403', async () => {
    const fx = await buildApp();
    const created = await asUser(request(fx.app).post('/api/store/products').send(validProductBody()), fx.manageUserId);
    await asUser(
      request(fx.app).post(`/api/store/products/${created.body.id}/image`).attach('file', JPEG_BYTES, { filename: 'foto.jpg', contentType: 'image/jpeg' }),
      fx.manageUserId,
    );

    const res = await asUser(request(fx.app).get(`/api/store/products/${created.body.id}/image`), fx.noPermUserId);
    expect(res.status).toBe(403);
  });

  it('con store.read -> 200, sirve el binario con el Content-Type correcto (mismo objeto que subió store.manage)', async () => {
    const fx = await buildApp();
    const created = await asUser(request(fx.app).post('/api/store/products').send(validProductBody()), fx.manageUserId);
    await asUser(
      request(fx.app).post(`/api/store/products/${created.body.id}/image`).attach('file', JPEG_BYTES, { filename: 'foto.jpg', contentType: 'image/jpeg' }),
      fx.manageUserId,
    );

    const res = await asUser(request(fx.app).get(`/api/store/products/${created.body.id}/image`), fx.readOnlyUserId);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/jpeg');
    expect(Buffer.compare(res.body as Buffer, JPEG_BYTES)).toBe(0);
  });

  it('producto en BORRADOR igual sirve su imagen para el staff (a diferencia de la ruta del portal — el panel necesita ver el thumbnail mientras edita)', async () => {
    const fx = await buildApp();
    const created = await asUser(request(fx.app).post('/api/store/products').send(validProductBody({ active: false })), fx.manageUserId);
    await asUser(
      request(fx.app).post(`/api/store/products/${created.body.id}/image`).attach('file', JPEG_BYTES, { filename: 'foto.jpg', contentType: 'image/jpeg' }),
      fx.manageUserId,
    );

    const res = await asUser(request(fx.app).get(`/api/store/products/${created.body.id}/image`), fx.readOnlyUserId);
    expect(res.status).toBe(200);
  });

  it('producto sin imagen -> 404', async () => {
    const fx = await buildApp();
    const created = await asUser(request(fx.app).post('/api/store/products').send(validProductBody()), fx.manageUserId);

    const res = await asUser(request(fx.app).get(`/api/store/products/${created.body.id}/image`), fx.readOnlyUserId);
    expect(res.status).toBe(404);
  });
});
