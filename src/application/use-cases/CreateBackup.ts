import { SettingsRepository } from '@domain/ports/SettingsRepository';
import { BackupRecord } from '@domain/entities/settings';

export class CreateBackup {
  constructor(private readonly repo: SettingsRepository) {}

  execute(): Promise<BackupRecord> {
    return this.repo.createBackup();
  }
}
