/**
 * #44 DEBT — dual-parser e2e guard.
 *
 * Prod (app.ts) registers a path-scoped `express.json({ limit: '8mb' })` on the
 * comments path BEFORE the global `express.json()` (default 100kb). The scoped
 * parser must (a) accept comment bodies far above the global 100kb limit (image
 * data-URIs are big), and (b) still enforce its own 8mb ceiling with a 413.
 *
 * The skip-assumption worth closing: body-parser sets `req._body` after the first
 * parse and the global parser SKIPS a second parse — so the scoped parser is the
 * one that actually reads the comments body. This mounts BOTH parsers in PROD
 * ORDER on a minimal app replica with the REAL router and exercises both ends:
 *   - a ~200KB valid image comment → 201 (the scoped 8mb parser handled >100kb)
 *   - a >8MB body                  → 413 (the scoped 8mb ceiling fired)
 */
import request from 'supertest';
import express, { RequestHandler } from 'express';
import { AddTicketComment } from '../../application/use-cases/AddTicketComment';
import { ListTicketComments } from '../../application/use-cases/ListTicketComments';
import { InMemoryTicketCommentRepository } from '../../infrastructure/adapters/in-memory/InMemoryTicketCommentRepository';
import { InMemoryTicketRepository } from '../../infrastructure/adapters/in-memory/InMemoryTicketRepository';
import { createTicketCommentsRouter } from '../../infrastructure/http/routes/ticketComments.routes';
import { errorHandler } from '../../infrastructure/http/middleware/errorHandler';

/**
 * Build a valid PNG data-URI attachment of EXACTLY `bytes` decoded bytes, with the
 * DTO's required invariants: data-URI mime matches mimeType, real size === sizeBytes.
 * Base64 grows by 4/3, so a 200KB image yields a ~273KB JSON body — well over the
 * global 100kb limit, proving the scoped parser is the one reading the body.
 */
function imageAttachment(bytes: number) {
  // "A" repeated → decodes to 0x00 bytes; length must be a multiple of 4 with no
  // padding so the decoded length is exactly (len*3/4) === bytes.
  const b64 = 'A'.repeat(Math.ceil(bytes / 3) * 4);
  const real = Math.floor((b64.length * 3) / 4); // no padding → exact
  return {
    url: `data:image/png;base64,${b64}`,
    filename: 'big.png',
    mimeType: 'image/png',
    sizeBytes: real,
  };
}

/** Mount the two parsers in PROD ORDER (scoped 8mb BEFORE global default) + the real router. */
async function buildProdReplica() {
  const app = express();

  // PROD ORDER (mirrors app.ts): path-scoped 8mb parser FIRST, then the global parser.
  app.use('/api/tickets/:ticketId/comments', express.json({ limit: '8mb' }));
  app.use(express.json()); // default 100kb — must NOT win for the comments path

  const commentRepo = new InMemoryTicketCommentRepository();
  const ticketRepo = new InMemoryTicketRepository();
  const ticket = await ticketRepo.create({ subject: 'S', description: 'D' });

  const addComment = new AddTicketComment(commentRepo, ticketRepo);
  const listComments = new ListTicketComments(commentRepo, ticketRepo);

  const authPass: RequestHandler = (req, _res, next) => {
    (req as unknown as { user: unknown }).user = { id: 'u1', username: 'tester' };
    next();
  };
  const permPass: RequestHandler = (_req, _res, next) => next();

  app.use('/api/tickets', createTicketCommentsRouter(
    listComments, addComment, authPass,
    { read: permPass, write: permPass },
  ));
  app.use(errorHandler);

  return { app, ticketId: ticket.id };
}

describe('Ticket comments dual-parser e2e (#44 debt)', () => {
  it('accepts a ~200KB valid image comment (>100kb global limit) → 201', async () => {
    const { app, ticketId } = await buildProdReplica();
    const attachment = imageAttachment(200 * 1024); // 200KB decoded → ~273KB JSON body

    const res = await request(app)
      .post(`/api/tickets/${ticketId}/comments`)
      .send({ body: 'foto del nodo', attachments: [attachment] });

    expect(res.status).toBe(201);
    expect(res.body.attachments).toHaveLength(1);
    expect(res.body.attachments[0].sizeBytes).toBe(attachment.sizeBytes);
  });

  it('rejects a >8MB body with 413 (the scoped 8mb ceiling fires)', async () => {
    const { app, ticketId } = await buildProdReplica();
    // 9MB of plain text in `body` — no per-field cap, so this trips the parser
    // ceiling, not a validation rule.
    const huge = 'x'.repeat(9 * 1024 * 1024);

    const res = await request(app)
      .post(`/api/tickets/${ticketId}/comments`)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ body: huge, attachments: [] }));

    expect(res.status).toBe(413);
    expect(res.body.code).toBe('PAYLOAD_TOO_LARGE');
  });
});
