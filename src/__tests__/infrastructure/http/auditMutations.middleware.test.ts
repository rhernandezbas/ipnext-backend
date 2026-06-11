/**
 * Tests for the generic mutation-audit middleware (SDD #4 Phase 2).
 * Builds a minimal Express app + in-memory repo and asserts what gets recorded.
 */
import request from 'supertest';
import express from 'express';
import { InMemoryAuditEventRepository } from '@infrastructure/adapters/in-memory/InMemoryAuditEventRepository';
import {
  auditMutationsMiddleware,
  maskSensitive,
} from '@infrastructure/http/middleware/auditMutationsMiddleware';

const flush = () => new Promise(resolve => setImmediate(resolve));

function buildApp(opts: { withUser?: boolean; emitOnUsers?: boolean } = {}) {
  const { withUser = true, emitOnUsers = false } = opts;
  const app = express();
  app.use(express.json());
  const repo = new InMemoryAuditEventRepository();

  if (withUser) {
    app.use((req, _res, next) => {
      (req as express.Request & { user?: unknown }).user = { id: 'u1', username: 'ana', email: 'a@x' };
      next();
    });
  }

  app.use(auditMutationsMiddleware(repo));

  app.post('/api/test', (req, res) => { res.status(201).json({ id: 'x1', ...req.body }); });
  app.get('/api/test', (_req, res) => { res.status(200).json({ ok: true }); });
  app.post('/api/fail', (_req, res) => { res.status(403).json({ error: 'forbidden', code: 'FORBIDDEN' }); });
  app.post('/api/users', (req, res) => {
    if (emitOnUsers) res.locals['__auditEmitted'] = true; // simulate a use-case emit
    res.status(201).json({ id: 'u9', login: req.body.login });
  });

  return { app, repo };
}

describe('auditMutationsMiddleware', () => {
  it('records one event for a successful mutation', async () => {
    const { app, repo } = buildApp();
    await request(app).post('/api/test').send({ name: 'a' });
    await flush();

    const page = await repo.list({ page: 1, pageSize: 10 });
    expect(page.total).toBe(1);
    const ev = page.items[0];
    expect(ev).toMatchObject({
      method: 'POST',
      statusCode: 201,
      actorId: 'u1',
      actorLogin: 'ana',
      errorMessage: null,
    });
    expect(ev.path).toContain('/api/test');
    expect(ev.afterJson).toMatchObject({ id: 'x1', name: 'a' });
  });

  it('does NOT audit GET requests', async () => {
    const { app, repo } = buildApp();
    await request(app).get('/api/test');
    await flush();
    const page = await repo.list({ page: 1, pageSize: 10 });
    expect(page.total).toBe(0);
  });

  it('records failed mutations with statusCode and errorMessage', async () => {
    const { app, repo } = buildApp();
    await request(app).post('/api/fail').send({});
    await flush();

    const page = await repo.list({ page: 1, pageSize: 10 });
    expect(page.total).toBe(1);
    expect(page.items[0]).toMatchObject({ statusCode: 403, errorMessage: 'forbidden', afterJson: null });
  });

  it('records actorLogin "anonymous" / actorId null when there is no req.user', async () => {
    const { app, repo } = buildApp({ withUser: false });
    await request(app).post('/api/test').send({ name: 'a' });
    await flush();

    const ev = (await repo.list({ page: 1, pageSize: 10 })).items[0];
    expect(ev.actorId).toBeNull();
    expect(ev.actorLogin).toBe('anonymous');
  });

  it('masks sensitive keys in the captured body (password never persisted)', async () => {
    const { app, repo } = buildApp();
    await request(app).post('/api/users').send({ login: 'bob', password: 'secreto' });
    await flush();

    const ev = (await repo.list({ page: 1, pageSize: 10 })).items[0];
    expect((ev.beforeJson as Record<string, unknown>)['login']).toBe('bob');
    expect((ev.beforeJson as Record<string, unknown>)['password']).toBe('***');
    expect(JSON.stringify(ev.beforeJson)).not.toContain('secreto');
  });

  it('does NOT create a generic event when a use case already emitted (dedupe)', async () => {
    const { app, repo } = buildApp({ emitOnUsers: true });
    await request(app).post('/api/users').send({ login: 'bob' });
    await flush();

    const page = await repo.list({ page: 1, pageSize: 10 });
    expect(page.total).toBe(0); // the generic middleware skipped it
  });

  it('elides huge data-URI attachments from the audit (request body and response)', async () => {
    const { app, repo } = buildApp();
    // ~50KB base64 data-URI: well above the 1KB elision threshold, but under the
    // default express.json 100KB limit so the request reaches the handler.
    const bigDataUri = `data:image/png;base64,${'A'.repeat(50_000)}`;
    await request(app)
      .post('/api/test')
      .send({ body: 'hola', attachments: [{ url: bigDataUri, filename: 's.png' }] });
    await flush();

    const ev = (await repo.list({ page: 1, pageSize: 10 })).items[0];

    // The base64 payload must NOT be persisted, in neither before nor after.
    const beforeStr = JSON.stringify(ev.beforeJson);
    const afterStr = JSON.stringify(ev.afterJson);
    expect(beforeStr).not.toContain('AAAA');
    expect(afterStr).not.toContain('AAAA');
    // The rest of the body is still audited.
    const before = ev.beforeJson as Record<string, unknown>;
    expect(before['body']).toBe('hola');
    const att = (before['attachments'] as Array<Record<string, unknown>>)[0];
    expect(att['filename']).toBe('s.png');
    // The elided url is a short placeholder that records the original byte length.
    expect(typeof att['url']).toBe('string');
    expect((att['url'] as string).length).toBeLessThan(100);
    expect(att['url']).toContain('elided');
    // The 201 response (which echoes the body) is elided too.
    expect(afterStr).toContain('elided');
  });
});

describe('maskSensitive', () => {
  it('replaces sensitive values with *** at the top level', () => {
    expect(maskSensitive({ password: 'x', a: 1 })).toEqual({ password: '***', a: 1 });
  });

  it('masks nested objects and arrays', () => {
    expect(maskSensitive({ user: { token: 't', name: 'n' } })).toEqual({ user: { token: '***', name: 'n' } });
    expect(maskSensitive([{ secret: 's' }])).toEqual([{ secret: '***' }]);
  });

  it('is null/undefined safe and leaves non-sensitive data intact', () => {
    expect(maskSensitive(null)).toBeNull();
    expect(maskSensitive(undefined)).toBeUndefined();
    expect(maskSensitive({ a: 1, b: 'ok' })).toEqual({ a: 1, b: 'ok' });
  });

  it('elides large data: URIs regardless of key name (generic)', () => {
    const big = `data:image/png;base64,${'A'.repeat(5000)}`;
    const out = maskSensitive({ anyKey: big }) as Record<string, unknown>;
    expect(out['anyKey']).not.toContain('AAAA');
    expect(out['anyKey']).toContain('elided');
    // Placeholder reports the original length in bytes.
    expect(out['anyKey']).toContain(String(big.length));
  });

  it('leaves small data: URIs untouched (below threshold)', () => {
    const small = 'data:image/png;base64,AAAA';
    expect(maskSensitive({ url: small })).toEqual({ url: small });
  });

  it('does not elide ordinary long strings that are not data: URIs', () => {
    const long = 'x'.repeat(5000);
    expect(maskSensitive({ note: long })).toEqual({ note: long });
  });
});
