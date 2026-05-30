/**
 * RevokeAllSessionsForUser — revoke every active session of a user (SDD #5).
 * Returns how many were revoked. Idempotent (0 if none active).
 */
import type { SessionRepository } from '@domain/ports/SessionRepository';

export class RevokeAllSessionsForUser {
  constructor(private readonly repo: SessionRepository) {}

  execute(rbacUserId: string): Promise<number> {
    return this.repo.revokeAllForUser(rbacUserId);
  }
}
