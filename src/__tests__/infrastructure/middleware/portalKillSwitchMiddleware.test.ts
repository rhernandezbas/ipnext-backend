import { Request, Response, NextFunction } from 'express';
import { createPortalKillSwitchMiddleware } from '@infrastructure/http/middleware/portalKillSwitchMiddleware';
import type { ClientPortalSettings } from '@domain/entities/settings';

function makeRes(): { status: jest.Mock; json: jest.Mock } {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
}

function makeSettings(enabled: boolean): ClientPortalSettings {
  return {
    enabled,
    portalUrl: '',
    allowSelfRegistration: false,
    requireEmailVerification: true,
    allowPaymentOnline: false,
    allowTicketCreation: true,
    allowServiceManagement: false,
    welcomeMessage: '',
    logoUrl: null,
    primaryColor: '#3B82F6',
    customCss: '',
  };
}

describe('portalKillSwitchMiddleware', () => {
  let next: NextFunction;

  beforeEach(() => {
    next = jest.fn();
  });

  it('enabled=true → calls next()', async () => {
    const repo = { getClientPortalSettings: jest.fn().mockResolvedValue(makeSettings(true)) };
    const middleware = createPortalKillSwitchMiddleware(repo);
    const res = makeRes() as unknown as Response;

    await middleware({} as Request, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('enabled=false → 503 PORTAL_DISABLED, next() never called', async () => {
    const repo = { getClientPortalSettings: jest.fn().mockResolvedValue(makeSettings(false)) };
    const middleware = createPortalKillSwitchMiddleware(repo);
    const res = makeRes() as unknown as Response;

    await middleware({} as Request, res, next);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'PORTAL_DISABLED' }));
    expect(next).not.toHaveBeenCalled();
  });

  it('a repo error fails CLOSED (503), never lets a request through unauthenticated', async () => {
    const repo = { getClientPortalSettings: jest.fn().mockRejectedValue(new Error('db down')) };
    const middleware = createPortalKillSwitchMiddleware(repo);
    const res = makeRes() as unknown as Response;

    await middleware({} as Request, res, next);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(next).not.toHaveBeenCalled();
  });

  it('caches the enabled value for the TTL window — a second call within it does NOT re-read the repo', async () => {
    const repo = { getClientPortalSettings: jest.fn().mockResolvedValue(makeSettings(true)) };
    const middleware = createPortalKillSwitchMiddleware(repo, 30_000);
    const res1 = makeRes() as unknown as Response;
    const res2 = makeRes() as unknown as Response;

    await middleware({} as Request, res1, next);
    await middleware({} as Request, res2, next);

    expect(repo.getClientPortalSettings).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(2);
  });

  it('re-reads the repo once the cache TTL has elapsed', async () => {
    const repo = { getClientPortalSettings: jest.fn().mockResolvedValue(makeSettings(true)) };
    const middleware = createPortalKillSwitchMiddleware(repo, 10); // 10ms TTL
    const res1 = makeRes() as unknown as Response;
    const res2 = makeRes() as unknown as Response;

    await middleware({} as Request, res1, next);
    await new Promise((r) => setTimeout(r, 20));
    await middleware({} as Request, res2, next);

    expect(repo.getClientPortalSettings).toHaveBeenCalledTimes(2);
  });
});
