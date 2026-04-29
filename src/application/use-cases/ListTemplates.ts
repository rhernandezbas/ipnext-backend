import { SettingsRepository } from '@domain/ports/SettingsRepository';
import { MessageTemplate } from '@domain/entities/settings';

export class ListTemplates {
  constructor(private readonly repo: SettingsRepository) {}

  execute(): Promise<MessageTemplate[]> {
    return this.repo.getTemplates();
  }
}
