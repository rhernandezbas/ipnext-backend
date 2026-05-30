/**
 * RevokeSession — revoke a single session by id (SDD #5).
 */
import type { SessionRepository } from '@domain/ports/SessionRepository';
import { SessionNotFoundError } from '@domain/errors/session.errors';

export class RevokeSession {
  constructor(private readonly repo: SessionRepository) {}

  async execute(id: string): Promise<void> {
    const session = await this.repo.findById(id);
    if (!session) throw new SessionNotFoundError(id);
    await this.repo.revoke(id);
  }
}
