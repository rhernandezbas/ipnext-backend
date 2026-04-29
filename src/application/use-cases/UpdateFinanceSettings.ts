import { SettingsRepository } from '@domain/ports/SettingsRepository';
import { FinanceSettings } from '@domain/entities/settings';

export class UpdateFinanceSettings {
  constructor(private readonly repo: SettingsRepository) {}

  execute(data: Partial<FinanceSettings>): Promise<FinanceSettings> {
    return this.repo.updateFinanceSettings(data);
  }
}
