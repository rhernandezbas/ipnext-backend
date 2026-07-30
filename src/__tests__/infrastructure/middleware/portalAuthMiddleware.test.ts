import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { createPortalAuthMiddleware } from '@infrastructure/http/middleware/portalAuthMiddleware';
import { JwtPortalTokenService } from '@infrastructure/adapters/jwt/JwtPortalTokenService';
import { InMemoryPortalAccountRepository } from '@infrastructure/adapters/in-memory/InMemoryPortalAccountRepository';

const TEST_SECRET = 'test-jwt-secret-32chars-minimum!';

function makeReq(headers: Record<string, string> = {}): Partial<Request> {
  return { headers } as Partial<Request>;
}

function makeRes(): { status: jest.Mock; json: jest.Mock } {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
}

function makeMiddleware() {
  const tokenService = new JwtPortalTokenService(TEST_SECRET);
  const accounts = new InMemoryPortalAccountRepository();
  const middleware = createPortalAuthMiddleware(tokenService, accounts);
  return { middleware, tokenService, accounts };
}

describe('portalAuthMiddleware', () => {
  let next: NextFunction;

  beforeEach(() => {
    next = jest.fn();
  });

  it('401 when there is no Authorization header', async () => {
    const { middleware } = makeMiddleware();
    const req = makeReq() as Request;
    const res = makeRes() as unknown as Response;

    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('401 when the header is not a Bearer token', async () => {
    const { middleware } = makeMiddleware();
    const req = makeReq({ authorization: 'Basic abc123' }) as Request;
    const res = makeRes() as unknown as Response;

    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('401 on a garbage token', async () => {
    const { middleware } = makeMiddleware();
    const req = makeReq({ authorization: 'Bearer not-a-jwt' }) as Request;
    const res = makeRes() as unknown as Response;

    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  // portal-auth spec "Token admin contra ruta de portal" → 401.
  it('401 on a valid STAFF-shaped token (no aud=portal) — cross-audience rejection', async () => {
    const { middleware } = makeMiddleware();
    const staffToken = jwt.sign({ id: 'u1', login: 'staff', email: 's@x.com' }, TEST_SECRET, { expiresIn: '1h' });
    const req = makeReq({ authorization: `Bearer ${staffToken}` }) as Request;
    const res = makeRes() as unknown as Response;

    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('401 when the token is valid but the account no longer exists', async () => {
    const { middleware, tokenService } = makeMiddleware();
    const token = tokenService.signAccessToken({ accountId: 'ghost-account', clientId: 'client-1' });
    const req = makeReq({ authorization: `Bearer ${token}` }) as Request;
    const res = makeRes() as unknown as Response;

    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  // portal-auth spec: the account is checked PER REQUEST, not only at login time.
  it('401 when the account was disabled AFTER the token was issued', async () => {
    const { middleware, tokenService, accounts } = makeMiddleware();
    const account = await accounts.create({ clientId: 'client-1', dni: '30111222', passwordHash: 'h' });
    const token = tokenService.signAccessToken({ accountId: account.id, clientId: account.clientId });
    await accounts.update(account.id, { status: 'disabled' });

    const req = makeReq({ authorization: `Bearer ${token}` }) as Request;
    const res = makeRes() as unknown as Response;

    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('valid token + active account → sets req.portalAccountId/portalClientId and calls next()', async () => {
    const { middleware, tokenService, accounts } = makeMiddleware();
    const account = await accounts.create({ clientId: 'client-77', dni: '30111222', passwordHash: 'h' });
    const token = tokenService.signAccessToken({ accountId: account.id, clientId: account.clientId });

    const req = makeReq({ authorization: `Bearer ${token}` }) as Request;
    const res = makeRes() as unknown as Response;

    await middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    expect(req.portalAccountId).toBe(account.id);
    expect(req.portalClientId).toBe('client-77');
  });
});
