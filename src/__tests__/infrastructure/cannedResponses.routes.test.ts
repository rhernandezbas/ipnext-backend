/**
 * Ola 4 (inbox-Chatwoot) — `/api/messaging/canned-responses` route integration tests.
 * SEAM COMPLETO: use cases REALES (Create/Update/Delete/List) + `InMemoryCannedResponseRepository`
 * + `errorHandler` REAL — NUNCA se mockea un use case (mismo convenio que templates.routes.test.ts).
 *
 * RBAC doble capa: GET (lista/picker) = messaging:read (cualquier agente USA las respuestas);
 * POST/PUT/DELETE (gestión) = messaging:manage (SOLO supervisores CREAN/editan/borran).
 */
import request from 'supertest';
import express, { Request, Response, NextFunction, RequestHandler } from 'express';
import {
  createCannedResponsesRouter,
  CannedResponsesRoutePerms,
} from '@infrastructure/http/routes/cannedResponses.routes';
import { errorHandler } from '@infrastructure/http/middleware/errorHandler';
import { InMemoryCannedResponseRepository } from '@infrastructure/adapters/in-memory/InMemoryCannedResponseRepository';
import { CreateCannedResponse } from '@application/use-cases/messaging/CreateCannedResponse';
import { UpdateCannedResponse } from '@application/use-cases/messaging/UpdateCannedResponse';
import { DeleteCannedResponse } from '@application/use-cases/messaging/DeleteCannedResponse';
import { ListCannedResponses } from '@application/use-cases/messaging/ListCannedResponses';

const allowAuth = (req: Request, _res: Response, next: NextFunction) => {
  (req as unknown as { user: { id: string; username: string } }).user = { id: 'user-test', username: 'agente' };
  next();
};
const denyAuth: RequestHandler = (_req, res) => {
  res.status(401).json({ error: 'UNAUTHORIZED', code: 'NO_USER_CONTEXT' });
};
const allowPerm: RequestHandler = (_req, _res, next) => next();
const denyPerm: RequestHandler = (_req, res) => {
  res.status(403).json({ error: 'FORBIDDEN', code: 'PERMISSION_DENIED' });
};

interface BuildAppOptions {
  readPerm?: RequestHandler;
  managePerm?: RequestHandler;
  auth?: RequestHandler;
}

function buildApp(opts: BuildAppOptions = {}) {
  const repo = new InMemoryCannedResponseRepository();
  const perms: CannedResponsesRoutePerms = {
    read: opts.readPerm ?? allowPerm,
    manage: opts.managePerm ?? allowPerm,
  };
  const app = express();
  app.use(express.json());
  app.use(
    '/api/messaging/canned-responses',
    createCannedResponsesRouter(
      new ListCannedResponses(repo),
      new CreateCannedResponse(repo),
      new UpdateCannedResponse(repo),
      new DeleteCannedResponse(repo),
      opts.auth ?? allowAuth,
      perms,
    ),
  );
  app.use(errorHandler);
  return { app, repo };
}

const BASE = '/api/messaging/canned-responses';

// ─── Auth ────────────────────────────────────────────────────────────────────
describe(`${BASE} — auth`, () => {
  it('sin auth → 401', async () => {
    const { app } = buildApp({ auth: denyAuth });
    const res = await request(app).get(BASE);
    expect(res.status).toBe(401);
  });
});

// ─── GET / (list) — RBAC read=messaging:read ─────────────────────────────────
describe(`${BASE} — GET / (list)`, () => {
  it('200 {data:[...]} ordenado por shortcut', async () => {
    const { app } = buildApp();
    await request(app).post(BASE).send({ shortcut: 'zeta', content: 'z' });
    await request(app).post(BASE).send({ shortcut: 'alfa', content: 'a' });
    const res = await request(app).get(BASE);
    expect(res.status).toBe(200);
    expect(res.body.data.map((c: { shortcut: string }) => c.shortcut)).toEqual(['alfa', 'zeta']);
  });

  it('?q= filtra por shortcut o content', async () => {
    const { app } = buildApp();
    await request(app).post(BASE).send({ shortcut: 'saludo', content: 'Hola gracias' });
    await request(app).post(BASE).send({ shortcut: 'despedida', content: 'Chau' });
    const bySc = await request(app).get(`${BASE}?q=sal`);
    expect(bySc.body.data.map((c: { shortcut: string }) => c.shortcut)).toEqual(['saludo']);
    const byContent = await request(app).get(`${BASE}?q=gracias`);
    expect(byContent.body.data.map((c: { shortcut: string }) => c.shortcut)).toEqual(['saludo']);
  });

  it('sin messaging:read → 403', async () => {
    const { app } = buildApp({ readPerm: denyPerm });
    const res = await request(app).get(BASE);
    expect(res.status).toBe(403);
  });
});

