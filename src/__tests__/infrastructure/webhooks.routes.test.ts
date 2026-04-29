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
import { ListWebhooks } from '../../application/use-cases/ListWebhooks';
import { CreateWebhook } from '../../application/use-cases/CreateWebhook';
import { DeleteWebhook } from '../../application/use-cases/DeleteWebhook';
import { TestWebhook } from '../../application/use-cases/TestWebhook';
import { ListBackups } from '../../application/use-cases/ListBackups';
import { CreateBackup } from '../../application/use-cases/CreateBackup';
import { GetClientPortalSettings } from '../../application/use-cases/GetClientPortalSettings';
import { UpdateClientPortalSettings } from '../../application/use-cases/UpdateClientPortalSettings';
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
  const listWebhooks = new ListWebhooks(repo);
  const createWebhook = new CreateWebhook(repo);
  const deleteWebhook = new DeleteWebhook(repo);
  const testWebhook = new TestWebhook(repo);
  const listBackups = new ListBackups(repo);
  const createBackup = new CreateBackup(repo);
  const getClientPortalSettings = new GetClientPortalSettings(repo);
  const updateClientPortalSettings = new UpdateClientPortalSettings(repo);

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
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      listWebhooks,
      createWebhook,
      deleteWebhook,
      testWebhook,
      listBackups,
      createBackup,
      getClientPortalSettings,
      updateClientPortalSettings,
    ),
  );

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

describe('GET /api/settings/webhooks', () => {
  it('returns 200 with webhooks array', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/settings/webhooks');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(3);
  });
});

describe('POST /api/settings/webhooks/:id/test', () => {
  it('returns 200 with { success: true }', async () => {
    const app = buildApp();
    const res = await request(app).post('/api/settings/webhooks/wh-1/test');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

describe('GET /api/settings/backups', () => {
  it('returns 200 with backups array', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/settings/backups');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(5);
  });
});

describe('POST /api/settings/backups', () => {
  it('returns 201 with status in_progress', async () => {
    const app = buildApp();
    const res = await request(app).post('/api/settings/backups');

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('in_progress');
    expect(res.body.type).toBe('manual');
  });
});

describe('GET /api/settings/client-portal', () => {
  it('returns 200 with portalUrl', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/settings/client-portal');

    expect(res.status).toBe(200);
    expect(res.body.portalUrl).toBeTruthy();
  });
});
