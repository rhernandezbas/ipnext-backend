import { SettingsRepository } from '@domain/ports/SettingsRepository';
import { SystemSettings } from '@domain/entities/settings';

export class UpdateSystemSettings {
  constructor(private readonly repo: SettingsRepository) {}

  execute(data: Partial<SystemSettings>): Promise<SystemSettings> {
    return this.repo.updateSystemSettings(data);
  }
}
