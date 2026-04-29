import { SettingsRepository } from '@domain/ports/SettingsRepository';
import { SystemSettings } from '@domain/entities/settings';

export class GetSystemSettings {
  constructor(private readonly repo: SettingsRepository) {}

  execute(): Promise<SystemSettings> {
    return this.repo.getSystemSettings();
  }
}
