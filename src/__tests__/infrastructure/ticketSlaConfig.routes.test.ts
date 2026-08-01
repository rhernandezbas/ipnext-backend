import request from 'supertest';
import express, { RequestHandler } from 'express';
import cookieParser from 'cookie-parser';
import { InMemoryTicketSlaConfigRepository } from '../../infrastructure/adapters/in-memory/InMemoryTicketSlaConfigRepository';
import { GetTicketSlaConfig } from '../../application/use-cases/GetTicketSlaConfig';
import { UpdateTicketSlaConfig } from '../../application/use-cases/UpdateTicketSlaConfig';
import { createTicketSlaConfigRouter } from '../../infrastructure/http/routes/ticketSlaConfig.routes';
import { errorHandler } from '../../infrastructure/http/middleware/errorHandler';
import { AuthProvider } from '../../domain/ports/AuthProvider';
import { User } from '../../domain/entities/auth';

class FakeAuthProvider implements AuthProvider {
  async login() {
    return {
      user: { id: 'a', username: 'u', email: 'e@e.com', role: 'admin' as const },
      cookieValue: 'fake',
      cookieOptions: { httpOnly: true, secure: false, sameSite: 'lax' as const, maxAge: 3600, path: '/' },
    };
  }
  logout() {
    return { cookieOptions: { httpOnly: true, secure: false, sameSite: 'lax' as const, maxAge: 0, path: '/' } };
  }
  async getSession(_t: string): Promise<User> {
    return { id: 'a', username: 'u', email: 'e@e.com', role: 'admin' };
  }
}

/** Passthrough requirePerm — RBAC enforcement is covered elsewhere; here we
 *  exercise the GET/PUT route→use case→repo seam end-to-end. */
const allowPerm = (): RequestHandler => (_req, _res, next) => next();

function buildApp(repo = new InMemoryTicketSlaConfigRepository()) {
  const router = createTicketSlaConfigRouter(
    new FakeAuthProvider(),
    undefined,
    allowPerm,
    new GetTicketSlaConfig(repo),
    new UpdateTicketSlaConfig(repo),
  );
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use('/api/tickets/sla-config', router);
  app.use(errorHandler);
  return { app, repo };
}

const COOKIE = ['auth_token=fake'];

describe('#79 GET/PUT /api/tickets/sla-config', () => {
  it('GET returns the defaults when nothing is persisted', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/tickets/sla-config').set('Cookie', COOKIE);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ warnMinutes: 60, dangerMinutes: 240 });
  });

  it('PUT persists a valid patch and the subsequent GET reflects it (real repo seam)', async () => {
    const { app } = buildApp();
    const put = await request(app)
      .put('/api/tickets/sla-config')
      .set('Cookie', COOKIE)
      .send({ warnMinutes: 45, dangerMinutes: 180 });
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ warnMinutes: 45, dangerMinutes: 180 });

    const get = await request(app).get('/api/tickets/sla-config').set('Cookie', COOKIE);
    expect(get.body).toEqual({ warnMinutes: 45, dangerMinutes: 180 });
  });

  it('PUT with a non-integer threshold → 400 VALIDATION_ERROR', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .put('/api/tickets/sla-config')
      .set('Cookie', COOKIE)
      .send({ warnMinutes: 'soon' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('PUT that breaks dangerMinutes > warnMinutes → 422 TICKET_SLA_THRESHOLD_ORDER', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .put('/api/tickets/sla-config')
      .set('Cookie', COOKIE)
      .send({ warnMinutes: 300 }); // default danger 240 → merged 300 >= 240
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('TICKET_SLA_THRESHOLD_ORDER');
  });
});
