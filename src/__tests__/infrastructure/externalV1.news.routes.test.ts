/**
 * external-news — POST /api/external/v1/news (2nd external WRITE). Tests the FULL
 * seam: real CreateExternalNews use case + in-memory repos (NO mocking the use case —
 * CLAUDE.md rule). Covers auth, the curated ExternalNewsDto (no authorId leak), every
 * validation branch (400 type/shape vs 422 domain: category/link/too-many), the 503
 * unprovisioned-reporter guard, and the best-effort WhatsApp status in the 201 body.
 */
import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import { createExternalV1Router } from '../../infrastructure/http/routes/externalV1.routes';
import { createApiKeyMiddleware } from '../../infrastructure/http/middleware/apiKeyMiddleware';
import { CreateExternalNews } from '../../application/use-cases/CreateExternalNews';
import { CreateNewsPost } from '../../application/use-cases/CreateNewsPost';
import { AttachLinkToNews } from '../../application/use-cases/AttachLinkToNews';
import { BroadcastNewsToNoc } from '../../application/use-cases/BroadcastNewsToNoc';
import { BroadcastToNoc } from '../../application/use-cases/nocBroadcast/BroadcastToNoc';
import { InMemoryNewsPostRepository } from '../../infrastructure/adapters/in-memory/InMemoryNewsPostRepository';
import { InMemoryNewsCategoryRepository } from '../../infrastructure/adapters/in-memory/InMemoryNewsCategoryRepository';
import { InMemoryNewsPostAttachmentRepository } from '../../infrastructure/adapters/in-memory/InMemoryNewsPostAttachmentRepository';
import { InMemoryNocBroadcastConfigRepository } from '../../infrastructure/adapters/in-memory/InMemoryNocBroadcastConfigRepository';
import { InMemoryRbacUserRepository } from '../../infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import { NocBroadcastGateway } from '../../domain/ports/NocBroadcastGateway';
import { NocBroadcastNotConfiguredError } from '../../domain/errors/nocBroadcast';
import { bootstrapApiUser } from '../../infrastructure/bootstrap/bootstrapApiUser';
import { ListClients } from '../../application/use-cases/ListClients';
import { GetClientDetail } from '../../application/use-cases/GetClientDetail';

// Mock config so we control the API key without env vars (same pattern as tickets).
jest.mock('../../infrastructure/config', () => ({
  config: { externalApi: { apiKey: 'test-external-key' } },
}));

const TEST_KEY = 'test-external-key';

// Read use cases are required by the router signature but NOT exercised by POST /news.
const stubListClients = { execute: jest.fn() } as unknown as ListClients;
const stubGetClientDetail = { execute: jest.fn() } as unknown as GetClientDetail;

class FakeGateway implements NocBroadcastGateway {
  sent: string[] = [];
  error: Error | null = null;
  async sendText(text: string): Promise<void> {
    if (this.error) throw this.error;
    this.sent.push(text);
  }
}

interface BuildOpts {
  seedApiUser?: boolean;
  appPublicUrl?: string;
  gatewayError?: Error;
}

async function buildApp(opts: BuildOpts = {}) {
  const categoryRepo = new InMemoryNewsCategoryRepository();
  const postRepo = new InMemoryNewsPostRepository(categoryRepo);
  const attachmentRepo = new InMemoryNewsPostAttachmentRepository();
  await categoryRepo.create({ name: 'General', color: '#64748b' });

  const config = new InMemoryNocBroadcastConfigRepository();
  await config.update({ appPublicUrl: opts.appPublicUrl ?? 'http://panel.local' });
  const gateway = new FakeGateway();
  if (opts.gatewayError) gateway.error = opts.gatewayError;

  const createExternalNews = new CreateExternalNews(
    categoryRepo,
    new CreateNewsPost(postRepo, categoryRepo),
    new AttachLinkToNews(attachmentRepo, postRepo),
    new BroadcastNewsToNoc(postRepo, new BroadcastToNoc(config, gateway)),
  );

  const rbacUserRepo = new InMemoryRbacUserRepository();
  if (opts.seedApiUser !== false) {
    await bootstrapApiUser(rbacUserRepo, {
      passwordHash: '$2a$10$impossibleHashNeverLogsInXXXXXXXXXXXXXXXXXXXX',
    });
  }

  const app = express();
  app.use(express.json());
  app.use(
    '/api/external/v1',
    createApiKeyMiddleware(),
    createExternalV1Router(stubListClients, stubGetClientDetail, undefined, undefined, {
      createExternalNews,
      rbacUserRepo,
    }),
  );
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    res.status(500).json({ error: 'Internal server error' });
  });
  return { app, postRepo, gateway };
}

