import { FinanceTargetsConfig, FinanceTargetsConfigRepository } from '@domain/ports/FinanceTargetsConfigRepository';

/** finance-growth Fase 2 (spec.md "GetFinanceTargets devuelve los defaults seedeados si nunca se editó"). */
export class GetFinanceTargets {
  constructor(private readonly repo: FinanceTargetsConfigRepository) {}

  async execute(): Promise<FinanceTargetsConfig> {
    return this.repo.get();
  }
}
