import { PortalLogin } from '@application/use-cases/portal/PortalLogin';
import { LogoutPortal } from '@application/use-cases/portal/LogoutPortal';
import { RegisterPortalPushToken } from '@application/use-cases/portal/RegisterPortalPushToken';
import { InMemoryPortalAccountRepository } from '@infrastructure/adapters/in-memory/InMemoryPortalAccountRepository';
import { InMemoryPortalSessionRepository } from '@infrastructure/adapters/in-memory/InMemoryPortalSessionRepository';
import { InMemoryPasswordHasher } from '@infrastructure/adapters/in-memory/InMemoryPasswordHasher';
import { InMemoryPortalPushTokenRepository } from '@infrastructure/adapters/in-memory/InMemoryPortalPushTokenRepository';
import { JwtPortalTokenService } from '@infrastructure/adapters/jwt/JwtPortalTokenService';
import { hashPortalRefreshToken } from '@domain/services/portalRefreshToken';

const TEST_SECRET = 'test-jwt-secret-32chars-minimum!';

function makeUseCases() {
  const accounts = new InMemoryPortalAccountRepository();
  const sessions = new InMemoryPortalSessionRepository();
  const hasher = new InMemoryPasswordHasher();
  const pushTokens = new InMemoryPortalPushTokenRepository();
  const tokenService = new JwtPortalTokenService(TEST_SECRET);
  const login = new PortalLogin(accounts, sessions, hasher, tokenService);
  const logout = new LogoutPortal(sessions, pushTokens);
  return { login, logout, accounts, sessions, hasher, pushTokens };
}

describe('LogoutPortal', () => {
  it('revokes the session tied to the presented refresh token', async () => {
    const { login, logout, accounts, hasher, sessions } = makeUseCases();
    await accounts.create({ clientId: 'client-1', dni: '30111222', passwordHash: await hasher.hash('Secret123') });
    const { refreshToken } = await login.execute({ dni: '30111222', password: 'Secret123' });

    await logout.execute(refreshToken);

    const session = await sessions.findByTokenHash(hashPortalRefreshToken(refreshToken));
    expect(session?.revokedAt).not.toBeNull();
  });

  it('an unknown refresh token is a silent no-op (never throws, no info leak)', async () => {
    const { logout } = makeUseCases();
    await expect(logout.execute('not-a-real-token')).resolves.toBeUndefined();
  });

  it('logging out twice with the same token is idempotent (no throw)', async () => {
    const { login, logout, accounts, hasher } = makeUseCases();
    await accounts.create({ clientId: 'client-1', dni: '30111222', passwordHash: await hasher.hash('Secret123') });
    const { refreshToken } = await login.execute({ dni: '30111222', password: 'Secret123' });

    await logout.execute(refreshToken);
    await expect(logout.execute(refreshToken)).resolves.toBeUndefined();
  });

  it('portal-push-notifications — logout con pushToken revoca el token de ESE dispositivo', async () => {
    const { login, logout, accounts, hasher, pushTokens } = makeUseCases();
    const account = await accounts.create({ clientId: 'client-1', dni: '30111222', passwordHash: await hasher.hash('Secret123') });
    const { refreshToken } = await login.execute({ dni: '30111222', password: 'Secret123' });
    const register = new RegisterPortalPushToken(pushTokens);
    await register.execute(account.id, { token: 'device-token-1', platform: 'android' });

    await logout.execute(refreshToken, 'device-token-1');

    expect(pushTokens.findByToken('device-token-1')).toBeUndefined();
  });

  it('logout SIN pushToken no toca ningún token de push de la cuenta', async () => {
    const { login, logout, accounts, hasher, pushTokens } = makeUseCases();
    const account = await accounts.create({ clientId: 'client-1', dni: '30111222', passwordHash: await hasher.hash('Secret123') });
    const { refreshToken } = await login.execute({ dni: '30111222', password: 'Secret123' });
    const register = new RegisterPortalPushToken(pushTokens);
    await register.execute(account.id, { token: 'device-token-1', platform: 'android' });

    await logout.execute(refreshToken);

    expect(pushTokens.findByToken('device-token-1')).toBeDefined();
  });

  it('LogoutPortal sin dependencia de pushTokens (back-compat) ignora pushToken sin lanzar', async () => {
    const accounts = new InMemoryPortalAccountRepository();
    const sessions = new InMemoryPortalSessionRepository();
    const hasher = new InMemoryPasswordHasher();
    const tokenService = new JwtPortalTokenService(TEST_SECRET);
    const login = new PortalLogin(accounts, sessions, hasher, tokenService);
    const logout = new LogoutPortal(sessions); // sin segundo arg

    await accounts.create({ clientId: 'client-1', dni: '30111222', passwordHash: await hasher.hash('Secret123') });
    const { refreshToken } = await login.execute({ dni: '30111222', password: 'Secret123' });

    await expect(logout.execute(refreshToken, 'some-device-token')).resolves.toBeUndefined();
  });
});
