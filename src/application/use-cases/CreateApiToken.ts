import { SettingsRepository } from '@domain/ports/SettingsRepository';
import { ApiToken } from '@domain/entities/settings';

export class CreateApiToken {
  constructor(private readonly repo: SettingsRepository) {}

  execute(name: string, permissions: string[]): Promise<ApiToken> {
    return this.repo.createApiToken(name, permissions);
  }
}
