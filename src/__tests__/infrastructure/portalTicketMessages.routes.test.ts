/**
 * portal-ticket-messaging (v2.B) — rutas del portal (lado CLIENTE).
 *
 * Cubre los Scenarios de ticket-messaging/spec.md que corresponden al portal:
 * "Hilo del cliente", "Reclamo ajeno", "Mensaje vacío o gigante", "Cliente
 * manda una foto del módem", "Adjunto de un reclamo ajeno", y "La visibilidad
 * la determina la RUTA" del lado cliente (no hay campo `visibility` en el
 * POST — es SIEMPRE public+client).
 */
import request from 'supertest';
import express from 'express';

import { createPortalRouter } from '../../infrastructure/http/routes/portal.routes';
import { createPortalAuthMiddleware } from '../../infrastructure/http/middleware/portalAuthMiddleware';
import { createPortalKillSwitchMiddleware } from '../../infrastructure/http/middleware/portalKillSwitchMiddleware';
import { createPortalGeneralRateLimiter } from '../../infrastructure/http/middleware/rateLimiters';

import { PortalLogin } from '../../application/use-cases/portal/PortalLogin';
import { RefreshPortalSession } from '../../application/use-cases/portal/RefreshPortalSession';
import { LogoutPortal } from '../../application/use-cases/portal/LogoutPortal';
import { ChangePortalPassword } from '../../application/use-cases/portal/ChangePortalPassword';
import { ListPortalTicketMessages } from '../../application/use-cases/portal/ListPortalTicketMessages';
import { SendPortalTicketMessage } from '../../application/use-cases/portal/SendPortalTicketMessage';
import { GetPortalTicketMessageAttachmentFile } from '../../application/use-cases/portal/GetPortalTicketMessageAttachmentFile';
import { GetPortalTicket } from '../../application/use-cases/portal/GetPortalTicket';
import type { CustomerRepository } from '../../domain/ports/CustomerRepository';

import { InMemoryPortalAccountRepository } from '../../infrastructure/adapters/in-memory/InMemoryPortalAccountRepository';
import { InMemoryPortalSessionRepository } from '../../infrastructure/adapters/in-memory/InMemoryPortalSessionRepository';
import { InMemoryPasswordHasher } from '../../infrastructure/adapters/in-memory/InMemoryPasswordHasher';
import { InMemorySettingsRepository } from '../../infrastructure/adapters/in-memory/InMemorySettingsRepository';
import { InMemoryTicketRepository } from '../../infrastructure/adapters/in-memory/InMemoryTicketRepository';
import { InMemoryTicketCommentRepository } from '../../infrastructure/adapters/in-memory/InMemoryTicketCommentRepository';
import { InMemoryFileStorage } from '../../infrastructure/adapters/in-memory/InMemoryFileStorage';
import { JwtPortalTokenService } from '../../infrastructure/adapters/jwt/JwtPortalTokenService';
import { errorHandler } from '../../infrastructure/http/middleware/errorHandler';

const TEST_SECRET = 'test-jwt-secret-32chars-minimum!';

function buildStack() {
  const accounts = new InMemoryPortalAccountRepository();
  const sessions = new InMemoryPortalSessionRepository();
  const hasher = new InMemoryPasswordHasher();
  const settingsRepo = new InMemorySettingsRepository();
  const tokenService = new JwtPortalTokenService(TEST_SECRET);
  const ticketRepo = new InMemoryTicketRepository();
  const commentRepo = new InMemoryTicketCommentRepository();
  const storage = new InMemoryFileStorage();

  const portalLogin = new PortalLogin(accounts, sessions, hasher, tokenService);
  const refreshPortalSession = new RefreshPortalSession(accounts, sessions, tokenService);
  const logoutPortal = new LogoutPortal(sessions);
  const changePortalPassword = new ChangePortalPassword(accounts, hasher, sessions);
  const listPortalTicketMessages = new ListPortalTicketMessages(ticketRepo, commentRepo);
  const sendPortalTicketMessage = new SendPortalTicketMessage(ticketRepo, commentRepo, storage);
  const getPortalTicketMessageAttachmentFile = new GetPortalTicketMessageAttachmentFile(ticketRepo, commentRepo, storage);
  const noContracts: Pick<CustomerRepository, 'listContracts'> = { listContracts: async () => [] };
  const getPortalTicket = new GetPortalTicket(ticketRepo, noContracts, commentRepo);

  const portalAuthMiddleware = createPortalAuthMiddleware(tokenService, accounts);
  const killSwitch = createPortalKillSwitchMiddleware(settingsRepo, 30_000);
  const generalRateLimiter = createPortalGeneralRateLimiter({ windowMs: 60_000, limit: 1000 });

  const app = express();
  app.use(express.json());
  app.use(
    '/api/portal',
    createPortalRouter({
      portalLogin,
      refreshPortalSession,
      logoutPortal,
      changePortalPassword,
      portalAuthMiddleware,
      killSwitch,
      generalRateLimiter,
      listPortalTicketMessages,
      sendPortalTicketMessage,
      getPortalTicketMessageAttachmentFile,
      getPortalTicket,
      ticketMessageSendRateLimiter: createPortalGeneralRateLimiter({ windowMs: 60_000, limit: 1000 }),
    }),
  );
  app.use(errorHandler);

  return { app, accounts, sessions, hasher, tokenService, ticketRepo, commentRepo, storage };
}

