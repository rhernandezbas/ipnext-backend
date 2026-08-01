/**
 * fix/auth-stateful-routers — full end-to-end behavioural proof for ONE representative
 * positional-style router (`createBillingRouter`, the exact example from the bug
 * report: "opera facturación... el resto del día").
 *
 * Unlike `statefulAuthRoutes.revokedSession.test.ts` (which uses throwaway `never`
 * stubs for every use case, since auth always 401s first there), this test wires REAL
 * use cases + a REAL `BillingRepository` fake and walks the FULL lifecycle:
 *   1. no session at all -> 401
 *   2. live (non-revoked) session -> 200 with real data
 *   3. same session, revoked -> 401 (the actual regression this change fixes)
 *
 * This is the "does the whole chain actually work, not just the wiring" complement to
 * the parametrized sweep.
 */
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';

import { createBillingRouter } from '@infrastructure/http/routes/billing.routes';
import { GetBillingSummary } from '@application/use-cases/GetBillingSummary';
import { ListInvoices } from '@application/use-cases/ListInvoices';
import { ListPayments } from '@application/use-cases/ListPayments';
import { ListTransactions } from '@application/use-cases/ListTransactions';
import { InMemorySessionRepository } from '@infrastructure/adapters/in-memory/InMemorySessionRepository';
import { hashToken } from '@infrastructure/auth/sessionToken';
import type { BillingRepository } from '@domain/ports/BillingRepository';
import type { AuthProvider, CookieConfig } from '@domain/ports/AuthProvider';
import type { User } from '@domain/entities/auth';
import type { BillingSummary } from '@domain/entities/billing';

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

const summary: BillingSummary = {
  totalRevenueThisMonth: 123,
  totalPending: 4,
  totalOverdue: 1,
  creditNotesAmount: 0,
  proformaPaidAmount: 0,
  proformaUnpaidAmount: 0,
};

const fakeBillingRepo: BillingRepository = {
  getSummary: async () => summary,
  listInvoices: async () => ({ data: [], total: 0, page: 1, limit: 25 }),
  listPayments: async () => ({ data: [], total: 0, page: 1, limit: 25 }),
  listTransactions: async () => ({ data: [], total: 0, page: 1, limit: 25 }),
};

function buildApp(sessionRepo: InMemorySessionRepository) {
  const authProvider = new FakeAuthProvider();
  const router = createBillingRouter(
    new GetBillingSummary(fakeBillingRepo),
    new ListInvoices(fakeBillingRepo),
    new ListPayments(fakeBillingRepo),
    new ListTransactions(fakeBillingRepo),
    // createBillingRouter's authProvider param is typed as the concrete JwtAuthAdapter
    // class (not the AuthProvider interface) — `as never` here is a throwaway type
    // cast, not a behavioral difference: createAuthMiddleware only ever calls the
    // interface methods, which FakeAuthProvider implements for real.
    authProvider as never,
    sessionRepo,
  );
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use('/api/billing', router);
  return app;
}

describe('fix/auth-stateful-routers — createBillingRouter: revoked session -> 401 (was 200)', () => {
  it('no auth_token cookie -> 401', async () => {
    const app = buildApp(new InMemorySessionRepository());
    const res = await request(app).get('/api/billing/summary');
    expect(res.status).toBe(401);
  });

  it('live session -> 200 with the real billing summary', async () => {
    const sessionRepo = new InMemorySessionRepository();
    await sessionRepo.create({
      rbacUserId: 'staff-1',
      actorLogin: 'staff',
      tokenHash: hashToken(STAFF_TOKEN),
      ip: null,
      userAgent: null,
    });
    const app = buildApp(sessionRepo);

    const res = await request(app).get('/api/billing/summary').set('Cookie', `auth_token=${STAFF_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(summary);
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
    // The panel action: an admin revokes the ex-employee's session.
    await sessionRepo.revoke(session.id);
    const app = buildApp(sessionRepo);

    const res = await request(app).get('/api/billing/summary').set('Cookie', `auth_token=${STAFF_TOKEN}`);
    expect(res.status).toBe(401);
  });
});
