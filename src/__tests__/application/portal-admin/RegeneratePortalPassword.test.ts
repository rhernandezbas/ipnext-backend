/**
 * RegeneratePortalPassword — customer-portal-api (Fase 3, task 3.2).
 * Spec: portal-accounts-admin "Regenerar password" — "Cliente olvidó su password".
 */
import { RegeneratePortalPassword } from '@application/use-cases/portal-admin/RegeneratePortalPassword';
import { InMemoryPortalAccountRepository } from '@infrastructure/adapters/in-memory/InMemoryPortalAccountRepository';
import { InMemoryPortalSessionRepository } from '@infrastructure/adapters/in-memory/InMemoryPortalSessionRepository';
import { InMemoryPasswordHasher } from '@infrastructure/adapters/in-memory/InMemoryPasswordHasher';
import { PortalAccountNotFoundError } from '@domain/errors/portal.errors';

async function build() {
  const accounts = new InMemoryPortalAccountRepository();
  const sessions = new InMemoryPortalSessionRepository();
  const hasher = new InMemoryPasswordHasher();
  const useCase = new RegeneratePortalPassword(accounts, sessions, hasher, () => 'NEW-FIXED-PASS');

  const account = await accounts.create({ clientId: 'client-1', dni: '30111222', passwordHash: await hasher.hash('OldPass') });
  return { accounts, sessions, hasher, useCase, account };
}

describe('RegeneratePortalPassword', () => {
  it('genera una password nueva, muestra en texto plano una vez, marca mustChangePassword=true', async () => {
    const { useCase, account } = await build();
    const result = await useCase.execute({ accountId: account.id });

    expect(result.password).toBe('NEW-FIXED-PASS');
    expect(result.mustChangePassword).toBe(true);
    expect((result as unknown as Record<string, unknown>).passwordHash).toBeUndefined();
  });

  it('la password anterior deja de servir (hash actualizado)', async () => {
    const { useCase, account, accounts, hasher } = await build();
    await useCase.execute({ accountId: account.id });
    const stored = await accounts.findById(account.id);
    expect(stored?.passwordHash).not.toBe(await hasher.hash('OldPass'));
    expect(stored?.passwordHash).toBe(await hasher.hash('NEW-FIXED-PASS'));
  });

  it('revoca TODAS las sesiones activas de la cuenta', async () => {
    const { useCase, account, sessions } = await build();
    const s1 = await sessions.create({ accountId: account.id, tokenHash: 'hash-1', expiresAt: new Date(Date.now() + 1000) });
    const s2 = await sessions.create({ accountId: account.id, tokenHash: 'hash-2', expiresAt: new Date(Date.now() + 1000) });

    await useCase.execute({ accountId: account.id });

    const found1 = await sessions.findByTokenHash('hash-1');
    const found2 = await sessions.findByTokenHash('hash-2');
    expect(found1?.revokedAt).not.toBeNull();
    expect(found2?.revokedAt).not.toBeNull();
    expect(s1.revokedAt).toBeNull(); // sanity: were alive before regeneration
    expect(s2.revokedAt).toBeNull();
  });

  it('404 si la cuenta no existe', async () => {
    const { useCase } = await build();
    await expect(useCase.execute({ accountId: 'ghost' })).rejects.toBeInstanceOf(PortalAccountNotFoundError);
  });
});