async function createAccountAndToken(
  stack: ReturnType<typeof buildStack>,
  clientId: string,
  dni: string,
  password: string,
): Promise<string> {
  const account = await stack.accounts.create({ clientId, dni, passwordHash: await stack.hasher.hash(password) });
  return stack.tokenService.signAccessToken({ accountId: account.id, clientId: account.clientId });
}

describe('GET /api/portal/tickets/:number/messages', () => {
  it('scenario "Hilo del cliente": 2 públicos + 3 internos -> ve EXACTAMENTE 2', async () => {
    const stack = buildStack();
    const ticket = await stack.ticketRepo.create({ subject: 'S', description: 'D', customerId: 'client-a' });
    const token = await createAccountAndToken(stack, 'client-a', '30111222', 'Secret123');
    for (let i = 0; i < 3; i++) {
      await stack.commentRepo.create({
        id: `internal-${i}`, ticketId: ticket.id, authorId: null, authorKind: 'staff', visibility: 'internal',
        authorName: 'Ana', body: `nota ${i}`, createdAt: new Date().toISOString(), attachments: [],
      });
    }
    await stack.commentRepo.create({
      id: 'public-1', ticketId: ticket.id, authorId: 'acc-a', authorKind: 'client', visibility: 'public',
      authorName: 'Cliente', body: 'hola', createdAt: '2026-01-01T00:00:01.000Z', attachments: [],
    });
    await stack.commentRepo.create({
      id: 'public-2', ticketId: ticket.id, authorId: null, authorKind: 'staff', visibility: 'public',
      authorName: 'Ana', body: 'respuesta', createdAt: '2026-01-01T00:00:02.000Z', attachments: [],
    });

    const res = await request(stack.app)
      .get(`/api/portal/tickets/${ticket.sequenceNumber}/messages`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data.map((m: { id: string }) => m.id)).toEqual(['public-1', 'public-2']);
    expect(JSON.stringify(res.body)).not.toContain('internal');
  });

  it('scenario "Reclamo ajeno": 404 indistinguible de inexistente', async () => {
    const stack = buildStack();
    const ticketB = await stack.ticketRepo.create({ subject: 'S', description: 'D', customerId: 'client-b' });
    const tokenA = await createAccountAndToken(stack, 'client-a', '30111222', 'Secret123');

    const foreign = await request(stack.app).get(`/api/portal/tickets/${ticketB.sequenceNumber}/messages`).set('Authorization', `Bearer ${tokenA}`);
    const missing = await request(stack.app).get('/api/portal/tickets/999999/messages').set('Authorization', `Bearer ${tokenA}`);

    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(foreign.body).toEqual(missing.body);
  });

  it('sin token -> 401', async () => {
    const stack = buildStack();
    const ticket = await stack.ticketRepo.create({ subject: 'S', description: 'D', customerId: 'client-a' });

    const res = await request(stack.app).get(`/api/portal/tickets/${ticket.sequenceNumber}/messages`);

    expect(res.status).toBe(401);
  });
});

