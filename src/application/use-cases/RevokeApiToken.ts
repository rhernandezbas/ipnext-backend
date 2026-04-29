import { SettingsRepository } from '@domain/ports/SettingsRepository';

export class RevokeApiToken {
  constructor(private readonly repo: SettingsRepository) {}

  execute(id: string): Promise<boolean> {
    return this.repo.revokeApiToken(id);
  }
}
