import { SettingsRepository } from '@domain/ports/SettingsRepository';
import { ClientPortalSettings } from '@domain/entities/settings';

export class GetClientPortalSettings {
  constructor(private readonly repo: SettingsRepository) {}

  execute(): Promise<ClientPortalSettings> {
    return this.repo.getClientPortalSettings();
  }
}
