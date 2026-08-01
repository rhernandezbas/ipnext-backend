/**
 * Route tests for GET /api/admin/iclass/dispatch-preview (F5-F6).
 * STRICT TDD — tests before implementation.
 *
 * F5: GET 200 returns items with correct shape
 * F6: GET 403 without iclass.read permission
 */
import request from 'supertest';
import express, { Request, Response, NextFunction, RequestHandler } from 'express';
import cookieParser from 'cookie-parser';
import { InMemoryProjectRepository } from '@infrastructure/adapters/in-memory/InMemoryProjectRepository';
import { GetIClassDispatchPreview } from '@application/use-cases/GetIClassDispatchPreview';
import { createIClassDispatchPreviewRouter } from '@infrastructure/http/routes/iclassDispatchPreview.routes';
import { errorHandler } from '@infrastructure/http/middleware/errorHandler';
import { User } from '@domain/entities/auth';
import { AuthProvider } from '@domain/ports/AuthProvider';

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

const ALLOW: RequestHandler = (_req, _res, next) => next();
const DENY: RequestHandler = (_req: Request, res: Response, _next: NextFunction): void => {
  res.status(403).json({ error: 'Forbidden', code: 'FORBIDDEN' });
};

async function buildApp(opts: { denyRead?: boolean } = {}) {
  const projectRepo = new InMemoryProjectRepository();
  const soType = { id: 'st-1', code: 'FIBRA_INSTALL', description: 'Instalación Fibra', active: true };
  projectRepo.seedIClassSoType(soType);

  const p1 = await projectRepo.create({ title: 'Fibra Norte', visible: true });
  await projectRepo.updateIClassSoType(p1.id, 'st-1');

  const _p2 = await projectRepo.create({ title: 'Sin Mapeo', visible: true });

  const getPreviewUC = new GetIClassDispatchPreview(projectRepo);

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use(
    '/api/admin/iclass',
    createIClassDispatchPreviewRouter(
      getPreviewUC,
      new FakeAuthProvider(),
      undefined,
      opts.denyRead ? DENY : ALLOW,
    ),
  );
  app.use(errorHandler);

  return { app, p1Id: p1.id };
}

describe('F5: GET /api/admin/iclass/dispatch-preview', () => {
  it('F5: 200 returns items with correct shape', async () => {
    const { app, p1Id } = await buildApp();
    const res = await request(app)
      .get('/api/admin/iclass/dispatch-preview')
      .set('Cookie', 'auth_token=fake');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('items');
    expect(Array.isArray(res.body.items)).toBe(true);

    const mapped = res.body.items.find((r: { projectId: string }) => r.projectId === p1Id);
    expect(mapped).toBeDefined();
    expect(mapped.soType.code).toBe('FIBRA_INSTALL');
    expect(mapped.nodeResolution).toBe('by-customer-city');
    expect(mapped.initialStatus).toBe('assigned-by-iclass');
    expect(mapped.hardcoded.networkPhone).toBe('0000000000');
    expect(mapped.hardcoded.networkCustomerCode).toBe('NETWORK');

    // Unmapped project
    const unmapped = res.body.items.find((r: { projectId: string }) => r.projectId !== p1Id);
    expect(unmapped).toBeDefined();
    expect(unmapped.soType).toBeNull();
  });

  it('F6: 403 without iclass.read permission', async () => {
    const { app } = await buildApp({ denyRead: true });
    const res = await request(app)
      .get('/api/admin/iclass/dispatch-preview')
      .set('Cookie', 'auth_token=fake');

    expect(res.status).toBe(403);
  });
});
