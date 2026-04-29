import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import { InMemorySettingsRepository } from '../../infrastructure/adapters/in-memory/InMemorySettingsRepository';
import { GetSystemSettings } from '../../application/use-cases/GetSystemSettings';
import { UpdateSystemSettings } from '../../application/use-cases/UpdateSystemSettings';
import { GetEmailSettings } from '../../application/use-cases/GetEmailSettings';
import { UpdateEmailSettings } from '../../application/use-cases/UpdateEmailSettings';
import { ListTemplates } from '../../application/use-cases/ListTemplates';
import { UpdateTemplate } from '../../application/use-cases/UpdateTemplate';
import { ListApiTokens } from '../../application/use-cases/ListApiTokens';
import { CreateApiToken } from '../../application/use-cases/CreateApiToken';
import { RevokeApiToken } from '../../application/use-cases/RevokeApiToken';
import { createSettingsRouter } from '../../infrastructure/http/routes/settings.routes';

function buildApp() {
  const app = express();
  app.use(express.json());

  const repo = new InMemorySettingsRepository();
  const getSystemSettings = new GetSystemSettings(repo);
  const updateSystemSettings = new UpdateSystemSettings(repo);
  const getEmailSettings = new GetEmailSettings(repo);
  const updateEmailSettings = new UpdateEmailSettings(repo);
  const listTemplates = new ListTemplates(repo);
  const updateTemplate = new UpdateTemplate(repo);
  const listApiTokens = new ListApiTokens(repo);
  const createApiToken = new CreateApiToken(repo);
  const revokeApiToken = new RevokeApiToken(repo);

  app.use(
    '/api/settings',
    createSettingsRouter(
      getSystemSettings,
      updateSystemSettings,
      getEmailSettings,
      updateEmailSettings,
      listTemplates,
      updateTemplate,
      listApiTokens,
      createApiToken,
      revokeApiToken,
    ),
  );

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

describe('GET /api/settings/system', () => {
  it('returns 200 with system settings', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/settings/system');

    expect(res.status).toBe(200);
    expect(res.body.companyName).toBe('IPNEXT SA');
    expect(res.body.timezone).toBe('America/Argentina/Buenos_Aires');
  });
});

describe('PUT /api/settings/system', () => {
  it('returns 200 with updated data', async () => {
    const app = buildApp();
    const res = await request(app)
      .put('/api/settings/system')
      .send({ companyName: 'NUEVO NOMBRE SA' });

    expect(res.status).toBe(200);
    expect(res.body.companyName).toBe('NUEVO NOMBRE SA');
  });
});

describe('GET /api/settings/templates', () => {
  it('returns 200 with array of templates', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/settings/templates');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(3);
  });
});

describe('GET /api/settings/api-tokens', () => {
  it('returns 200 with tokens array', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/settings/api-tokens');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(2);
  });
});

describe('POST /api/settings/api-tokens', () => {
  it('returns 201 with new token', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/settings/api-tokens')
      .send({ name: 'Test Token', permissions: ['read:clients'] });

    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
    expect(res.body.name).toBe('Test Token');
    expect(res.body.permissions).toContain('read:clients');
  });
});

describe('GET /api/settings/template-variables', () => {
  it('returns 200 with variables grouped by type', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/settings/template-variables');

    expect(res.status).toBe(200);
    expect(res.body.welcome).toBeDefined();
    expect(Array.isArray(res.body.welcome)).toBe(true);
  });
});
