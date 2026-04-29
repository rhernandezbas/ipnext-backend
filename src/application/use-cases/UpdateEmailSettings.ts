import { SettingsRepository } from '@domain/ports/SettingsRepository';
import { EmailSettings } from '@domain/entities/settings';

export class UpdateEmailSettings {
  constructor(private readonly repo: SettingsRepository) {}

  execute(data: Partial<EmailSettings>): Promise<EmailSettings> {
    return this.repo.updateEmailSettings(data);
  }
}
