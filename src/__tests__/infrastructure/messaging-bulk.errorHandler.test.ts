/**
 * messaging-bulk (F2, T2.3) — mapeo de los errores tipados nuevos en errorHandler's
 * statusMap. Un caso por código, montando una ruta mínima que lanza el error y
 * verificando el status HTTP real que responde el errorHandler DE PRODUCCIÓN (no
 * se reimplementa el mapeo en el test — se ejercita el middleware real).
 */
import request from 'supertest';
import express from 'express';
import { errorHandler } from '@infrastructure/http/middleware/errorHandler';
import {
  TemplateProviderUnavailableError,
  TemplateSendRejectedError,
  TemplateNotApprovedError,
  MissingTemplateVariablesError,
  EmptySegmentError,
  CampaignNotFoundError,
  CampaignAlreadyFinishedError,
  BulkRecipientsNotPermittedError,
} from '@domain/errors/messaging-bulk';

function appThrowing(err: unknown) {
  const app = express();
  app.get('/boom', (_req, _res) => {
    throw err;
  });
  app.use(errorHandler);
  return app;
}

describe('errorHandler statusMap — códigos nuevos de messaging-bulk (T2.3)', () => {
  it('TEMPLATE_PROVIDER_UNAVAILABLE → 503', async () => {
    const res = await request(appThrowing(new TemplateProviderUnavailableError())).get('/boom');
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('TEMPLATE_PROVIDER_UNAVAILABLE');
  });

  it('TEMPLATE_SEND_REJECTED → 422', async () => {
    const res = await request(appThrowing(new TemplateSendRejectedError('rejected'))).get('/boom');
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('TEMPLATE_SEND_REJECTED');
  });

  it('TEMPLATE_NOT_APPROVED → 422', async () => {
    const res = await request(appThrowing(new TemplateNotApprovedError('HXabc'))).get('/boom');
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('TEMPLATE_NOT_APPROVED');
  });

  it('MISSING_TEMPLATE_VARIABLES → 422', async () => {
    const res = await request(appThrowing(new MissingTemplateVariablesError(['monto_deuda']))).get('/boom');
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('MISSING_TEMPLATE_VARIABLES');
  });

  it('EMPTY_SEGMENT → 422', async () => {
    const res = await request(appThrowing(new EmptySegmentError())).get('/boom');
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('EMPTY_SEGMENT');
  });

  it('CAMPAIGN_NOT_FOUND → 404', async () => {
    const res = await request(appThrowing(new CampaignNotFoundError('camp-1'))).get('/boom');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CAMPAIGN_NOT_FOUND');
  });

  it('CAMPAIGN_ALREADY_FINISHED → 409', async () => {
    const res = await request(appThrowing(new CampaignAlreadyFinishedError('camp-1'))).get('/boom');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CAMPAIGN_ALREADY_FINISHED');
  });

  it('BULK_RECIPIENTS_NOT_PERMITTED → 403 con forbidden surfaced (bulk-granular-perms)', async () => {
    const res = await request(appThrowing(new BulkRecipientsNotPermittedError(['blocked', 'números']))).get('/boom');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('BULK_RECIPIENTS_NOT_PERMITTED');
    expect(res.body.forbidden).toEqual(['blocked', 'números']);
  });
});
