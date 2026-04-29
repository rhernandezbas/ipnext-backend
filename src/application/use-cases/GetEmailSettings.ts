import { SettingsRepository } from '@domain/ports/SettingsRepository';
import { EmailSettings } from '@domain/entities/settings';

export class GetEmailSettings {
  constructor(private readonly repo: SettingsRepository) {}

  execute(): Promise<EmailSettings> {
    return this.repo.getEmailSettings();
  }
}
