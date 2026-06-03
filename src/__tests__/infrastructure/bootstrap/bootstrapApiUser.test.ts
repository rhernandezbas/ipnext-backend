import {
  bootstrapApiUser,
  API_USER_LOGIN,
  API_USER_NAME,
} from '@infrastructure/bootstrap/bootstrapApiUser';
import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';

const IMPOSSIBLE_HASH = '$2a$10$systemUserNeverLogsInXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';

describe('bootstrapApiUser (#15 — system "Api" reporter)', () => {
  it('creates the system "Api" user on a fresh DB', async () => {
    const userRepo = new InMemoryRbacUserRepository();

    const result = await bootstrapApiUser(userRepo, { passwordHash: IMPOSSIBLE_HASH });

    expect(result.outcome).toBe('created');
    expect(result.id).toBeTruthy();
    const created = await userRepo.findByLogin(API_USER_LOGIN);
    expect(created).not.toBeNull();
    expect(created!.name).toBe(API_USER_NAME);
    expect(created!.login).toBe(API_USER_LOGIN);
    expect(created!.id).toBe(result.id);
    // passwordHash stored verbatim — the system user can never log in.
    expect(created!.passwordHash).toBe(IMPOSSIBLE_HASH);
  });

  it('is idempotent: second run returns the SAME id and creates no duplicate', async () => {
    const userRepo = new InMemoryRbacUserRepository();

    const first = await bootstrapApiUser(userRepo, { passwordHash: IMPOSSIBLE_HASH });
    const second = await bootstrapApiUser(userRepo, { passwordHash: 'a-different-hash' });

    expect(second.outcome).toBe('exists');
    expect(second.id).toBe(first.id);
    const all = await userRepo.list();
    expect(all.filter(u => u.login === API_USER_LOGIN)).toHaveLength(1);
  });
});
