import { SettingsRepository } from '@domain/ports/SettingsRepository';
import { PaymentMethod } from '@domain/entities/settings';

export class CreatePaymentMethod {
  constructor(private readonly repo: SettingsRepository) {}

  execute(data: Omit<PaymentMethod, 'id'>): Promise<PaymentMethod> {
    return this.repo.createPaymentMethod(data);
  }
}
