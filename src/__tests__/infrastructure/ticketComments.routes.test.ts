import request from 'supertest';
import express, { RequestHandler } from 'express';
import { AddTicketComment } from '../../application/use-cases/AddTicketComment';
import { ListTicketComments } from '../../application/use-cases/ListTicketComments';
import { InMemoryTicketCommentRepository } from '../../infrastructure/adapters/in-memory/InMemoryTicketCommentRepository';
import { InMemoryTicketRepository } from '../../infrastructure/adapters/in-memory/InMemoryTicketRepository';
import { createTicketCommentsRouter } from '../../infrastructure/http/routes/ticketComments.routes';
import { errorHandler } from '../../infrastructure/http/middleware/errorHandler';

// Small valid data-URI: "AAAA" decodes to 3 bytes (no padding).
const SMALL_IMG = { url: 'data:image/png;base64,AAAA', filename: 's.png', mimeType: 'image/png', sizeBytes: 3 };

async function buildApp(opts: { permPass?: boolean; jsonLimit?: string } = {}) {
  const { permPass = true, jsonLimit } = opts;
  const app = express();
  app.use(express.json(jsonLimit ? { limit: jsonLimit } : {}));

  const commentRepo = new InMemoryTicketCommentRepository();
  const ticketRepo = new InMemoryTicketRepository();
  const ticket = await ticketRepo.create({ subject: 'S', description: 'D' });

  const addComment = new AddTicketComment(commentRepo, ticketRepo);
  const listComments = new ListTicketComments(commentRepo, ticketRepo);

  const authPass: RequestHandler = (req, _res, next) => {
    (req as unknown as { user: unknown }).user = { id: 'u1', username: 'tester' };
    next();
  };
  const permGuard: RequestHandler = permPass
    ? (_req, _res, next) => next()
    : (_req, res) => { res.status(403).json({ error: 'Forbidden', code: 'FORBIDDEN' }); };

  app.use('/api/tickets', createTicketCommentsRouter(
    listComments, addComment, authPass,
    { read: permGuard, write: permGuard },
  ));
  app.use(errorHandler);

  return { app, ticketId: ticket.id, commentRepo };
}

describe('GET /api/tickets/:id/comments', () => {
  it('returns 200 with empty array for a ticket with no comments', async () => {
    const { app, ticketId } = await buildApp();
    const res = await request(app).get(`/api/tickets/${ticketId}/comments`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('returns 404 for a non-existent ticket', async () => {
    const { app } = await buildApp();
    const res = await request(app).get('/api/tickets/missing/comments');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TICKET_NOT_FOUND');
  });

  it('returns 403 without tickets.read', async () => {
    const { app, ticketId } = await buildApp({ permPass: false });
    const res = await request(app).get(`/api/tickets/${ticketId}/comments`);
    expect(res.status).toBe(403);
  });
});

describe('POST /api/tickets/:id/comments', () => {
  it('returns 201 with the created comment', async () => {
    const { app, ticketId } = await buildApp();
    const res = await request(app)
      .post(`/api/tickets/${ticketId}/comments`)
      .send({ body: 'Revisado', authorName: 'Admin', attachments: [] });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
    expect(res.body.ticketId).toBe(ticketId);
    expect(res.body.body).toBe('Revisado');
    expect(res.body.authorName).toBe('Admin');
    expect(Array.isArray(res.body.attachments)).toBe(true);
  });

  it('falls back to req.user.username when authorName is omitted', async () => {
    const { app, ticketId } = await buildApp();
    const res = await request(app)
      .post(`/api/tickets/${ticketId}/comments`)
      .send({ body: 'hi', attachments: [] });
    expect(res.status).toBe(201);
    expect(res.body.authorName).toBe('tester');
  });

  it('returns 404 for a non-existent ticket', async () => {
    const { app } = await buildApp();
    const res = await request(app)
      .post('/api/tickets/missing/comments')
      .send({ body: 'hi', attachments: [] });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TICKET_NOT_FOUND');
  });

  it('returns 422 for >3 attachments', async () => {
    const { app, ticketId } = await buildApp();
    const res = await request(app)
      .post(`/api/tickets/${ticketId}/comments`)
      .send({ body: 'x', attachments: [SMALL_IMG, SMALL_IMG, SMALL_IMG, SMALL_IMG] });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('returns 422 for a non-image mimeType', async () => {
    const { app, ticketId } = await buildApp();
    const res = await request(app)
      .post(`/api/tickets/${ticketId}/comments`)
      .send({ attachments: [{ url: 'data:application/pdf;base64,AAAA', filename: 'd.pdf', mimeType: 'application/pdf', sizeBytes: 3 }] });
    expect(res.status).toBe(422);
  });

  it('returns 422 for a malformed data-URI', async () => {
    const { app, ticketId } = await buildApp();
    const res = await request(app)
      .post(`/api/tickets/${ticketId}/comments`)
      .send({ attachments: [{ url: 'notadatauri', filename: 's.png', mimeType: 'image/png', sizeBytes: 3 }] });
    expect(res.status).toBe(422);
  });

  it('returns 422 when body and attachments are both empty', async () => {
    const { app, ticketId } = await buildApp();
    const res = await request(app)
      .post(`/api/tickets/${ticketId}/comments`)
      .send({ body: '   ', attachments: [] });
    expect(res.status).toBe(422);
  });

  it('returns 403 without tickets.write', async () => {
    const { app, ticketId } = await buildApp({ permPass: false });
    const res = await request(app)
      .post(`/api/tickets/${ticketId}/comments`)
      .send({ body: 'hi', attachments: [] });
    expect(res.status).toBe(403);
  });

  it('F2 (fix wave): mandar visibility+authorKind en el body -> RECHAZADO RUIDOSO, nunca se ignora en silencio', async () => {
    const { app, ticketId, commentRepo } = await buildApp();
    const res = await request(app)
      .post(`/api/tickets/${ticketId}/comments`)
      .send({ body: 'nota', visibility: 'public', authorKind: 'client' });

    // 422/VALIDATION_ERROR es el contrato YA establecido de ESTA ruta para
    // cualquier fallo de este schema (ver ">3 attachments" / "mimeType no
    // permitido" arriba) — .strict() se suma a ese mismo contrato en vez de
    // introducir un 400 especial para un solo campo. Lo que importa para F2 es
    // que deje de ser 201 con el campo ignorado en silencio.
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    // Nada se creó — el rechazo es upfront, no "se ignoró el campo y siguió" (que
    // era el bug: 201 con el comentario quedando internal de todos modos).
    expect(await commentRepo.listByTicket(ticketId)).toHaveLength(0);
  });

  it('F2 (fix wave): CUALQUIER campo desconocido en el body -> 422 (mismo criterio .strict() que las otras dos rutas)', async () => {
    const { app, ticketId } = await buildApp();
    const res = await request(app)
      .post(`/api/tickets/${ticketId}/comments`)
      .send({ body: 'x', somethingUnexpected: true });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('returns 413 when the JSON body exceeds the parser limit', async () => {
    const { app, ticketId } = await buildApp({ jsonLimit: '1kb' });
    const big = 'x'.repeat(2048);
    const res = await request(app)
      .post(`/api/tickets/${ticketId}/comments`)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ body: big, attachments: [] }));
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('PAYLOAD_TOO_LARGE');
  });
});
