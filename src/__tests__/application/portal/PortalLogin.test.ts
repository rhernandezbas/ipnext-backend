import { PortalLogin } from '@application/use-cases/portal/PortalLogin';
import { InMemoryPortalAccountRepository } from '@infrastructure/adapters/in-memory/InMemoryPortalAccountRepository';
import { InMemoryPortalSessionRepository } from '@infrastructure/adapters/in-memory/InMemoryPortalSessionRepository';
import { InMemoryPasswordHasher } from '@infrastructure/adapters/in-memory/InMemoryPasswordHasher';
import { JwtPortalTokenService } from '@infrastructure/adapters/jwt/JwtPortalTokenService';
import { InvalidPortalCredentialsError } from '@domain/errors/portal.errors';
import { hashPortalRefreshToken } from '@domain/services/portalRefreshToken';

const TEST_SECRET = 'test-jwt-secret-32chars-minimum!';

function makeUseCase() {
  const accounts = new InMemoryPortalAccountRepository();
  const sessions = new InMemoryPortalSessionRepository();
  const hasher = new InMemoryPasswordHasher();
  const tokenService = new JwtPortalTokenService(TEST_SECRET);
  const useCase = new PortalLogin(accounts, sessions, hasher, tokenService);
  return { useCase, accounts, sessions, hasher, tokenService };
}

describe('PortalLogin', () => {
  it('valid DNI + password → returns accessToken, refreshToken, mustChangePassword', async () => {
    const { useCase, accounts, hasher } = makeUseCase();
    await accounts.create({ clientId: 'client-1', dni: '30111222', passwordHash: await hasher.hash('Secret123') });

    const result = await useCase.execute({ dni: '30111222', password: 'Secret123' });

    expect(result.accessToken).toEqual(expect.any(String));
    expect(result.refreshToken).toEqual(expect.any(String));
    expect(result.mustChangePassword).toBe(true); // new accounts default mustChangePassword=true
  });

  it('access token carries aud=portal, sub=accountId, clientId claim', async () => {
    const { useCase, accounts, hasher, tokenService } = makeUseCase();
    const account = await accounts.create({ clientId: 'client-42', dni: '30111222', passwordHash: await hasher.hash('Secret123') });

    const result = await useCase.execute({ dni: '30111222', password: 'Secret123' });
    const claims = tokenService.verifyAccessToken(result.accessToken);
    expect(claims).toEqual({ accountId: account.id, clientId: 'client-42' });
  });

  it('persists a PortalSession whose tokenHash matches sha256(refreshToken)', async () => {
    const { useCase, accounts, hasher, sessions } = makeUseCase();
    const account = await accounts.create({ clientId: 'client-1', dni: '30111222', passwordHash: await hasher.hash('Secret123') });

    const result = await useCase.execute({ dni: '30111222', password: 'Secret123' });

    const session = await sessions.findByTokenHash(hashPortalRefreshToken(result.refreshToken));
    expect(session).not.toBeNull();
    expect(session?.accountId).toBe(account.id);
    expect(session?.revokedAt).toBeNull();
    expect(session?.rotatedAt).toBeNull();
  });

  it('updates lastLoginAt on success', async () => {
    const { useCase, accounts, hasher } = makeUseCase();
    const account = await accounts.create({ clientId: 'client-1', dni: '30111222', passwordHash: await hasher.hash('Secret123') });
    expect(account.lastLoginAt).toBeNull();

    await useCase.execute({ dni: '30111222', password: 'Secret123' });

    const refreshed = await accounts.findById(account.id);
    expect(refreshed?.lastLoginAt).not.toBeNull();
  });

  it('unknown DNI → throws InvalidPortalCredentialsError (generic, anti-enumeration)', async () => {
    const { useCase } = makeUseCase();
    await expect(useCase.execute({ dni: '99999999', password: 'whatever' })).rejects.toThrow(InvalidPortalCredentialsError);
  });

  it('wrong password → throws the SAME InvalidPortalCredentialsError', async () => {
    const { useCase, accounts, hasher } = makeUseCase();
    await accounts.create({ clientId: 'client-1', dni: '30111222', passwordHash: await hasher.hash('Secret123') });
    await expect(useCase.execute({ dni: '30111222', password: 'WrongOne' })).rejects.toThrow(InvalidPortalCredentialsError);
  });

  it('disabled account → throws the SAME InvalidPortalCredentialsError (no status leak)', async () => {
    const { useCase, accounts, hasher } = makeUseCase();
    const account = await accounts.create({ clientId: 'client-1', dni: '30111222', passwordHash: await hasher.hash('Secret123') });
    await accounts.update(account.id, { status: 'disabled' });

    await expect(useCase.execute({ dni: '30111222', password: 'Secret123' })).rejects.toThrow(InvalidPortalCredentialsError);
  });

  describe('H3a (fix wave) — costo constante: dummy bcrypt compare en las ramas que no llegan al hash real', () => {
    it('DNI inexistente: hasher.compare se ejecuta IGUAL (contra el hash dummy) antes del 401 genérico', async () => {
      const { useCase, hasher } = makeUseCase();
      const compareSpy = jest.spyOn(hasher, 'compare');

      await expect(useCase.execute({ dni: '99999999', password: 'whatever' })).rejects.toThrow(InvalidPortalCredentialsError);

      // Sin el dummy compare, esta rama respondía SIN costo bcrypt — un
      // atacante distinguía "DNI existe" de "no existe" por timing.
      expect(compareSpy).toHaveBeenCalledTimes(1);
    });

    it('cuenta disabled: hasher.compare se ejecuta IGUAL (contra el hash dummy) antes del 401 genérico', async () => {
      const { useCase, accounts, hasher } = makeUseCase();
      const account = await accounts.create({ clientId: 'client-1', dni: '30111222', passwordHash: await hasher.hash('Secret123') });
      await accounts.update(account.id, { status: 'disabled' });
      const compareSpy = jest.spyOn(hasher, 'compare');

      await expect(useCase.execute({ dni: '30111222', password: 'Secret123' })).rejects.toThrow(InvalidPortalCredentialsError);

      expect(compareSpy).toHaveBeenCalledTimes(1);
      // El compare dummy JAMAS corre contra el hash real de la cuenta disabled
      // (no debe poder "acertar" una password en una cuenta apagada).
      expect(compareSpy).not.toHaveBeenCalledWith('Secret123', account.passwordHash);
    });

    it('login exitoso: UN solo compare (el real) — el dummy no duplica el costo del camino feliz', async () => {
      const { useCase, accounts, hasher } = makeUseCase();
      const account = await accounts.create({ clientId: 'client-1', dni: '30111222', passwordHash: await hasher.hash('Secret123') });
      const compareSpy = jest.spyOn(hasher, 'compare');

      await useCase.execute({ dni: '30111222', password: 'Secret123' });

      expect(compareSpy).toHaveBeenCalledTimes(1);
      expect(compareSpy).toHaveBeenCalledWith('Secret123', account.passwordHash);
    });
  });

  it('mustChangePassword reflects the account flag (false once already changed)', async () => {
    const { useCase, accounts, hasher } = makeUseCase();
    const account = await accounts.create({ clientId: 'client-1', dni: '30111222', passwordHash: await hasher.hash('Secret123') });
    await accounts.update(account.id, { mustChangePassword: false });

    const result = await useCase.execute({ dni: '30111222', password: 'Secret123' });
    expect(result.mustChangePassword).toBe(false);
  });
});
