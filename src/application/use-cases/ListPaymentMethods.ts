import { SettingsRepository } from '@domain/ports/SettingsRepository';
import { PaymentMethod } from '@domain/entities/settings';

export class ListPaymentMethods {
  constructor(private readonly repo: SettingsRepository) {}

  execute(): Promise<PaymentMethod[]> {
    return this.repo.getPaymentMethods();
  }
}
