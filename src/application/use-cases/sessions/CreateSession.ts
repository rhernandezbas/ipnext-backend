/**
 * CreateSession — records a login session (SDD #5).
 * Called from the login route after the JWT is signed (fail-safe: no token if this throws).
 */
import type { Session } from '@domain/entities/session';
import type { SessionRepository, CreateSessionInput } from '@domain/ports/SessionRepository';

export class CreateSession {
  constructor(private readonly repo: SessionRepository) {}

  execute(input: CreateSessionInput): Promise<Session> {
    return this.repo.create(input);
  }
}
