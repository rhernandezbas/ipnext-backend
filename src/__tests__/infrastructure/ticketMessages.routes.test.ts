/**
 * portal-ticket-messaging (v2.B) — ticketMessages.routes (lado ADMIN).
 *
 * spec "La visibilidad la determina la RUTA, no el payload" (diseño ajustado a
 * pedido del usuario): `POST /:ticketId/messages` SIEMPRE crea `visibility:
 * public` — el test "visibility en el body no cambia nada" es EL scenario
 * central de esta suite.
 */
import request from 'supertest';
import express, { RequestHandler } from 'express';
import { SendStaffTicketReply } from '../../application/use-cases/SendStaffTicketReply';
import { GetTicketUnreadCount } from '../../application/use-cases/GetTicketUnreadCount';
import { GetTicketMessageAttachmentFile } from '../../application/use-cases/GetTicketMessageAttachmentFile';
import { InMemoryTicketCommentRepository } from '../../infrastructure/adapters/in-memory/InMemoryTicketCommentRepository';
import { InMemoryTicketRepository } from '../../infrastructure/adapters/in-memory/InMemoryTicketRepository';
import { InMemoryFileStorage } from '../../infrastructure/adapters/in-memory/InMemoryFileStorage';
import { createTicketMessagesRouter } from '../../infrastructure/http/routes/ticketMessages.routes';
import { errorHandler } from '../../infrastructure/http/middleware/errorHandler';

async function buildApp(opts: { permPass?: boolean } = {}) {
  const { permPass = true } = opts;
  const app = express();
  app.use(express.json());

  const ticketRepo = new InMemoryTicketRepository();
  const commentRepo = new InMemoryTicketCommentRepository();
  const storage = new InMemoryFileStorage();
  const ticket = await ticketRepo.create({ subject: 'S', description: 'D', customerId: 'client-a' });

  const authPass: RequestHandler = (req, _res, next) => {
    (req as unknown as { user: unknown }).user = { id: 'staff-1', username: 'ana' };
    next();
  };
  const permGuard: RequestHandler = permPass
    ? (_req, _res, next) => next()
    : (_req, res) => { res.status(403).json({ error: 'Forbidden', code: 'FORBIDDEN' }); };

  app.use('/api/tickets', createTicketMessagesRouter(
    {
      sendStaffTicketReply: new SendStaffTicketReply(commentRepo, ticketRepo, storage),
      getTicketUnreadCount: new GetTicketUnreadCount(ticketRepo, commentRepo),
      getTicketMessageAttachmentFile: new GetTicketMessageAttachmentFile(commentRepo, storage),
    },
    authPass,
    { read: permGuard, write: permGuard },
  ));
  app.use(errorHandler);

  return { app, ticketId: ticket.id, commentRepo, ticketRepo };
}

