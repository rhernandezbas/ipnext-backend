import { SettingsRepository } from '@domain/ports/SettingsRepository';

export class TestWebhook {
  constructor(private readonly repo: SettingsRepository) {}

  execute(id: string): Promise<{ success: boolean }> {
    return this.repo.testWebhook(id);
  }
}
