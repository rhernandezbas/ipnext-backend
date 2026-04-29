import { SettingsRepository } from '@domain/ports/SettingsRepository';
import { BackupRecord } from '@domain/entities/settings';

export class ListBackups {
  constructor(private readonly repo: SettingsRepository) {}

  execute(): Promise<BackupRecord[]> {
    return this.repo.getBackups();
  }
}
