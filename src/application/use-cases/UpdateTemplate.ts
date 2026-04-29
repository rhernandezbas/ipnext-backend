import { SettingsRepository } from '@domain/ports/SettingsRepository';
import { MessageTemplate } from '@domain/entities/settings';

export class UpdateTemplate {
  constructor(private readonly repo: SettingsRepository) {}

  execute(id: string, data: Partial<MessageTemplate>): Promise<MessageTemplate | null> {
    return this.repo.updateTemplate(id, data);
  }
}