const validPayload = {
  title: 'Corte programado Zona Norte',
  body: 'Mantenimiento **hoy** 22:00',
  category: 'General',
};

describe('POST /api/external/v1/news (external-news — 2nd external WRITE)', () => {
  it('returns 401 without an API key', async () => {
    const { app } = await buildApp();
    const res = await request(app).post('/api/external/v1/news').send(validPayload);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
  });

  it('returns 201, creates the news, and returns a curated ExternalNewsDto', async () => {
    const { app, postRepo } = await buildApp();
    const res = await request(app)
      .post('/api/external/v1/news')
      .set('X-API-Key', TEST_KEY)
      .send({ ...validPayload, pinned: true });

    expect(res.status).toBe(201);
    expect(res.body.title).toBe('Corte programado Zona Norte');
    expect(res.body.category).toBe('General'); // NAME, not id
    expect(res.body.pinned).toBe(true);
    expect(res.body).toHaveProperty('id');
    expect(res.body).toHaveProperty('publishedAt');
    expect(res.body.attachments).toEqual([]);
    expect(res.body.whatsapp).toEqual({ requested: false, sent: false });

    const posts = await postRepo.list({}, 'x');
    expect(posts).toHaveLength(1);
  });

  it('curated DTO — does NOT leak internal fields', async () => {
    const { app } = await buildApp();
    const res = await request(app)
      .post('/api/external/v1/news')
      .set('X-API-Key', TEST_KEY)
      .send(validPayload);

    expect(res.status).toBe(201);
    expect(res.body).not.toHaveProperty('authorId');
    expect(res.body).not.toHaveProperty('authorName');
    expect(res.body).not.toHaveProperty('categoryId');
    expect(res.body).not.toHaveProperty('body');
  });

  it('attaches links and maps caller title → filename', async () => {
    const { app } = await buildApp();
    const res = await request(app)
      .post('/api/external/v1/news')
      .set('X-API-Key', TEST_KEY)
      .send({
        ...validPayload,
        links: [{ url: 'https://x.com/a', title: 'Nota A' }, { url: 'http://y.com/b' }],
      });

    expect(res.status).toBe(201);
    expect(res.body.attachments).toHaveLength(2);
    expect(res.body.attachments[0].url).toBe('https://x.com/a');
    expect(res.body.attachments[0].filename).toBe('Nota A');
  });

  it('returns 422 when the category name is unknown', async () => {
    const { app } = await buildApp();
    const res = await request(app)
      .post('/api/external/v1/news')
      .set('X-API-Key', TEST_KEY)
      .send({ ...validPayload, category: 'Inexistente' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('NEWS_CATEGORY_NOT_FOUND');
  });

  it('returns 400 when a required field is missing', async () => {
    const { app } = await buildApp();
    const { title, ...noTitle } = validPayload;
    void title;
    const res = await request(app)
      .post('/api/external/v1/news')
      .set('X-API-Key', TEST_KEY)
      .send(noTitle);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when title exceeds the max length', async () => {
    const { app } = await buildApp();
    const res = await request(app)
      .post('/api/external/v1/news')
      .set('X-API-Key', TEST_KEY)
      .send({ ...validPayload, title: 'x'.repeat(201) });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when body exceeds the max length', async () => {
    const { app } = await buildApp();
    const res = await request(app)
      .post('/api/external/v1/news')
      .set('X-API-Key', TEST_KEY)
      .send({ ...validPayload, body: 'x'.repeat(20001) });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when pinned is not a boolean', async () => {
    const { app } = await buildApp();
    const res = await request(app)
      .post('/api/external/v1/news')
      .set('X-API-Key', TEST_KEY)
      .send({ ...validPayload, pinned: 'yes' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when sendToWhatsapp is not a boolean', async () => {
    const { app } = await buildApp();
    const res = await request(app)
      .post('/api/external/v1/news')
      .set('X-API-Key', TEST_KEY)
      .send({ ...validPayload, sendToWhatsapp: 'sí' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when links is not an array', async () => {
    const { app } = await buildApp();
    const res = await request(app)
      .post('/api/external/v1/news')
      .set('X-API-Key', TEST_KEY)
      .send({ ...validPayload, links: 'https://x.com' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when a link url is not a string', async () => {
    const { app } = await buildApp();
    const res = await request(app)
      .post('/api/external/v1/news')
      .set('X-API-Key', TEST_KEY)
      .send({ ...validPayload, links: [{ url: 123 }] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('returns 422 when there are more than 20 links', async () => {
    const { app } = await buildApp();
    const links = Array.from({ length: 21 }, (_, i) => ({ url: `https://x.com/${i}` }));
    const res = await request(app)
      .post('/api/external/v1/news')
      .set('X-API-Key', TEST_KEY)
      .send({ ...validPayload, links });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('TOO_MANY_NEWS_ATTACHMENTS');
  });

  it('returns 422 when a link url is not http(s)', async () => {
    const { app } = await buildApp();
    const res = await request(app)
      .post('/api/external/v1/news')
      .set('X-API-Key', TEST_KEY)
      .send({ ...validPayload, links: [{ url: 'ftp://bad' }] });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INVALID_LINK_ATTACHMENT');
  });

  // L2 — length caps on link.url / link.title (symmetric with title/body caps).
  it('returns 400 when a link url exceeds the max length (2048)', async () => {
    const { app } = await buildApp();
    const longUrl = 'https://x.com/' + 'a'.repeat(2100); // valid http(s) but too long
    const res = await request(app)
      .post('/api/external/v1/news')
      .set('X-API-Key', TEST_KEY)
      .send({ ...validPayload, links: [{ url: longUrl }] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when a link title exceeds the max length (200)', async () => {
    const { app } = await buildApp();
    const res = await request(app)
      .post('/api/external/v1/news')
      .set('X-API-Key', TEST_KEY)
      .send({ ...validPayload, links: [{ url: 'https://x.com/a', title: 'x'.repeat(201) }] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  // L4 — the external attachment view must NOT leak uploadedById (= system "api" user
  // id) nor newsPostId (redundant with the post id). Allow-list projection.
  it('attachments[] in the 201 body do NOT leak uploadedById/newsPostId', async () => {
    const { app } = await buildApp();
    const res = await request(app)
      .post('/api/external/v1/news')
      .set('X-API-Key', TEST_KEY)
      .send({ ...validPayload, links: [{ url: 'https://x.com/a', title: 'Nota A' }] });

    expect(res.status).toBe(201);
    expect(res.body.attachments).toHaveLength(1);
    const att = res.body.attachments[0];
    expect(att).not.toHaveProperty('uploadedById');
    expect(att).not.toHaveProperty('newsPostId');
    // Safe fields present.
    expect(att).toHaveProperty('id');
    expect(att.kind).toBe('link');
    expect(att.filename).toBe('Nota A');
    expect(att.url).toBe('https://x.com/a');
    expect(att).toHaveProperty('fileUrl');
    expect(att).toHaveProperty('createdAt');
  });

  it('returns 503 when the system "api" reporter is not provisioned', async () => {
    const { app } = await buildApp({ seedApiUser: false });
    const res = await request(app)
      .post('/api/external/v1/news')
      .set('X-API-Key', TEST_KEY)
      .send(validPayload);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('REPORTER_UNAVAILABLE');
  });

  it('sendToWhatsapp true + gateway ok → 201 with whatsapp.sent true', async () => {
    const { app, gateway } = await buildApp();
    const res = await request(app)
      .post('/api/external/v1/news')
      .set('X-API-Key', TEST_KEY)
      .send({ ...validPayload, sendToWhatsapp: true });

    expect(res.status).toBe(201);
    expect(res.body.whatsapp.requested).toBe(true);
    expect(res.body.whatsapp.sent).toBe(true);
    expect(res.body.whatsapp.link).toContain('/admin/news?post=');
    expect(gateway.sent).toHaveLength(1);
  });

  it('sendToWhatsapp true + gateway not configured → 201 best-effort (whatsapp.sent false + error)', async () => {
    const { app } = await buildApp({ gatewayError: new NocBroadcastNotConfiguredError() });
    const res = await request(app)
      .post('/api/external/v1/news')
      .set('X-API-Key', TEST_KEY)
      .send({ ...validPayload, sendToWhatsapp: true });

    expect(res.status).toBe(201);
    expect(res.body.whatsapp).toEqual({
      requested: true,
      sent: false,
      error: 'NOC_BROADCAST_NOT_CONFIGURED',
    });
  });
});