// ─── POST / (create) — RBAC write=messaging:manage ───────────────────────────
describe(`${BASE} — POST / (create)`, () => {
  it('input válido → 201 DTO con shortcut normalizado + createdById del usuario', async () => {
    const { app } = buildApp();
    const res = await request(app).post(BASE).send({ shortcut: '  Saludo Cliente ', content: 'Hola, gracias' });
    expect(res.status).toBe(201);
    expect(res.body.shortcut).toBe('saludo-cliente');
    expect(res.body.content).toBe('Hola, gracias');
    expect(res.body.createdById).toBe('user-test');
    expect(res.body.id).toBeTruthy();
  });

  it('shortcut duplicado → 409 SHORTCUT_TAKEN', async () => {
    const { app } = buildApp();
    await request(app).post(BASE).send({ shortcut: 'saludo', content: 'a' });
    const res = await request(app).post(BASE).send({ shortcut: 'SALUDO', content: 'b' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SHORTCUT_TAKEN');
  });

  it('content vacío → 400 VALIDATION_ERROR', async () => {
    const { app, repo } = buildApp();
    const res = await request(app).post(BASE).send({ shortcut: 'saludo', content: '' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(await repo.list()).toHaveLength(0);
  });

  it('body inválido (shortcut no-string) → 400 VALIDATION_ERROR (Zod)', async () => {
    const { app } = buildApp();
    const res = await request(app).post(BASE).send({ shortcut: 123, content: 'a' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('sin messaging:manage → 403 (agente común NO puede crear)', async () => {
    const { app } = buildApp({ managePerm: denyPerm });
    const res = await request(app).post(BASE).send({ shortcut: 'saludo', content: 'a' });
    expect(res.status).toBe(403);
  });

  it('RBAC: con messaging:read pero SIN messaging:manage → GET 200 pero POST 403', async () => {
    const { app } = buildApp({ readPerm: allowPerm, managePerm: denyPerm });
    expect((await request(app).get(BASE)).status).toBe(200);
    expect((await request(app).post(BASE).send({ shortcut: 'x', content: 'y' })).status).toBe(403);
  });
});

// ─── PUT /:id (update) — RBAC write=messaging:manage ─────────────────────────
describe(`${BASE} — PUT /:id (update)`, () => {
  it('input válido → 200 DTO actualizado', async () => {
    const { app } = buildApp();
    const created = await request(app).post(BASE).send({ shortcut: 'saludo', content: 'viejo' });
    const res = await request(app).put(`${BASE}/${created.body.id}`).send({ content: 'nuevo' });
    expect(res.status).toBe(200);
    expect(res.body.content).toBe('nuevo');
    expect(res.body.shortcut).toBe('saludo');
  });

  it('id inexistente → 404 CANNED_RESPONSE_NOT_FOUND', async () => {
    const { app } = buildApp();
    const res = await request(app).put(`${BASE}/nope`).send({ content: 'x' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CANNED_RESPONSE_NOT_FOUND');
  });

  it('body vacío (ni shortcut ni content) → 400 VALIDATION_ERROR (Zod)', async () => {
    const { app } = buildApp();
    const created = await request(app).post(BASE).send({ shortcut: 'saludo', content: 'a' });
    const res = await request(app).put(`${BASE}/${created.body.id}`).send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('sin messaging:manage → 403', async () => {
    const { app } = buildApp({ managePerm: denyPerm });
    const res = await request(app).put(`${BASE}/anything`).send({ content: 'x' });
    expect(res.status).toBe(403);
  });
});

// ─── DELETE /:id — RBAC write=messaging:manage ───────────────────────────────
describe(`${BASE} — DELETE /:id`, () => {
  it('existe → 204, borra', async () => {
    const { app, repo } = buildApp();
    const created = await request(app).post(BASE).send({ shortcut: 'saludo', content: 'a' });
    const res = await request(app).delete(`${BASE}/${created.body.id}`);
    expect(res.status).toBe(204);
    expect(await repo.list()).toHaveLength(0);
  });

  it('id inexistente → 404 CANNED_RESPONSE_NOT_FOUND', async () => {
    const { app } = buildApp();
    const res = await request(app).delete(`${BASE}/nope`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CANNED_RESPONSE_NOT_FOUND');
  });

  it('sin messaging:manage → 403', async () => {
    const { app } = buildApp({ managePerm: denyPerm });
    const res = await request(app).delete(`${BASE}/anything`);
    expect(res.status).toBe(403);
  });
});
