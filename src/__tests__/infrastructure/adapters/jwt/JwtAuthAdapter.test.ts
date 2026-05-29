import { JwtAuthAdapter } from '@infrastructure/adapters/jwt/JwtAuthAdapter';
import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import { InMemoryPasswordHasher } from '@infrastructure/adapters/in-memory/InMemoryPasswordHasher';
import { LoginRbacUser } from '@application/use-cases/rbac/LoginRbacUser';
import { AuthenticationError } from '@domain/errors';
import jwt from 'jsonwebtoken';

const TEST_SECRET = 'test-jwt-secret-32chars-minimum!';

function makeAdapter() {
  const repo = new InMemoryRbacUserRepository();
  const hasher = new InMemoryPasswordHasher();
  const loginUseCase = new LoginRbacUser(repo, hasher);
  const adapter = new JwtAuthAdapter(loginUseCase, TEST_SECRET);
  return { adapter, repo, hasher };
}

describe('JwtAuthAdapter', () => {
  describe('login', () => {
    it('valid credentials → JWT payload contains { id, login, email } matching the RbacUser', async () => {
      const { adapter, repo, hasher } = makeAdapter();
      const hash = await hasher.hash('pass1234');
      const created = await repo.create({
        name: 'Alice',
        email: 'alice@example.com',
        login: 'alice',
        passwordHash: hash,
        status: 'active',
      });

      const { cookieValue } = await adapter.login({ username: 'alice', password: 'pass1234' });

      // Decode without verify to inspect payload shape
      const decoded = jwt.decode(cookieValue) as Record<string, unknown>;
      expect(decoded.id).toBe(created.id);
      expect(decoded.login).toBe('alice');
      expect(decoded.email).toBe('alice@example.com');
      // Critically: NO legacy `role` field, NO `userId` field from old shape
      expect(decoded.role).toBeUndefined();
      expect(decoded.userId).toBeUndefined();
    });

    it('unknown login → throws AuthenticationError', async () => {
      const { adapter } = makeAdapter();
      await expect(adapter.login({ username: 'nobody', password: 'x' }))
        .rejects.toThrow(AuthenticationError);
    });

    it('wrong password → throws AuthenticationError', async () => {
      const { adapter, repo, hasher } = makeAdapter();
      await repo.create({
        name: 'Bob',
        email: 'bob@example.com',
        login: 'bob',
        passwordHash: await hasher.hash('correct'),
        status: 'active',
      });
      await expect(adapter.login({ username: 'bob', password: 'wrong' }))
        .rejects.toThrow(AuthenticationError);
    });

    it('returns login result user in the user field', async () => {
      const { adapter, repo, hasher } = makeAdapter();
      const hash = await hasher.hash('pass1234');
      const created = await repo.create({
        name: 'Carol',
        email: 'carol@example.com',
        login: 'carol',
        passwordHash: hash,
        status: 'active',
      });

      const { user } = await adapter.login({ username: 'carol', password: 'pass1234' });
      expect(user.id).toBe(created.id);
      expect(user.username).toBe('carol');
      expect(user.email).toBe('carol@example.com');
    });
  });

  describe('getSession', () => {
    it('valid token → returns User with id matching the RbacUser id', async () => {
      const { adapter, repo, hasher } = makeAdapter();
      const hash = await hasher.hash('pass1234');
      const created = await repo.create({
        name: 'Dave',
        email: 'dave@example.com',
        login: 'dave',
        passwordHash: hash,
        status: 'active',
      });

      const { cookieValue } = await adapter.login({ username: 'dave', password: 'pass1234' });
      const session = await adapter.getSession(cookieValue);

      expect(session.id).toBe(created.id);
      expect(session.username).toBe('dave');
      expect(session.email).toBe('dave@example.com');
    });

    it('invalid/tampered token → throws AuthenticationError', async () => {
      const { adapter } = makeAdapter();
      await expect(adapter.getSession('invalid.token.here'))
        .rejects.toThrow(AuthenticationError);
    });
  });

  describe('logout', () => {
    it('returns cookie options with maxAge: 0', () => {
      const { adapter } = makeAdapter();
      const { cookieOptions } = adapter.logout();
      expect(cookieOptions.maxAge).toBe(0);
    });
  });
});
