/**
 * CreatePortalAccount — customer-portal-api (Fase 3, task 3.1).
 * Spec: portal-accounts-admin "Crear cuenta con password autogenerada".
 */
import { CreatePortalAccount } from '@application/use-cases/portal-admin/CreatePortalAccount';
import { InMemoryPortalAccountRepository } from '@infrastructure/adapters/in-memory/InMemoryPortalAccountRepository';
import { InMemoryClientPortalLookup } from '@infrastructure/adapters/in-memory/InMemoryClientPortalLookup';
import { InMemoryPasswordHasher } from '@infrastructure/adapters/in-memory/InMemoryPasswordHasher';
import { ClientNotFoundError } from '@domain/errors';
import {
  PortalDniAlreadyUsedError,
  PortalAccountAlreadyExistsError,
  PortalAccountDniRequiredError,
} from '@domain/errors/portalAdmin.errors';

function build() {
  const accounts = new InMemoryPortalAccountRepository();
  const clients = new InMemoryClientPortalLookup();
  const hasher = new InMemoryPasswordHasher();
  const useCase = new CreatePortalAccount(accounts, clients, hasher, () => 'FIXED-PASS-WORD');
  return { accounts, clients, hasher, useCase };
}

describe('CreatePortalAccount', () => {
  it('Alta del beta: crea la cuenta active + mustChangePassword=true, devuelve la password una vez', async () => {
    const { clients, useCase, accounts } = build();
    clients.seed('client-ronald', 'Ronald Hernández', { documento: '17883799' });

    const result = await useCase.execute({ clientId: 'client-ronald' });

    expect(result.password).toBe('FIXED-PASS-WORD');
    expect(result.status).toBe('active');
    expect(result.mustChangePassword).toBe(true);
    expect(result.dni).toBe('17883799');
    expect(result.clientId).toBe('client-ronald');
    expect((result as unknown as Record<string, unknown>).passwordHash).toBeUndefined();

    const stored = await accounts.findByClientId('client-ronald');
    expect(stored).not.toBeNull();
    expect(stored?.passwordHash).not.toBe('FIXED-PASS-WORD'); // hashed, never plain
  });

  it('defaultea el dni desde customAttributes.documento cuando no hay override', async () => {
    const { clients, useCase } = build();
    clients.seed('client-1', 'Cliente Uno', { documento: '30111222' });

    const result = await useCase.execute({ clientId: 'client-1' });
    expect(result.dni).toBe('30111222');
  });

  it('el operador puede overridear el dni del espejo', async () => {
    const { clients, useCase } = build();
    clients.seed('client-1', 'Cliente Uno', { documento: '30111222' });

    const result = await useCase.execute({ clientId: 'client-1', dni: '99888777' });
    expect(result.dni).toBe('99888777');
  });

  it('404 si el cliente no existe', async () => {
    const { useCase } = build();
    await expect(useCase.execute({ clientId: 'ghost' })).rejects.toBeInstanceOf(ClientNotFoundError);
  });

  it('409 si el dni ya tiene cuenta (aunque sea de otro cliente)', async () => {
    const { clients, useCase } = build();
    clients.seed('client-1', 'Cliente Uno', { documento: '30111222' });
    clients.seed('client-2', 'Cliente Dos', { documento: '30111222' });

    await useCase.execute({ clientId: 'client-1' });
    await expect(useCase.execute({ clientId: 'client-2' })).rejects.toBeInstanceOf(PortalDniAlreadyUsedError);
  });

  it('409 si el clientId ya tiene cuenta', async () => {
    const { clients, useCase } = build();
    clients.seed('client-1', 'Cliente Uno', { documento: '30111222' });

    await useCase.execute({ clientId: 'client-1' });
    await expect(useCase.execute({ clientId: 'client-1', dni: '11111111' })).rejects.toBeInstanceOf(
      PortalAccountAlreadyExistsError,
    );
  });

  it('422 si el cliente no tiene documento en el espejo y el operador no pasa dni', async () => {
    const { clients, useCase } = build();
    clients.seed('client-1', 'Cliente Sin Doc', { documento: null });

    await expect(useCase.execute({ clientId: 'client-1' })).rejects.toBeInstanceOf(PortalAccountDniRequiredError);
  });

  it('422 si customAttributes no tiene la key documento y no hay override', async () => {
    const { clients, useCase } = build();
    clients.seed('client-1', 'Cliente Sin CustomAttrs', {});

    await expect(useCase.execute({ clientId: 'client-1' })).rejects.toBeInstanceOf(PortalAccountDniRequiredError);
  });

  it('la password NUNCA queda en texto plano en el store (solo el hash)', async () => {
    const { clients, useCase, accounts } = build();
    clients.seed('client-1', 'Cliente Uno', { documento: '30111222' });
    await useCase.execute({ clientId: 'client-1' });
    const stored = await accounts.findByClientId('client-1');
    expect(stored?.passwordHash).toMatch(/^hashed::/); // InMemoryPasswordHasher marker prefix
  });
});
