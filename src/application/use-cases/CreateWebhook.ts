import { SettingsRepository } from '@domain/ports/SettingsRepository';
import { Webhook } from '@domain/entities/settings';

export class CreateWebhook {
  constructor(private readonly repo: SettingsRepository) {}

  execute(data: Omit<Webhook, 'id' | 'createdAt' | 'lastTriggered' | 'lastStatus'>): Promise<Webhook> {
    return this.repo.createWebhook(data);
  }
}
