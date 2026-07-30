/**
 * DeletePortalAccountAdmin — customer-portal-api (Fase 3, task 3.2).
 * Spec: portal-accounts-admin "Habilitar / deshabilitar / borrar / listar" — DELETE.
 */
import { DeletePortalAccountAdmin } from '@application/use-cases/portal-admin/DeletePortalAccountAdmin';
import { InMemoryPortalAccountRepository } from '@infrastructure/adapters/in-memory/InMemoryPortalAccountRepository';
import { InMemoryPortalSessionRepository } from '@infrastructure/adapters/in-memory/InMemoryPortalSessionRepository';
import { PortalAccountNotFoundError } from '@domain/errors/portal.errors';

async function build() {
  const accounts = new InMemoryPortalAccountRepository();
  const sessions = new InMemoryPortalSessionRepository();
  const useCase = new DeletePortalAccountAdmin(accounts, sessions);
  const account = await accounts.create({ clientId: 'client-1', dni: '30111222', passwordHash: 'h' });
  return { accounts, sessions, useCase, account };
}

describe('DeletePortalAccountAdmin', () => {
  it('borra la credencial — findById ya no la resuelve', async () => {
    const { useCase, account, accounts } = await build();
    await useCase.execute({ accountId: account.id });
    expect(await accounts.findById(account.id)).toBeNull();
  });

  it('revoca las sesiones de la cuenta al borrar', async () => {
    const { useCase, account, sessions } = await build();
    await sessions.create({ accountId: account.id, tokenHash: 'h1', expiresAt: new Date(Date.now() + 1000) });

    await useCase.execute({ accountId: account.id });

    const session = await sessions.findByTokenHash('h1');
    expect(session?.revokedAt).not.toBeNull();
  });

  it('404 si la cuenta no existe', async () => {
    const { useCase } = await build();
    await expect(useCase.execute({ accountId: 'ghost' })).rejects.toBeInstanceOf(PortalAccountNotFoundError);
  });
});
