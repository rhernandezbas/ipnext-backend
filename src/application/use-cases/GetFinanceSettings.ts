import { SettingsRepository } from '@domain/ports/SettingsRepository';
import { FinanceSettings } from '@domain/entities/settings';

export class GetFinanceSettings {
  constructor(private readonly repo: SettingsRepository) {}

  execute(): Promise<FinanceSettings> {
    return this.repo.getFinanceSettings();
  }
}
