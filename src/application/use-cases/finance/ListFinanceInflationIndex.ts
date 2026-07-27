import { FinanceInflationIndex, FinanceInflationIndexRepository } from '@domain/ports/FinanceInflationIndexRepository';

/** finance-growth Fase 2 (spec.md, `GET /config/inflation`). Thin pass-through — ordering/filtering lives in the port contract. */
export class ListFinanceInflationIndex {
  constructor(private readonly repo: FinanceInflationIndexRepository) {}

  async execute(fromYearMonth?: string, toYearMonth?: string): Promise<FinanceInflationIndex[]> {
    return this.repo.list(fromYearMonth, toYearMonth);
  }
}