describe('POST /api/portal/tickets/:number/messages', () => {
  it('crea el mensaje del cliente (siempre público, sin campo visibility en el request)', async () => {
    const stack = buildStack();
    const ticket = await stack.ticketRepo.create({ subject: 'S', description: 'D', customerId: 'client-a' });
    const token = await createAccountAndToken(stack, 'client-a', '30111222', 'Secret123');

    const res = await request(stack.app)
      .post(`/api/portal/tickets/${ticket.sequenceNumber}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .send({ body: 'sigue sin andar' });

    expect(res.status).toBe(201);
    expect(res.body.authorKind).toBe('client');
    const stored = await stack.commentRepo.listByTicket(ticket.id);
    expect(stored[0]!.visibility).toBe('public');
  });

  it('"visibility en el body NO cambia nada": mandar visibility:"internal" es RECHAZADO con 400', async () => {
    const stack = buildStack();
    const ticket = await stack.ticketRepo.create({ subject: 'S', description: 'D', customerId: 'client-a' });
    const token = await createAccountAndToken(stack, 'client-a', '30111222', 'Secret123');

    const res = await request(stack.app)
      .post(`/api/portal/tickets/${ticket.sequenceNumber}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .send({ body: 'intento colar algo raro', visibility: 'internal' });

    expect(res.status).toBe(400);
    expect(await stack.commentRepo.listByTicket(ticket.id)).toHaveLength(0);
  });

  it('scenario "Mensaje vacío o gigante" (vacío): 400, no crea nada', async () => {
    const stack = buildStack();
    const ticket = await stack.ticketRepo.create({ subject: 'S', description: 'D', customerId: 'client-a' });
    const token = await createAccountAndToken(stack, 'client-a', '30111222', 'Secret123');

    const res = await request(stack.app)
      .post(`/api/portal/tickets/${ticket.sequenceNumber}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .send({ body: '' });

    expect(res.status).toBe(400);
    expect(await stack.commentRepo.listByTicket(ticket.id)).toHaveLength(0);
  });

  it('scenario "Reclamo ajeno" en escritura: 404 indistinguible, no crea nada', async () => {
    const stack = buildStack();
    const ticketB = await stack.ticketRepo.create({ subject: 'S', description: 'D', customerId: 'client-b' });
    const tokenA = await createAccountAndToken(stack, 'client-a', '30111222', 'Secret123');

    const res = await request(stack.app)
      .post(`/api/portal/tickets/${ticketB.sequenceNumber}/messages`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ body: 'no debería poder' });

    expect(res.status).toBe(404);
    expect(await stack.commentRepo.listByTicket(ticketB.id)).toHaveLength(0);
  });

  it('scenario "Cliente manda una foto del módem": 201 con el adjunto, servido después por su propia ruta', async () => {
    const stack = buildStack();
    const ticket = await stack.ticketRepo.create({ subject: 'S', description: 'D', customerId: 'client-a' });
    const token = await createAccountAndToken(stack, 'client-a', '30111222', 'Secret123');

    const sendRes = await request(stack.app)
      .post(`/api/portal/tickets/${ticket.sequenceNumber}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .field('body', 'mirá cómo quedó')
      .attach('files', Buffer.from([0xff, 0xd8, 0xff, 0xd9]), { filename: 'modem.jpg', contentType: 'image/jpeg' });

    expect(sendRes.status).toBe(201);
    const attachmentId = sendRes.body.attachments[0].id;

    const fileRes = await request(stack.app)
      .get(`/api/portal/tickets/${ticket.sequenceNumber}/messages/attachments/${attachmentId}/file`)
      .set('Authorization', `Bearer ${token}`);

    expect(fileRes.status).toBe(200);
    expect(fileRes.headers['content-type']).toBe('image/jpeg');
  });

  it('scenario "Tipo no permitido": 415, no se guarda nada en el storage', async () => {
    const stack = buildStack();
    const ticket = await stack.ticketRepo.create({ subject: 'S', description: 'D', customerId: 'client-a' });
    const token = await createAccountAndToken(stack, 'client-a', '30111222', 'Secret123');

    const res = await request(stack.app)
      .post(`/api/portal/tickets/${ticket.sequenceNumber}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .field('body', 'x')
      .attach('files', Buffer.from('x'), { filename: 'virus.exe', contentType: 'application/x-msdownload' });

    expect(res.status).toBe(415);
    expect(stack.storage.store.size).toBe(0);
  });
});

describe('GET /api/portal/tickets/:number/messages/attachments/:id/file — pertenencia', () => {
  it('scenario "Adjunto de un reclamo ajeno": 404, no se obtiene el binario', async () => {
    const stack = buildStack();
    const ticketB = await stack.ticketRepo.create({ subject: 'S', description: 'D', customerId: 'client-b' });
    await stack.storage.save({ key: 'k', buffer: Buffer.from('img'), mimeType: 'image/jpeg' });
    await stack.commentRepo.create({
      id: 'c1', ticketId: ticketB.id, authorId: 'acc-b', authorKind: 'client', visibility: 'public',
      authorName: 'Cliente', body: 'foto', createdAt: new Date().toISOString(),
      attachments: [{ id: 'a1', commentId: 'c1', url: null, storageKey: 'k', kind: 'image', filename: 'foto.jpg', mimeType: 'image/jpeg', sizeBytes: 3 }],
    });
    const tokenA = await createAccountAndToken(stack, 'client-a', '30111222', 'Secret123');

    const res = await request(stack.app)
      .get(`/api/portal/tickets/${ticketB.sequenceNumber}/messages/attachments/a1/file`)
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(404);
  });
});

describe('No leídos por lado — badge del cliente', () => {
  it('scenario "Respuesta nueva sin leer": el operador responde -> 1 no leído; al abrirlo (GET messages), se limpia', async () => {
    const stack = buildStack();
    const ticket = await stack.ticketRepo.create({ subject: 'S', description: 'D', customerId: 'client-a' });
    const token = await createAccountAndToken(stack, 'client-a', '30111222', 'Secret123');
    await stack.commentRepo.create({
      id: 'm1', ticketId: ticket.id, authorId: null, authorKind: 'staff', visibility: 'public',
      authorName: 'Ana', body: 'Ya lo vemos', createdAt: new Date().toISOString(), attachments: [],
    });

    const before = await request(stack.app).get(`/api/portal/tickets/${ticket.sequenceNumber}`).set('Authorization', `Bearer ${token}`);
    expect(before.body.unreadCount).toBe(1);

    await request(stack.app).get(`/api/portal/tickets/${ticket.sequenceNumber}/messages`).set('Authorization', `Bearer ${token}`);

    const after = await request(stack.app).get(`/api/portal/tickets/${ticket.sequenceNumber}`).set('Authorization', `Bearer ${token}`);
    expect(after.body.unreadCount).toBe(0);
  });
});
