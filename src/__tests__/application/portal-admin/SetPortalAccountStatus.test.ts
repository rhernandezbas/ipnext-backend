/**
 * SetPortalAccountStatus — customer-portal-api (Fase 3, task 3.2).
 * Spec: portal-accounts-admin "Habilitar / deshabilitar" — "Deshabilitar corta el acceso ya emitido".
 */
import { SetPortalAccountStatus } from '@application/use-cases/portal-admin/SetPortalAccountStatus';
import { InMemoryPortalAccountRepository } from '@infrastructure/adapters/in-memory/InMemoryPortalAccountRepository';
import { InMemoryPortalSessionRepository } from '@infrastructure/adapters/in-memory/InMemoryPortalSessionRepository';
import { PortalAccountNotFoundError } from '@domain/errors/portal.errors';

async function build() {
  const accounts = new InMemoryPortalAccountRepository();
  const sessions = new InMemoryPortalSessionRepository();
  const useCase = new SetPortalAccountStatus(accounts, sessions);
  const account = await accounts.create({ clientId: 'client-1', dni: '30111222', passwordHash: 'h' });
  return { accounts, sessions, useCase, account };
}

describe('SetPortalAccountStatus', () => {
  it('deshabilita la cuenta y revoca TODAS las sesiones activas', async () => {
    const { useCase, account, sessions, accounts } = await build();
    await sessions.create({ accountId: account.id, tokenHash: 'h1', expiresAt: new Date(Date.now() + 1000) });

    const result = await useCase.execute({ accountId: account.id, status: 'disabled' });

    expect(result.status).toBe('disabled');
    const stored = await accounts.findById(account.id);
    expect(stored?.status).toBe('disabled');
    const session = await sessions.findByTokenHash('h1');
    expect(session?.revokedAt).not.toBeNull();
  });

  it('habilita una cuenta disabled SIN tocar sesiones (ya estaban todas revocadas/muertas)', async () => {
    const { useCase, account, accounts } = await build();
    await useCase.execute({ accountId: account.id, status: 'disabled' });

    const result = await useCase.execute({ accountId: account.id, status: 'active' });
    expect(result.status).toBe('active');
    const stored = await accounts.findById(account.id);
    expect(stored?.status).toBe('active');
  });

  it('404 si la cuenta no existe', async () => {
    const { useCase } = await build();
    await expect(useCase.execute({ accountId: 'ghost', status: 'disabled' })).rejects.toBeInstanceOf(
      PortalAccountNotFoundError,
    );
  });
});
