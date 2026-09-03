import type { CreditBalancePort } from '@domain/ports/CreditBalancePort';
import type { MessagingRatesConfigRepository } from '@domain/ports/MessagingRatesConfigRepository';

/**
 * twilio-credit-guard (D4.d, CRED-1/CRED-2) — alimenta `GET /credit` (B3) y
 * la card FE (`GET /config/rates/balance`, B3). A diferencia del uso
 * ADVISORY en `ValidateExternalBulk`, acá un balance inalcanzable SÍ es un
 * error propagado: es lo único que este endpoint de solo-lectura devuelve.
 */
export interface GetMessagingCreditOutput {
  available: string;
  currency: string;
  fetchedAt: string;
  cached: boolean;
  rates: {
    currency: string;
    utilityRate: string;
    marketingRate: string;
    authenticationRate: string;
    providerFee: string;
    updatedAt: string;
  };
}

export class GetMessagingCredit {
  constructor(
    private readonly creditPort: CreditBalancePort,
    private readonly ratesRepo: MessagingRatesConfigRepository,
  ) {}

  /** Throws `CreditUnavailableError` (propagado tal cual del port) — CRED-2. */
  async execute(): Promise<GetMessagingCreditOutput> {
    const [balance, rates] = await Promise.all([this.creditPort.getBalance(), this.ratesRepo.get()]);
    return {
      available: balance.amount,
      currency: balance.currency,
      fetchedAt: balance.fetchedAt.toISOString(),
      cached: balance.cached,
      rates: {
        currency: rates.currency,
        utilityRate: rates.utilityRate,
        marketingRate: rates.marketingRate,
        authenticationRate: rates.authenticationRate,
        providerFee: rates.providerFee,
        updatedAt: rates.updatedAt,
      },
    };
  }
}
