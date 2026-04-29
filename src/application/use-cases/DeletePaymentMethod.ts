import { SettingsRepository } from '@domain/ports/SettingsRepository';

export class DeletePaymentMethod {
  constructor(private readonly repo: SettingsRepository) {}

  execute(id: string): Promise<boolean> {
    return this.repo.deletePaymentMethod(id);
  }
}
