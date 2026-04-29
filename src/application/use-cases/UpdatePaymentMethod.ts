import { SettingsRepository } from '@domain/ports/SettingsRepository';
import { PaymentMethod } from '@domain/entities/settings';

export class UpdatePaymentMethod {
  constructor(private readonly repo: SettingsRepository) {}

  execute(id: string, data: Partial<PaymentMethod>): Promise<PaymentMethod | null> {
    return this.repo.updatePaymentMethod(id, data);
  }
}
