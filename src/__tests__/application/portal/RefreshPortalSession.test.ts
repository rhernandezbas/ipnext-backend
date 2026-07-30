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

  describe('H2 (fix wave) — rotación atómica: markRotated es un compare-and-swap', () => {
    it('contrato del port (in-memory): markRotated devuelve true la PRIMERA vez y false después / para ids desconocidos', async () => {
      const { accounts, sessions } = makeUseCases();
      const account = await accounts.create({ clientId: 'client-1', dni: '30111222', passwordHash: 'h' });
      const session = await sessions.create({
        accountId: account.id,
        tokenHash: hashPortalRefreshToken('raw'),
        expiresAt: new Date(Date.now() + 60_000),
      });

      await expect(sessions.markRotated(session.id)).resolves.toBe(true);
      await expect(sessions.markRotated(session.id)).resolves.toBe(false);
      await expect(sessions.markRotated('no-such-id')).resolves.toBe(false);
    });

    it('carrera TOCTOU: dos refresh concurrentes con el MISMO token — el que pierde el CAS revoca TODO y falla como reuso (jamás dos cadenas)', async () => {
      const { login, refresh, accounts, hasher, sessions, tokenService } = makeUseCases();
      await accounts.create({ clientId: 'client-1', dni: '30111222', passwordHash: await hasher.hash('Secret123') });
      const { refreshToken: t1 } = await login.execute({ dni: '30111222', password: 'Secret123' });

      // Snapshot PRE-rotación de la sesión — lo que el request perdedor ya leyó
      // antes de que el ganador escribiera rotatedAt (la ventana TOCTOU real).
      const staleSnapshot = await sessions.findByTokenHash(hashPortalRefreshToken(t1));
      expect(staleSnapshot?.rotatedAt).toBeNull();

      // Ganador: refresh normal — rota t1 y mintea su propia cadena.
      const winner = await refresh.execute(t1);

      // Perdedor: su findByTokenHash devolvió el snapshot stale (pasó el check
      // de reuso), pero llega SEGUNDO al markRotated — pierde el CAS.
      const staleReadSessions = new Proxy(sessions, {
        get(target, prop, receiver) {
          if (prop === 'findByTokenHash') {
            return async () => ({ ...staleSnapshot! });
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const loserRefresh = new RefreshPortalSession(accounts, staleReadSessions, tokenService);

      await expect(loserRefresh.execute(t1)).rejects.toThrow(PortalRefreshTokenReusedError);

      // Señal de robo disparada: TODA la cuenta queda revocada — incluida la
      // cadena que el ganador acababa de mintear.
      await expect(refresh.execute(winner.refreshToken)).rejects.toThrow(InvalidPortalRefreshTokenError);
      const winnerSession = await sessions.findByTokenHash(hashPortalRefreshToken(winner.refreshToken));
      expect(winnerSession?.revokedAt).not.toBeNull();
    });
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
