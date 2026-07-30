/**
 * customer-portal-api (Fase 6, task 6.1) — DeleteMyPortalAccount.
 *
 * portal-account-deletion spec: "Borrado in-app por el propio cliente",
 * "El Client del ISP queda intacto", "Auditoría del borrado". Fixtures con
 * >=2 cuentas seedeadas (anti-IDOR / no-degenerado).
 */
import { DeleteMyPortalAccount } from '@application/use-cases/portal/DeleteMyPortalAccount';
import { InvalidCurrentPortalPasswordError, PortalAccountNotFoundError } from '@domain/errors/portal.errors';
import { InMemoryPortalAccountRepository } from '@infrastructure/adapters/in-memory/InMemoryPortalAccountRepository';
import { InMemoryPortalSessionRepository } from '@infrastructure/adapters/in-memory/InMemoryPortalSessionRepository';
import { InMemoryPasswordHasher } from '@infrastructure/adapters/in-memory/InMemoryPasswordHasher';

describe('DeleteMyPortalAccount — customer-portal-api Fase 6.1', () => {
  it('scenario "Cliente borra su cuenta desde la app": confirma con password actual -> cuenta y sesiones desaparecen', async () => {
    const accounts = new InMemoryPortalAccountRepository();
    const sessions = new InMemoryPortalSessionRepository();
    const hasher = new InMemoryPasswordHasher();
    const auditEvents: unknown[] = [];

    const accountA = await accounts.create({ clientId: 'client-a', dni: '30111222', passwordHash: await hasher.hash('Secret123') });
    await sessions.create({ accountId: accountA.id, tokenHash: 'hash-1', expiresAt: new Date(Date.now() + 60_000) });
    await sessions.create({ accountId: accountA.id, tokenHash: 'hash-2', expiresAt: new Date(Date.now() + 60_000) });
    // Segunda cuenta seedeada — no-degenerado / prueba que el borrado de A no toca a B.
    const accountB = await accounts.create({ clientId: 'client-b', dni: '30999888', passwordHash: await hasher.hash('OtherPass1') });
    await sessions.create({ accountId: accountB.id, tokenHash: 'hash-b', expiresAt: new Date(Date.now() + 60_000) });

    const useCase = new DeleteMyPortalAccount(accounts, sessions, hasher, (e) => auditEvents.push(e));

    await useCase.execute({ accountId: accountA.id, password: 'Secret123' });

    expect(await accounts.findById(accountA.id)).toBeNull();
    expect(await sessions.findByTokenHash('hash-1')).toBeNull();
    expect(await sessions.findByTokenHash('hash-2')).toBeNull();
    // La cuenta B (y sus sesiones) quedan intactas.
    expect(await accounts.findById(accountB.id)).not.toBeNull();
    expect(await sessions.findByTokenHash('hash-b')).not.toBeNull();
  });

  it('scenario "Confirmación incorrecta": password mala -> error, cuenta y sesiones intactas', async () => {
    const accounts = new InMemoryPortalAccountRepository();
    const sessions = new InMemoryPortalSessionRepository();
    const hasher = new InMemoryPasswordHasher();
    const account = await accounts.create({ clientId: 'client-a', dni: '30111222', passwordHash: await hasher.hash('Secret123') });
    await sessions.create({ accountId: account.id, tokenHash: 'hash-1', expiresAt: new Date(Date.now() + 60_000) });
    const useCase = new DeleteMyPortalAccount(accounts, sessions, hasher);

    await expect(useCase.execute({ accountId: account.id, password: 'WrongPass' })).rejects.toThrow(InvalidCurrentPortalPasswordError);

    expect(await accounts.findById(account.id)).not.toBeNull();
    expect(await sessions.findByTokenHash('hash-1')).not.toBeNull();
  });

  it('cuenta inexistente -> PortalAccountNotFoundError', async () => {
    const accounts = new InMemoryPortalAccountRepository();
    const sessions = new InMemoryPortalSessionRepository();
    const hasher = new InMemoryPasswordHasher();
    const useCase = new DeleteMyPortalAccount(accounts, sessions, hasher);

    await expect(useCase.execute({ accountId: 'no-existe', password: 'x' })).rejects.toThrow(PortalAccountNotFoundError);
  });

  it('scenario "Auditoría del borrado": deja un evento con accountId, clientId y timestamp, SIN password ni tokens', async () => {
    const accounts = new InMemoryPortalAccountRepository();
    const sessions = new InMemoryPortalSessionRepository();
    const hasher = new InMemoryPasswordHasher();
    const account = await accounts.create({ clientId: 'client-a', dni: '30111222', passwordHash: await hasher.hash('Secret123') });
    const auditEvents: Array<{ portalAccountId: string; clientId: string; deletedAt: string }> = [];
    const useCase = new DeleteMyPortalAccount(accounts, sessions, hasher, (e) => auditEvents.push(e));

    await useCase.execute({ accountId: account.id, password: 'Secret123' });

    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]).toEqual({ portalAccountId: account.id, clientId: 'client-a', deletedAt: expect.any(String) });
    const serialized = JSON.stringify(auditEvents[0]);
    expect(serialized).not.toContain('Secret123');
    expect(serialized.toLowerCase()).not.toContain('password');
    expect(serialized.toLowerCase()).not.toContain('token');
  });

  it('scenario "Recreación posterior": tras borrar, el DNI queda libre para una cuenta nueva sin conflicto', async () => {
    const accounts = new InMemoryPortalAccountRepository();
    const sessions = new InMemoryPortalSessionRepository();
    const hasher = new InMemoryPasswordHasher();
    const account = await accounts.create({ clientId: 'client-a', dni: '30111222', passwordHash: await hasher.hash('Secret123') });
    const useCase = new DeleteMyPortalAccount(accounts, sessions, hasher);

    await useCase.execute({ accountId: account.id, password: 'Secret123' });

    // El operador puede recrear la cuenta con el MISMO clientId/dni sin 409.
    const recreated = await accounts.create({ clientId: 'client-a', dni: '30111222', passwordHash: await hasher.hash('NewPass123') });
    expect(recreated.id).not.toBe(account.id);
    expect(await accounts.findByDni('30111222')).toEqual(recreated);
  });
});
