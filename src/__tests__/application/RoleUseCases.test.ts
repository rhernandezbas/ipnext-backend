import { InMemoryRoleRepository } from '../../infrastructure/adapters/in-memory/InMemoryRoleRepository';
import { ListRoles } from '../../application/use-cases/ListRoles';
import { GetRole } from '../../application/use-cases/GetRole';
import { CreateRole } from '../../application/use-cases/CreateRole';

function makeRepo() {
  return new InMemoryRoleRepository();
}

describe('ListRoles', () => {
  it('returns all 6 seeded roles', async () => {
    const repo = makeRepo();
    const uc = new ListRoles(repo);

    const result = await uc.execute();

    expect(result).toHaveLength(6);
  });

  it('superadmin has all-module permissions', async () => {
    const repo = makeRepo();
    const uc = new ListRoles(repo);

    const result = await uc.execute();
    const superadmin = result.find(r => r.name === 'superadmin');

    expect(superadmin).toBeDefined();
    expect(superadmin!.permissions.length).toBeGreaterThanOrEqual(8);
    const modules = superadmin!.permissions.map(p => p.module);
    expect(modules).toContain('clients');
    expect(modules).toContain('billing');
    expect(modules).toContain('admins');
  });

  it('engineer has network write but not billing write', async () => {
    const repo = makeRepo();
    const uc = new ListRoles(repo);

    const result = await uc.execute();
    const engineer = result.find(r => r.name === 'engineer');

    expect(engineer).toBeDefined();

    const networkPerm = engineer!.permissions.find(p => p.module === 'network');
    expect(networkPerm).toBeDefined();
    expect(networkPerm!.actions).toContain('write');

    const billingPerm = engineer!.permissions.find(p => p.module === 'billing');
    const hasBillingWrite = billingPerm ? billingPerm.actions.includes('write') : false;
    expect(hasBillingWrite).toBe(false);
  });
});

describe('CreateRole', () => {
  it('creates role with permissions', async () => {
    const repo = makeRepo();
    const uc = new CreateRole(repo);

    const result = await uc.execute({
      name: 'custom_role',
      description: 'Custom test role',
      isSystem: false,
      permissions: [{ module: 'clients', actions: ['read'] }],
    });

    expect(result.id).toBeTruthy();
    expect(result.name).toBe('custom_role');
    expect(result.permissions).toHaveLength(1);
    expect(result.permissions[0].module).toBe('clients');
  });
});
