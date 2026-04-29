import { RadiusSessionRepository } from '@domain/ports/RadiusSessionRepository';

export class DisconnectSession {
  constructor(private readonly repo: RadiusSessionRepository) {}

  execute(id: string): Promise<{ success: boolean }> {
    return this.repo.disconnectSession(id);
  }
}
