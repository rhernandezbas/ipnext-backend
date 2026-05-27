/**
 * TDD — Feature A: set password when creating an administrator
 * Tests CreateAdmin use-case: password is hashed and stored via the repo.
 * Uses InMemoryAdminRepository.
 */
import { InMemoryAdminRepository } from '../../infrastructure/adapters/in-memory/InMemoryAdminRepository';
import { CreateAdmin } from '../../application/use-cases/CreateAdmin';

describe('CreateAdmin — password hashing', () => {
  it('stores a bcrypt hash in the repo when a password is provided', async () => {
    const repo = new InMemoryAdminRepository();
    const uc = new CreateAdmin(repo);

    await uc.execute({
      name: 'Test Admin',
      email: 'test@ipnext.com.ar',
      role: 'admin',
      status: 'active',
      password: 'secret123',
    });

    // The in-memory repo exposes a helper to inspect the stored passwordHash
    const stored = await repo.findByEmailWithHash('test@ipnext.com.ar');
    expect(stored).not.toBeNull();
    // A bcrypt hash always starts with $2b$
    expect(stored!.passwordHash).toMatch(/^\$2b\$/);
    // The hash must NOT equal the raw password
    expect(stored!.passwordHash).not.toBe('secret123');
  });

  it('does NOT expose passwordHash in the returned Admin DTO', async () => {
    const repo = new InMemoryAdminRepository();
    const uc = new CreateAdmin(repo);

    const admin = await uc.execute({
      name: 'Safe Admin',
      email: 'safe@ipnext.com.ar',
      role: 'admin',
      status: 'active',
      password: 'secret',
    });

    expect((admin as unknown as Record<string, unknown>)['passwordHash']).toBeUndefined();
  });
});
