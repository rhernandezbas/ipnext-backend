import { RadiusSessionRepository } from '@domain/ports/RadiusSessionRepository';
import { RadiusSession } from '@domain/entities/radiusSessions';

export class ListRadiusSessions {
  constructor(private readonly repo: RadiusSessionRepository) {}

  execute(): Promise<RadiusSession[]> {
    return this.repo.listSessions();
  }
}
