/**
 * customer-portal-api fix wave C2 — the /api/settings mount in app.ts was the
 * ONLY admin surface without auth, and `PUT /api/settings/client-portal` is the
 * portal kill-switch control plane: an anonymous caller could re-enable a
 * disabled portal (or DoS it off). Investigated consumers before locking it
 * down: settings.routes.test.ts / finance.routes.test.ts / webhooks.routes.test.ts /
 * asyncErrorSweep2.crud.routes.test.ts all build their OWN express app mounting
 * the router directly (they never traverse the app.ts mount), and no non-test
 * consumer in the repo calls /api/settings without the staff cookie — so the
 * WHOLE router goes behind staff auth, no legitimate-public exception found.
 *
 * Two layers pinned here:
 *  1. Behavioral: a mount replicating app.ts's fixed shape rejects anonymous +
 *     revoked-session callers and serves an authenticated staff session.
 *  2. Source pin: app.ts's actual '/api/settings' mount includes
 *     createAuthMiddleware(authAdapter, sessionRepo) — same stateful-auth
 *     pattern as every other admin mount.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';

import { createSettingsRouter } from '@infrastructure/http/routes/settings.routes';
import { createAuthMiddleware } from '@infrastructure/http/middleware/authMiddleware';
import { hashToken } from '@infrastructure/auth/sessionToken';
import { InMemorySettingsRepository } from '@infrastructure/adapters/in-memory/InMemorySettingsRepository';
import { InMemorySessionRepository } from '@infrastructure/adapters/in-memory/InMemorySessionRepository';
import { GetSystemSettings } from '@application/use-cases/GetSystemSettings';
import { UpdateSystemSettings } from '@application/use-cases/UpdateSystemSettings';
import { GetEmailSettings } from '@application/use-cases/GetEmailSettings';
import { UpdateEmailSettings } from '@application/use-cases/UpdateEmailSettings';
import { ListTemplates } from '@application/use-cases/ListTemplates';
import { UpdateTemplate } from '@application/use-cases/UpdateTemplate';
import { ListApiTokens } from '@application/use-cases/ListApiTokens';
import { CreateApiToken } from '@application/use-cases/CreateApiToken';
import { RevokeApiToken } from '@application/use-cases/RevokeApiToken';
import { GetClientPortalSettings } from '@application/use-cases/GetClientPortalSettings';
import { UpdateClientPortalSettings } from '@application/use-cases/UpdateClientPortalSettings';
import type { AuthProvider, CookieConfig } from '@domain/ports/AuthProvider';
import type { User } from '@domain/entities/auth';

const STAFF_TOKEN = 'staff-token';

/** Same FakeAuthProvider pattern as portalAccountsAdmin.routes.test.ts. */
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

function buildApp() {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());

  const repo = new InMemorySettingsRepository();
  const sessionRepo = new InMemorySessionRepository();

  // Replicates the FIXED app.ts mount: stateful staff auth in front of the router.
  app.use(
    '/api/settings',
    createAuthMiddleware(new FakeAuthProvider(), sessionRepo),
    createSettingsRouter(
      new GetSystemSettings(repo),
      new UpdateSystemSettings(repo),
      new GetEmailSettings(repo),
      new UpdateEmailSettings(repo),
      new ListTemplates(repo),
      new UpdateTemplate(repo),
      new ListApiTokens(repo),
      new CreateApiToken(repo),
      new RevokeApiToken(repo),
      undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined,
      new GetClientPortalSettings(repo),
      new UpdateClientPortalSettings(repo),
    ),
  );

  return { app, sessionRepo };
}

describe('C2 — /api/settings mount requires staff auth (kill-switch control plane)', () => {
  it('anonymous PUT /api/settings/client-portal -> 401 (cannot flip the portal kill-switch)', async () => {
    const { app } = buildApp();
    const res = await request(app).put('/api/settings/client-portal').send({ enabled: true });
    expect(res.status).toBe(401);
  });

  it('anonymous GET /api/settings/system -> 401 (the WHOLE router is guarded, not just client-portal)', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/settings/system');
    expect(res.status).toBe(401);
  });

  it('revoked staff session -> 401 even with a token the provider accepts', async () => {
    const { app, sessionRepo } = buildApp();
    // No session row exists for this token hash => stateful check rejects it.
    const res = await request(app)
      .put('/api/settings/client-portal')
      .set('Cookie', `auth_token=${STAFF_TOKEN}`)
      .send({ enabled: true });
    expect(res.status).toBe(401);
    void sessionRepo;
  });

  it('staff session viva -> 200 y el toggle del portal persiste', async () => {
    const { app, sessionRepo } = buildApp();
    await sessionRepo.create({
      rbacUserId: 'staff-1',
      actorLogin: 'staff',
      tokenHash: hashToken(STAFF_TOKEN),
      ip: null,
      userAgent: null,
    });

    const res = await request(app)
      .put('/api/settings/client-portal')
      .set('Cookie', `auth_token=${STAFF_TOKEN}`)
      .send({ enabled: false });
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);

    const read = await request(app)
      .get('/api/settings/client-portal')
      .set('Cookie', `auth_token=${STAFF_TOKEN}`);
    expect(read.status).toBe(200);
    expect(read.body.enabled).toBe(false);
  });
});

describe('C2 — app.ts source pin: the /api/settings mount carries createAuthMiddleware(authAdapter, sessionRepo)', () => {
  it('the real mount is guarded (not just this test replica)', () => {
    const appSrc = readFileSync(
      join(__dirname, '..', '..', 'infrastructure', 'http', 'app.ts'),
      'utf8',
    );
    const start = appSrc.indexOf("'/api/settings'");
    expect(start).toBeGreaterThan(-1);
    const end = appSrc.indexOf('createSettingsRouter(', start);
    expect(end).toBeGreaterThan(start);
    const mountPrefix = appSrc.slice(start, end);
    expect(mountPrefix).toMatch(/createAuthMiddleware\(\s*authAdapter\s*,\s*sessionRepo\s*\)/);
  });
});
