import { Request, Response, NextFunction } from 'express';
import { createAuthMiddleware } from '../../infrastructure/http/middleware/authMiddleware';
import { AuthenticationError } from '../../domain/errors';
import type { User } from '../../domain/entities/auth';

// Create a minimal mock that satisfies the interface
const mockAuthProvider = {
  login: jest.fn(),
  logout: jest.fn(),
  getSession: jest.fn(),
};

const mockUser: User = {
  id: '1',
  username: 'admin',
  email: 'admin@example.com',
  role: 'admin',
};

function makeReq(cookies: Record<string, string> = {}): Partial<Request> {
  return { cookies } as Partial<Request>;
}

function makeRes(): { status: jest.Mock; json: jest.Mock } {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
}

describe('authMiddleware', () => {
  let next: NextFunction;

  beforeEach(() => {
    jest.clearAllMocks();
    next = jest.fn();
  });

  it('returns 401 when no auth_token cookie', async () => {
    const middleware = createAuthMiddleware(mockAuthProvider as never);
    const req = makeReq({}) as Request;
    const res = makeRes() as unknown as Response;

    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'UNAUTHORIZED' }));
    expect(next).not.toHaveBeenCalled();
  });

  it('attaches user and calls next when token is valid', async () => {
    mockAuthProvider.getSession.mockResolvedValue(mockUser);
    const middleware = createAuthMiddleware(mockAuthProvider as never);
    const req = makeReq({ auth_token: 'valid-token' }) as Request;
    const res = makeRes() as unknown as Response;

    await middleware(req, res, next);

    expect(mockAuthProvider.getSession).toHaveBeenCalledWith('valid-token');
    expect((req as Request & { user?: User }).user).toEqual(mockUser);
    expect(next).toHaveBeenCalled();
  });

  it('returns 401 with AuthenticationError code on invalid token', async () => {
    mockAuthProvider.getSession.mockRejectedValue(new AuthenticationError('Token expired'));
    const middleware = createAuthMiddleware(mockAuthProvider as never);
    const req = makeReq({ auth_token: 'bad-token' }) as Request;
    const res = makeRes() as unknown as Response;

    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'AUTHENTICATION_ERROR' }));
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 with generic UNAUTHORIZED on unknown error', async () => {
    mockAuthProvider.getSession.mockRejectedValue(new Error('Some unexpected error'));
    const middleware = createAuthMiddleware(mockAuthProvider as never);
    const req = makeReq({ auth_token: 'token' }) as Request;
    const res = makeRes() as unknown as Response;

    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'UNAUTHORIZED' }));
  });
});
