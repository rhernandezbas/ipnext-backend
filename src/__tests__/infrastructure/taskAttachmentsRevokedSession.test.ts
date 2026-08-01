/**
 * fix/auth-stateful-routers — full end-to-end behavioural proof for the deps-OBJECT
 * style factory (`createTaskAttachmentsRouter`), the other DI shape among the ~36
 * migrated routers (`newsMedia.routes.ts` is the only other one, same shape).
 *
 * Same three-step lifecycle as `billingRevokedSession.test.ts`:
 *   1. no session at all -> 401
 *   2. live session -> 200 (real use cases, real in-memory repos)
 *   3. same session, revoked -> 401 (the regression this change fixes)
 *
 * `deps.sessionRepo` is now a REQUIRED field on `TaskAttachmentRouterDeps` — this test
 * also doubles as the revert-probe for that: removing it from the object literal below
 * is a TypeScript compile error, not just a runtime gap.
 */
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';

import { createTaskAttachmentsRouter } from '@infrastructure/http/routes/taskAttachments.routes';
import { AttachPhotosToTask } from '@application/use-cases/AttachPhotosToTask';
import { ListTaskAttachments } from '@application/use-cases/ListTaskAttachments';
import { GetTaskAttachmentFile } from '@application/use-cases/GetTaskAttachmentFile';
import { DeleteTaskAttachment } from '@application/use-cases/DeleteTaskAttachment';
import { InMemoryTaskAttachmentRepository } from '@infrastructure/adapters/in-memory/InMemoryTaskAttachmentRepository';
import { InMemoryFileStorage } from '@infrastructure/adapters/in-memory/InMemoryFileStorage';
import { InMemorySessionRepository } from '@infrastructure/adapters/in-memory/InMemorySessionRepository';
import { hashToken } from '@infrastructure/auth/sessionToken';
import type { AuthProvider, CookieConfig } from '@domain/ports/AuthProvider';
import type { User } from '@domain/entities/auth';
import type { EntityLookup } from '@domain/ports/EntityLookup';
import type { ImageProcessor, ProcessedImage, ImageDimensions } from '@domain/ports/ImageProcessor';

const STAFF_TOKEN = 'staff-token';

class FakeAuthProvider implements AuthProvider {
  async login(): Promise<{ user: User; cookieValue: string; cookieOptions: CookieConfig }> {
    return {
      user: { id: 'staff-1', username: 'staff', email: 'staff@test.com' },
      cookieValue: STAFF_TOKEN,
      cookieOptions: { httpOnly: true, secure: false, sameSite: 'lax', maxAge: 3600, path: '/' },
    };
  }
  logout(): { cookieOptions: CookieConfig } {
    return { cookieOptions: { httpOnly: true, secure: false, sameSite: 'lax', maxAge: 0, path: '/' } };
  }
  async getSession(token: string): Promise<User> {
    if (token !== STAFF_TOKEN) throw new Error('invalid');
    return { id: 'staff-1', username: 'staff', email: 'staff@test.com' };
  }
}

class StubImageProcessor implements ImageProcessor {
  async process(): Promise<ProcessedImage> {
    return { width: 800, height: 600, thumbnail: Buffer.from('thumb') };
  }
  inspect(): ImageDimensions | null {
    return { width: 800, height: 600, type: 'jpg' };
  }
}

const taskLookup: EntityLookup = { findById: async (id: string) => ({ id }) };
const passThrough = (_req: express.Request, _res: express.Response, next: express.NextFunction) => next();

function buildApp(sessionRepo: InMemorySessionRepository) {
  const authProvider = new FakeAuthProvider();
  const repo = new InMemoryTaskAttachmentRepository();
  const storage = new InMemoryFileStorage();

  const router = createTaskAttachmentsRouter(
    {
      attachPhotosToTask: new AttachPhotosToTask(repo, storage, taskLookup, new StubImageProcessor()),
      listTaskAttachments: new ListTaskAttachments(repo),
      getTaskAttachmentFile: new GetTaskAttachmentFile(repo, storage),
      deleteTaskAttachment: new DeleteTaskAttachment(repo, storage),
    },
    {
      authProvider,
      sessionRepo,
      requireRead: passThrough,
      requireWrite: passThrough,
    },
  );

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use('/api/scheduling', router);
  return app;
}

describe('fix/auth-stateful-routers — createTaskAttachmentsRouter (deps-object style): revoked session -> 401 (was 200)', () => {
  it('no auth_token cookie -> 401', async () => {
    const app = buildApp(new InMemorySessionRepository());
    const res = await request(app).get('/api/scheduling/t1/attachments');
    expect(res.status).toBe(401);
  });

  it('live session -> 200 with the real (empty) attachment list', async () => {
    const sessionRepo = new InMemorySessionRepository();
    await sessionRepo.create({
      rbacUserId: 'staff-1',
      actorLogin: 'staff',
      tokenHash: hashToken(STAFF_TOKEN),
      ip: null,
      userAgent: null,
    });
    const app = buildApp(sessionRepo);

    const res = await request(app).get('/api/scheduling/t1/attachments').set('Cookie', `auth_token=${STAFF_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('REGRESSION: revoked session -> 401 (before the fix this returned 200 — the JWT alone was enough)', async () => {
    const sessionRepo = new InMemorySessionRepository();
    const session = await sessionRepo.create({
      rbacUserId: 'staff-1',
      actorLogin: 'staff',
      tokenHash: hashToken(STAFF_TOKEN),
      ip: null,
      userAgent: null,
    });
    await sessionRepo.revoke(session.id);
    const app = buildApp(sessionRepo);

    const res = await request(app).get('/api/scheduling/t1/attachments').set('Cookie', `auth_token=${STAFF_TOKEN}`);
    expect(res.status).toBe(401);
  });
});
