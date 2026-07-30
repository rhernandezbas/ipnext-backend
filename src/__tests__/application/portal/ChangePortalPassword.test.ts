import { ChangePortalPassword } from '@application/use-cases/portal/ChangePortalPassword';
import { InMemoryPortalAccountRepository } from '@infrastructure/adapters/in-memory/InMemoryPortalAccountRepository';
import { InMemoryPasswordHasher } from '@infrastructure/adapters/in-memory/InMemoryPasswordHasher';
import {
  PortalAccountNotFoundError,
  InvalidCurrentPortalPasswordError,
  PortalPasswordTooShortError,
} from '@domain/errors/portal.errors';

function makeUseCase() {
  const accounts = new InMemoryPortalAccountRepository();
  const hasher = new InMemoryPasswordHasher();
  const useCase = new ChangePortalPassword(accounts, hasher);
  return { useCase, accounts, hasher };
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

  it('unknown accountId → PortalAccountNotFoundError', async () => {
    const { useCase } = makeUseCase();
    await expect(
      useCase.execute({ accountId: 'nope', currentPassword: 'x', newPassword: 'NewPass1' }),
    ).rejects.toThrow(PortalAccountNotFoundError);
  });
});
