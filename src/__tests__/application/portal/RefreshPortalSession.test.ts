import { PortalLogin } from '@application/use-cases/portal/PortalLogin';
import { RefreshPortalSession } from '@application/use-cases/portal/RefreshPortalSession';
import { InMemoryPortalAccountRepository } from '@infrastructure/adapters/in-memory/InMemoryPortalAccountRepository';
import { InMemoryPortalSessionRepository } from '@infrastructure/adapters/in-memory/InMemoryPortalSessionRepository';
import { InMemoryPasswordHasher } from '@infrastructure/adapters/in-memory/InMemoryPasswordHasher';
import { JwtPortalTokenService } from '@infrastructure/adapters/jwt/JwtPortalTokenService';
import { InvalidPortalRefreshTokenError, PortalRefreshTokenReusedError } from '@domain/errors/portal.errors';
import { hashPortalRefreshToken } from '@domain/services/portalRefreshToken';

const TEST_SECRET = 'test-jwt-secret-32chars-minimum!';

function makeUseCases() {
  const accounts = new InMemoryPortalAccountRepository();
  const sessions = new InMemoryPortalSessionRepository();
  const hasher = new InMemoryPasswordHasher();
  const tokenService = new JwtPortalTokenService(TEST_SECRET);
  const login = new PortalLogin(accounts, sessions, hasher, tokenService);
  const refresh = new RefreshPortalSession(accounts, sessions, tokenService);
  return { login, refresh, accounts, sessions, hasher, tokenService };
}

describe('RefreshPortalSession', () => {
  it('valid refresh token → returns a NEW access+refresh pair', async () => {
    const { login, refresh, accounts, hasher } = makeUseCases();
    await accounts.create({ clientId: 'client-1', dni: '30111222', passwordHash: await hasher.hash('Secret123') });
    const { refreshToken: original } = await login.execute({ dni: '30111222', password: 'Secret123' });

    const result = await refresh.execute(original);

    expect(result.accessToken).toEqual(expect.any(String));
    expect(result.refreshToken).toEqual(expect.any(String));
    expect(result.refreshToken).not.toBe(original);
  });

  it('rotation: the OLD refresh token becomes unusable (rotatedAt set)', async () => {
    const { login, refresh, accounts, hasher, sessions } = makeUseCases();
    await accounts.create({ clientId: 'client-1', dni: '30111222', passwordHash: await hasher.hash('Secret123') });
    const { refreshToken: original } = await login.execute({ dni: '30111222', password: 'Secret123' });

    await refresh.execute(original);

    const oldSession = await sessions.findByTokenHash(hashPortalRefreshToken(original));
    expect(oldSession?.rotatedAt).not.toBeNull();
  });

  it('reusing an already-rotated refresh token → PortalRefreshTokenReusedError AND revokes every session of the account', async () => {
    const { login, refresh, accounts, hasher, sessions } = makeUseCases();
    const account = await accounts.create({ clientId: 'client-1', dni: '30111222', passwordHash: await hasher.hash('Secret123') });
    const { refreshToken: t1 } = await login.execute({ dni: '30111222', password: 'Secret123' });
    const { refreshToken: t2 } = await refresh.execute(t1); // rotates t1 -> t2

    // Attacker (or a retry race) replays the now-rotated t1.
    await expect(refresh.execute(t1)).rejects.toThrow(PortalRefreshTokenReusedError);

    // t2 (the legit rotated session) must ALSO be dead now — every session revoked.
    const t2Session = await sessions.findByTokenHash(hashPortalRefreshToken(t2));
    expect(t2Session?.revokedAt).not.toBeNull();
    void account;
  });

  it('unknown refresh token → InvalidPortalRefreshTokenError', async () => {
    const { refresh } = makeUseCases();
    await expect(refresh.execute('not-a-real-token')).rejects.toThrow(InvalidPortalRefreshTokenError);
  });

  it('expired refresh token → InvalidPortalRefreshTokenError', async () => {
    const { refresh, accounts, hasher, sessions } = makeUseCases();
    const account = await accounts.create({ clientId: 'client-1', dni: '30111222', passwordHash: await hasher.hash('Secret123') });
    const rawToken = 'expired-raw-token';
    await sessions.create({
      accountId: account.id,
      tokenHash: hashPortalRefreshToken(rawToken),
      expiresAt: new Date(Date.now() - 1000),
    });

    await expect(refresh.execute(rawToken)).rejects.toThrow(InvalidPortalRefreshTokenError);
  });

  it('already-revoked refresh token → InvalidPortalRefreshTokenError', async () => {
    const { refresh, accounts, hasher, sessions } = makeUseCases();
    const account = await accounts.create({ clientId: 'client-1', dni: '30111222', passwordHash: await hasher.hash('Secret123') });
    const rawToken = 'revoked-raw-token';
    const session = await sessions.create({
      accountId: account.id,
      tokenHash: hashPortalRefreshToken(rawToken),
      expiresAt: new Date(Date.now() + 60_000),
    });
    await sessions.revoke(session.id);

    await expect(refresh.execute(rawToken)).rejects.toThrow(InvalidPortalRefreshTokenError);
  });

  it('account disabled since the refresh was issued → InvalidPortalRefreshTokenError', async () => {
    const { login, refresh, accounts, hasher } = makeUseCases();
    const account = await accounts.create({ clientId: 'client-1', dni: '30111222', passwordHash: await hasher.hash('Secret123') });
    const { refreshToken } = await login.execute({ dni: '30111222', password: 'Secret123' });
    await accounts.update(account.id, { status: 'disabled' });

    await expect(refresh.execute(refreshToken)).rejects.toThrow(InvalidPortalRefreshTokenError);
  });

  it('new access token carries the same accountId/clientId claims', async () => {
    const { login, refresh, accounts, hasher, tokenService } = makeUseCases();
    const account = await accounts.create({ clientId: 'client-77', dni: '30111222', passwordHash: await hasher.hash('Secret123') });
    const { refreshToken } = await login.execute({ dni: '30111222', password: 'Secret123' });

    const result = await refresh.execute(refreshToken);
    const claims = tokenService.verifyAccessToken(result.accessToken);
    expect(claims).toEqual({ accountId: account.id, clientId: 'client-77' });
  });
});
