import { SettingsRepository } from '@domain/ports/SettingsRepository';
import { ClientPortalSettings } from '@domain/entities/settings';

export class UpdateClientPortalSettings {
  constructor(private readonly repo: SettingsRepository) {}

  execute(data: Partial<ClientPortalSettings>): Promise<ClientPortalSettings> {
    return this.repo.updateClientPortalSettings(data);
  }
}
