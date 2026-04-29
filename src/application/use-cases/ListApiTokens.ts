import { SettingsRepository } from '@domain/ports/SettingsRepository';
import { ApiToken } from '@domain/entities/settings';

export class ListApiTokens {
  constructor(private readonly repo: SettingsRepository) {}

  execute(): Promise<ApiToken[]> {
    return this.repo.getApiTokens();
  }
}
