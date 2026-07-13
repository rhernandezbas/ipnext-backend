/**
 * F1.5-C2 (asignación) — ListAssignableUsers: pool asignable para el dropdown de
 * GET /messaging/assignable-users. Reusa la MISMA regla única de "asignable" que
 * `openspec/changes/recapture-assignable-roles` (design.md): active + ≥1 rol +
 * ningún rol técnico (`isTechnicalRoleSet`). Depende de `UserRoleLookup` (mismo
 * puerto minimal que `AssignRecaptureLeadsBulk`) en vez de `RbacUserRepository.
 * listRolesForUser` directo — ese método del in-memory adapter es un stub fijo
 * ([] siempre, ver InMemoryRbacUserRepository.ts:113-115), así que un port
 * inyectable es la única forma de testear el filtro sin Prisma real.
 */
import { ListAssignableUsers } from '@application/use-cases/messaging/ListAssignableUsers';
import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import type { UserRoleLookup } from '@domain/ports/UserRoleLookup';

function makeRoleLookup(byId: Record<string, string[]>): UserRoleLookup {
  return { listRoleCodes: async (id: string) => byId[id] ?? [] };
}

describe('ListAssignableUsers', () => {
  it('devuelve SOLO usuarios activos, con ≥1 rol, y sin rol técnico — {id, name} nada más', async () => {
    const userRepo = new InMemoryRbacUserRepository();
    const active = await userRepo.create({ name: 'Ana', email: 'ana@x.com', login: 'ana', passwordHash: 'hash-secreto', status: 'active' });
    const disabled = await userRepo.create({ name: 'Bruno', email: 'bruno@x.com', login: 'bruno', passwordHash: 'hash-secreto', status: 'disabled' });
    const technical = await userRepo.create({ name: 'Carlos', email: 'carlos@x.com', login: 'carlos', passwordHash: 'hash-secreto', status: 'active' });
    const noRole = await userRepo.create({ name: 'Diana', email: 'diana@x.com', login: 'diana', passwordHash: 'hash-secreto', status: 'active' });

    const roleLookup = makeRoleLookup({
      [active.id]: ['administrador'],
      [disabled.id]: ['administrador'],
      [technical.id]: ['tecnico'],
      [noRole.id]: [],
    });

    const uc = new ListAssignableUsers(userRepo, roleLookup);
    const result = await uc.execute();

    expect(result).toEqual([{ id: active.id, name: 'Ana' }]);
  });

  it('un usuario técnico Y no-técnico a la vez (roles múltiples) queda excluido igual', async () => {
    const userRepo = new InMemoryRbacUserRepository();
    const mixed = await userRepo.create({ name: 'Eva', email: 'eva@x.com', login: 'eva', passwordHash: 'x', status: 'active' });
    const roleLookup = makeRoleLookup({ [mixed.id]: ['ventas', 'tecnico'] });

    const uc = new ListAssignableUsers(userRepo, roleLookup);
    const result = await uc.execute();

    expect(result).toEqual([]);
  });

  it('sin usuarios asignables → array vacío, no un error', async () => {
    const userRepo = new InMemoryRbacUserRepository();
    const roleLookup = makeRoleLookup({});
    const uc = new ListAssignableUsers(userRepo, roleLookup);

    await expect(uc.execute()).resolves.toEqual([]);
  });

  it('NUNCA expone passwordHash ni otro campo sensible — el shape es exactamente {id, name}', async () => {
    const userRepo = new InMemoryRbacUserRepository();
    const user = await userRepo.create({ name: 'Fede', email: 'fede@x.com', login: 'fede', passwordHash: 'top-secret-hash', status: 'active' });
    const roleLookup = makeRoleLookup({ [user.id]: ['ventas'] });

    const uc = new ListAssignableUsers(userRepo, roleLookup);
    const result = await uc.execute();

    expect(result).toHaveLength(1);
    expect(Object.keys(result[0]!).sort()).toEqual(['id', 'name']);
  });
});
