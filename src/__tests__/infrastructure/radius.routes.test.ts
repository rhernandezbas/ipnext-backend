import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import { InMemoryRadiusSessionRepository } from '../../infrastructure/adapters/in-memory/InMemoryRadiusSessionRepository';
import { ListRadiusSessions } from '../../application/use-cases/ListRadiusSessions';
import { DisconnectSession } from '../../application/use-cases/DisconnectSession';
import { createRadiusRouter } from '../../infrastructure/http/routes/radius.routes';

function buildApp() {
  const app = express();
  app.use(express.json());

  const repo = new InMemoryRadiusSessionRepository();
  const listRadiusSessions = new ListRadiusSessions(repo);
  const disconnectSession = new DisconnectSession(repo);

  app.use('/api/radius', createRadiusRouter(listRadiusSessions, disconnectSession));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

describe('GET /api/radius/sessions', () => {
  it('returns 200 with 15 sessions', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/radius/sessions');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(15);
  });
});

describe('DELETE /api/radius/sessions/:id', () => {
  it('returns { success: true } for valid session', async () => {
    const app = buildApp();
    const res = await request(app).delete('/api/radius/sessions/session-1');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