describe('POST /api/tickets/:id/messages — respuesta PÚBLICA del staff', () => {
  it('scenario "Respuesta al cliente": crea el mensaje, SIEMPRE visibility=public (no está en la response, pero el efecto es verificable via el thread)', async () => {
    const { app, ticketId, commentRepo } = await buildApp();

    const res = await request(app)
      .post(`/api/tickets/${ticketId}/messages`)
      .send({ body: 'Ya lo estamos viendo' });

    expect(res.status).toBe(201);
    expect(res.body.authorKind).toBe('staff');
    expect(res.body.visibility).toBe('public');
    const stored = await commentRepo.listByTicket(ticketId);
    expect(stored[0]!.visibility).toBe('public');
    expect(stored[0]!.authorId).toBe('staff-1');
  });

  it('"visibility en el body NO cambia el resultado": mandar visibility:"internal" es RECHAZADO con 400, ruidoso', async () => {
    const { app, ticketId, commentRepo } = await buildApp();

    const res = await request(app)
      .post(`/api/tickets/${ticketId}/messages`)
      .send({ body: 'intento colar una nota interna', visibility: 'internal' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    // Nada se creó — el rechazo es upfront, no un "se ignoró el campo y siguió".
    expect(await commentRepo.listByTicket(ticketId)).toHaveLength(0);
  });

  it('mandar CUALQUIER campo desconocido -> 400 (mismo criterio .strict())', async () => {
    const { app, ticketId } = await buildApp();

    const res = await request(app)
      .post(`/api/tickets/${ticketId}/messages`)
      .send({ body: 'x', somethingUnexpected: true });

    expect(res.status).toBe(400);
  });

  it('404 para un ticket inexistente', async () => {
    const { app } = await buildApp();

    const res = await request(app).post('/api/tickets/missing/messages').send({ body: 'x' });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TICKET_NOT_FOUND');
  });

  it('403 sin tickets.write', async () => {
    const { app, ticketId } = await buildApp({ permPass: false });

    const res = await request(app).post(`/api/tickets/${ticketId}/messages`).send({ body: 'x' });

    expect(res.status).toBe(403);
  });

  it('scenario "Mensaje vacío": sin texto y sin adjuntos -> 400', async () => {
    const { app, ticketId } = await buildApp();

    const res = await request(app).post(`/api/tickets/${ticketId}/messages`).send({ body: '' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('TICKET_MESSAGE_VALIDATION');
  });

  it('scenario "Cliente manda una foto del módem" (acá: el staff adjunta una foto): 201 con el adjunto', async () => {
    const { app, ticketId } = await buildApp();

    const res = await request(app)
      .post(`/api/tickets/${ticketId}/messages`)
      .field('body', 'mirá cómo quedó')
      .attach('files', Buffer.from([0xff, 0xd8, 0xff, 0xd9]), { filename: 'foto.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(201);
    expect(res.body.attachments).toHaveLength(1);
    expect(res.body.attachments[0].kind).toBe('image');
    expect(res.body.attachments[0].url).toContain('/messages/attachments/');
  });

  it('scenario "Tipo no permitido": un ejecutable -> 415, nada se guarda', async () => {
    const { app, ticketId, commentRepo } = await buildApp();

    const res = await request(app)
      .post(`/api/tickets/${ticketId}/messages`)
      .field('body', 'x')
      .attach('files', Buffer.from('MZ'), { filename: 'virus.exe', contentType: 'application/x-msdownload' });

    expect(res.status).toBe(415);
    expect(await commentRepo.listByTicket(ticketId)).toHaveLength(0);
  });
});

describe('GET /api/tickets/:id/messages/unread-count', () => {
  it('devuelve el conteo de mensajes del cliente sin leer', async () => {
    const { app, ticketId, commentRepo } = await buildApp();
    await commentRepo.create({
      id: 'm1', ticketId, authorId: 'acc-1', authorKind: 'client', visibility: 'public',
      authorName: 'Cliente', body: 'sigue sin andar', createdAt: new Date().toISOString(), attachments: [],
    });

    const res = await request(app).get(`/api/tickets/${ticketId}/messages/unread-count`);

    expect(res.status).toBe(200);
    expect(res.body.unreadCount).toBe(1);
  });

  it('404 para ticket inexistente', async () => {
    const { app } = await buildApp();

    const res = await request(app).get('/api/tickets/missing/messages/unread-count');

    expect(res.status).toBe(404);
  });

  it('403 sin tickets.read', async () => {
    const { app, ticketId } = await buildApp({ permPass: false });

    const res = await request(app).get(`/api/tickets/${ticketId}/messages/unread-count`);

    expect(res.status).toBe(403);
  });
});

describe('GET /api/tickets/messages/attachments/:id/file', () => {
  it('sirve el binario con Content-Type correcto', async () => {
    const { app, ticketId } = await buildApp();
    const uploadRes = await request(app)
      .post(`/api/tickets/${ticketId}/messages`)
      .field('body', 'x')
      .attach('files', Buffer.from([0xff, 0xd8, 0xff, 0xd9]), { filename: 'foto.jpg', contentType: 'image/jpeg' });
    const attachmentId = uploadRes.body.attachments[0].id;

    const res = await request(app).get(`/api/tickets/messages/attachments/${attachmentId}/file`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
  });

  it('404 para un adjunto inexistente', async () => {
    const { app } = await buildApp();

    const res = await request(app).get('/api/tickets/messages/attachments/missing/file');

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TICKET_MESSAGE_ATTACHMENT_NOT_FOUND');
  });
});
