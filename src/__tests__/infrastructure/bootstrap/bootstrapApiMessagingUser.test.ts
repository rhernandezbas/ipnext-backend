/**
 * external-bulk-messaging (D2/1.10) — bootstrap idempotente del system user
 * "api-messaging" (createdById de las campañas creadas por `SendExternalBulk`).
 * Molde EXACTO `bootstrapApiUser.test.ts` — mismos 2 casos, sobre el login nuevo.
 */
import {
  bootstrapApiMessagingUser,
  API_MESSAGING_USER_LOGIN,
  API_MESSAGING_USER_NAME,
} from '@infrastructure/bootstrap/bootstrapApiMessagingUser';
import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';

const IMPOSSIBLE_HASH = '$2a$10$systemUserNeverLogsInXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';

describe('bootstrapApiMessagingUser (external-bulk-messaging D2 — system "api-messaging" user)', () => {
  it('creates the system "api-messaging" user on a fresh DB', async () => {
    const userRepo = new InMemoryRbacUserRepository();

    const result = await bootstrapApiMessagingUser(userRepo, { passwordHash: IMPOSSIBLE_HASH });

    expect(result.outcome).toBe('created');
    expect(result.id).toBeTruthy();
    const created = await userRepo.findByLogin(API_MESSAGING_USER_LOGIN);
    expect(created).not.toBeNull();
    expect(created!.name).toBe(API_MESSAGING_USER_NAME);
    expect(created!.login).toBe(API_MESSAGING_USER_LOGIN);
    expect(created!.id).toBe(result.id);
    // passwordHash stored verbatim — the system user can never log in.
    expect(created!.passwordHash).toBe(IMPOSSIBLE_HASH);
  });

  it('is idempotent: second run returns the SAME id and creates no duplicate', async () => {
    const userRepo = new InMemoryRbacUserRepository();

    const first = await bootstrapApiMessagingUser(userRepo, { passwordHash: IMPOSSIBLE_HASH });
    const second = await bootstrapApiMessagingUser(userRepo, { passwordHash: 'a-different-hash' });

    expect(second.outcome).toBe('exists');
    expect(second.id).toBe(first.id);
    const all = await userRepo.list();
    expect(all.filter((u) => u.login === API_MESSAGING_USER_LOGIN)).toHaveLength(1);
  });

  it('does NOT collide with the "api" system user (independent logins)', async () => {
    const userRepo = new InMemoryRbacUserRepository();

    const apiMessaging = await bootstrapApiMessagingUser(userRepo, { passwordHash: IMPOSSIBLE_HASH });

    const all = await userRepo.list();
    expect(all.filter((u) => u.login === 'api')).toHaveLength(0);
    expect(all.filter((u) => u.login === API_MESSAGING_USER_LOGIN)).toHaveLength(1);
    expect(apiMessaging.outcome).toBe('created');
  });
});
