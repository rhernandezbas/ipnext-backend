import { InMemoryAdminRepository } from '../../infrastructure/adapters/in-memory/InMemoryAdminRepository';
import { ListAdmins } from '../../application/use-cases/ListAdmins';
import { GetAdmin } from '../../application/use-cases/GetAdmin';
import { CreateAdmin } from '../../application/use-cases/CreateAdmin';
import { UpdateAdmin } from '../../application/use-cases/UpdateAdmin';
import { DeleteAdmin } from '../../application/use-cases/DeleteAdmin';
import { GetAdminActivityLog } from '../../application/use-cases/GetAdminActivityLog';

function makeRepo() {
  return new InMemoryAdminRepository();
}

describe('ListAdmins', () => {
  it('returns all 3 seeded admins', async () => {
    const repo = makeRepo();
    const uc = new ListAdmins(repo);

    const result = await uc.execute();

    expect(result).toHaveLength(3);
    expect(result[0].name).toBe('Super Admin');
    expect(result[1].name).toBe('Carlos López');
    expect(result[2].name).toBe('María Fernández');
  });
});

describe('GetAdmin', () => {
  it('returns correct admin by id', async () => {
    const repo = makeRepo();
    const uc = new GetAdmin(repo);

    const result = await uc.execute('1');

    expect(result).not.toBeNull();
    expect(result!.id).toBe('1');
    expect(result!.email).toBe('admin@ipnext.com.ar');
    expect(result!.role).toBe('superadmin');
  });

  it('returns null for unknown id', async () => {
    const repo = makeRepo();
    const uc = new GetAdmin(repo);

    const result = await uc.execute('999');

    expect(result).toBeNull();
  });
});

describe('CreateAdmin', () => {
  it('creates admin with correct fields', async () => {
    const repo = makeRepo();
    const uc = new CreateAdmin(repo);

    const result = await uc.execute({
      name: 'Nuevo Admin',
      email: 'nuevo@ipnext.com.ar',
      role: 'admin',
      status: 'active',
    });

    expect(result.id).toBeTruthy();
    expect(result.name).toBe('Nuevo Admin');
    expect(result.email).toBe('nuevo@ipnext.com.ar');
    expect(result.role).toBe('admin');
    expect(result.status).toBe('active');
    expect(result.createdAt).toBeTruthy();
    expect(result.lastLogin).toBeNull();
  });
});

describe('UpdateAdmin', () => {
  it('updates admin role', async () => {
    const repo = makeRepo();
    const uc = new UpdateAdmin(repo);

    const result = await uc.execute('2', { role: 'viewer' });

    expect(result).not.toBeNull();
    expect(result!.id).toBe('2');
    expect(result!.role).toBe('viewer');
    expect(result!.name).toBe('Carlos López');
  });
});

describe('DeleteAdmin', () => {
  it('removes admin and returns true', async () => {
    const repo = makeRepo();
    const uc = new DeleteAdmin(repo);

    const result = await uc.execute('3');

    expect(result).toBe(true);

    const listUc = new ListAdmins(repo);
    const remaining = await listUc.execute();
    expect(remaining).toHaveLength(2);
    expect(remaining.find(a => a.id === '3')).toBeUndefined();
  });
});

describe('GetAdminActivityLog', () => {
  it('returns 12 activity log entries', async () => {
    const repo = makeRepo();
    const uc = new GetAdminActivityLog(repo);

    const result = await uc.execute();

    expect(result).toHaveLength(12);
    expect(result[0].id).toBeTruthy();
    expect(result[0].adminId).toBeTruthy();
    expect(result[0].category).toBeTruthy();
    expect(result[0].action).toBeTruthy();
    expect(result[0].ip).toBeTruthy();
    expect(result[0].timestamp).toBeTruthy();
  });

  it('filters by category', async () => {
    const repo = makeRepo();
    const uc = new GetAdminActivityLog(repo);

    const result = await uc.execute('auth');

    expect(result.length).toBeGreaterThan(0);
    expect(result.every(l => l.category === 'auth')).toBe(true);
  });
});
