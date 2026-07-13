import { bootstrapSystemUsers } from '@infrastructure/bootstrap/bootstrapSystemUsers';
import { API_USER_LOGIN, API_USER_NAME } from '@infrastructure/bootstrap/bootstrapApiUser';
import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';

const IMPOSSIBLE_HASH = '$2a$10$systemUserNeverLogsInXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';

/**
 * external-create-ticket T1 — the system "Api" reporter must exist INDEPENDENT of
 * Gestión Real. Previously `bootstrapApiUser` was only invoked from inside
 * `bootstrapGestionRealIngest`, behind two early-returns (GR disabled / missing
 * creds), so with GR off the `api` user was never created. Since GR is being
 * deprecated, its bootstrap now lives here and runs unconditionally from main.
 */
describe('bootstrapSystemUsers (T1 — desacople del usuario "Api" de GR)', () => {
  it('creates the system "Api" reporter on a fresh DB (no GR involved)', async () => {
    const userRepo = new InMemoryRbacUserRepository();

    const result = await bootstrapSystemUsers(userRepo, { passwordHash: IMPOSSIBLE_HASH });

    expect(result.apiUserId).toBeTruthy();
    const created = await userRepo.findByLogin(API_USER_LOGIN);
    expect(created).not.toBeNull();
    expect(created!.name).toBe(API_USER_NAME);
    expect(created!.login).toBe(API_USER_LOGIN);
    expect(created!.id).toBe(result.apiUserId);
  });

  it('is idempotent: second run returns the SAME api user id, no duplicate', async () => {
    const userRepo = new InMemoryRbacUserRepository();

    const first = await bootstrapSystemUsers(userRepo, { passwordHash: IMPOSSIBLE_HASH });
    const second = await bootstrapSystemUsers(userRepo, { passwordHash: 'a-different-hash' });

    expect(second.apiUserId).toBe(first.apiUserId);
    const all = await userRepo.list();
    expect(all.filter((u) => u.login === API_USER_LOGIN)).toHaveLength(1);
  });
});
