import { SettingsRepository } from '@domain/ports/SettingsRepository';

export class DeleteWebhook {
  constructor(private readonly repo: SettingsRepository) {}

  execute(id: string): Promise<boolean> {
    return this.repo.deleteWebhook(id);
  }
}
