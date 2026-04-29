import { SettingsRepository } from '@domain/ports/SettingsRepository';
import { Webhook } from '@domain/entities/settings';

export class ListWebhooks {
  constructor(private readonly repo: SettingsRepository) {}

  execute(): Promise<Webhook[]> {
    return this.repo.getWebhooks();
  }
}
