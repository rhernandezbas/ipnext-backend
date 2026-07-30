import { ChangePortalPassword } from '@application/use-cases/portal/ChangePortalPassword';
import { InMemoryPortalAccountRepository } from '@infrastructure/adapters/in-memory/InMemoryPortalAccountRepository';
import { InMemoryPortalSessionRepository } from '@infrastructure/adapters/in-memory/InMemoryPortalSessionRepository';
import { InMemoryPasswordHasher } from '@infrastructure/adapters/in-memory/InMemoryPasswordHasher';
import {
  PortalAccountNotFoundError,
  InvalidCurrentPortalPasswordError,
  PortalPasswordTooShortError,
} from '@domain/errors/portal.errors';

function makeUseCase() {
  const accounts = new InMemoryPortalAccountRepository();
  const sessions = new InMemoryPortalSessionRepository();
  const hasher = new InMemoryPasswordHasher();
  const useCase = new ChangePortalPassword(accounts, hasher, sessions);
  return { useCase, accounts, sessions, hasher };
}

describe('ChangePortalPassword', () => {
  it('valid current password + valid new password → updates the hash and clears mustChangePassword', async () => {
    const { useCase, accounts, hasher } = makeUseCase();
    const account = await accounts.create({ clientId: 'client-1', dni: '30111222', passwordHash: await hasher.hash('OldPass1') });
    expect(account.mustChangePassword).toBe(true);

    await useCase.execute({ accountId: account.id, currentPassword: 'OldPass1', newPassword: 'NewPass1' });

    const updated = await accounts.findById(account.id);
    expect(updated?.mustChangePassword).toBe(false);
    expect(await hasher.compare('NewPass1', updated!.passwordHash)).toBe(true);
    expect(await hasher.compare('OldPass1', updated!.passwordHash)).toBe(false);
  });

  it('wrong current password → InvalidCurrentPortalPasswordError, nothing changes', async () => {
    const { useCase, accounts, hasher } = makeUseCase();
    const account = await accounts.create({ clientId: 'client-1', dni: '30111222', passwordHash: await hasher.hash('OldPass1') });

    await expect(
      useCase.execute({ accountId: account.id, currentPassword: 'WrongOne', newPassword: 'NewPass1' }),
    ).rejects.toThrow(InvalidCurrentPortalPasswordError);

    const untouched = await accounts.findById(account.id);
    expect(untouched?.mustChangePassword).toBe(true);
  });

  it('new password shorter than 8 chars → PortalPasswordTooShortError', async () => {
    const { useCase, accounts, hasher } = makeUseCase();
    const account = await accounts.create({ clientId: 'client-1', dni: '30111222', passwordHash: await hasher.hash('OldPass1') });

    await expect(
      useCase.execute({ accountId: account.id, currentPassword: 'OldPass1', newPassword: 'short1' }),
    ).rejects.toThrow(PortalPasswordTooShortError);
  });

  it('exactly 8 chars is accepted (boundary)', async () => {
    const { useCase, accounts, hasher } = makeUseCase();
    const account = await accounts.create({ clientId: 'client-1', dni: '30111222', passwordHash: await hasher.hash('OldPass1') });

    await expect(
      useCase.execute({ accountId: account.id, currentPassword: 'OldPass1', newPassword: '12345678' }),
    ).resolves.toBeUndefined();
  });

  describe('M1 (fix wave) — el cambio de password MATA las sesiones (como Regenerate/SetStatus)', () => {
    it('revoca TODAS las sesiones de la cuenta tras cambiar el hash (el refresh robado muere con la password vieja)', async () => {
      const { useCase, accounts, sessions, hasher } = makeUseCase();
      const account = await accounts.create({ clientId: 'client-1', dni: '30111222', passwordHash: await hasher.hash('OldPass1') });
      const s1 = await sessions.create({ accountId: account.id, tokenHash: 'hash-1', expiresAt: new Date(Date.now() + 60_000) });
      const s2 = await sessions.create({ accountId: account.id, tokenHash: 'hash-2', expiresAt: new Date(Date.now() + 60_000) });
      // Sesión de OTRA cuenta — no debe tocarse (anti fixture degenerado).
      const other = await accounts.create({ clientId: 'client-2', dni: '30999888', passwordHash: await hasher.hash('Xx12345678') });
      const sOther = await sessions.create({ accountId: other.id, tokenHash: 'hash-other', expiresAt: new Date(Date.now() + 60_000) });

      await useCase.execute({ accountId: account.id, currentPassword: 'OldPass1', newPassword: 'NewPass1' });

      expect((await sessions.findByTokenHash('hash-1'))?.revokedAt).not.toBeNull();
      expect((await sessions.findByTokenHash('hash-2'))?.revokedAt).not.toBeNull();
      expect((await sessions.findByTokenHash('hash-other'))?.revokedAt).toBeNull();
      void s1; void s2; void sOther;
    });

    it('NO revoca nada cuando el cambio falla (password actual incorrecta / nueva corta)', async () => {
      const { useCase, accounts, sessions, hasher } = makeUseCase();
      const account = await accounts.create({ clientId: 'client-1', dni: '30111222', passwordHash: await hasher.hash('OldPass1') });
      await sessions.create({ accountId: account.id, tokenHash: 'hash-1', expiresAt: new Date(Date.now() + 60_000) });

      await expect(
        useCase.execute({ accountId: account.id, currentPassword: 'WrongOne', newPassword: 'NewPass1' }),
      ).rejects.toThrow(InvalidCurrentPortalPasswordError);
      await expect(
        useCase.execute({ accountId: account.id, currentPassword: 'OldPass1', newPassword: 'short1' }),
      ).rejects.toThrow(PortalPasswordTooShortError);

      expect((await sessions.findByTokenHash('hash-1'))?.revokedAt).toBeNull();
    });
  });

  it('unknown accountId → PortalAccountNotFoundError', async () => {
    const { useCase } = makeUseCase();
    await expect(
      useCase.execute({ accountId: 'nope', currentPassword: 'x', newPassword: 'NewPass1' }),
    ).rejects.toThrow(PortalAccountNotFoundError);
  });
});
