import type { ContractServiceEventRepository, ContractServiceEventWithClient } from '@domain/ports/ContractServiceEventRepository';
import type { ServiceCatalogRepository } from '@domain/ports/ServiceCatalogRepository';
import type { FinanceCohortSnapshot, FinanceCohortSnapshotRepository } from '@domain/ports/FinanceCohortSnapshotRepository';
import { arYearMonth, addMonthsToYearMonth, yearMonthToDateRange, isValidYearMonth } from '@application/use-cases/finance/financeDates';
import { firstActivationDate, isContractActiveAt } from '@application/use-cases/finance/contractLifecycle';

/** Ages reported by the retention matrix (spec.md "Retention cohorts at 3/6/12 months"). */
const COHORT_AGES_MONTHS = [3, 6, 12] as const;

/**
 * finance-growth Fase 3 (design.md Decision 4, spec.md "Retention cohorts at
 * 3/6/12 months") — groups contracts by their alta ("activated"/
 * "reactivated") month and reports how many are still active 3/6/12 months
 * later. A cohort younger than an age NEVER gets that age's row (spec.md "no
 * inventa un dato que no puede existir aún") — gated by `now()` (injectable
 * clock, defaults to the real clock; tests pin it).
 *
 * Scoped to the INTERNET `ServiceCatalog`, same as `BuildFinanceMonthlySnapshot`
 * (see that use case's docblock point 1) — this dashboard's retention
 * question is about internet contracts.
 */
export class BuildFinanceCohortSnapshot {
  constructor(
    private readonly eventRepo: ContractServiceEventRepository,
    private readonly catalogRepo: ServiceCatalogRepository,
    private readonly cohortRepo: FinanceCohortSnapshotRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(cohortYearMonth: string): Promise<FinanceCohortSnapshot[]> {
    if (!isValidYearMonth(cohortYearMonth)) {
      throw new Error(`BuildFinanceCohortSnapshot: "${cohortYearMonth}" no es un YYYY-MM válido`);
    }

    const internet = await this.catalogRepo.getByName('INTERNET');
    if (!internet) {
      throw new Error('BuildFinanceCohortSnapshot: ServiceCatalog "INTERNET" no existe — catálogo mal seedeado');
    }

    const allEventsDesc = await this.eventRepo.list({ serviceCatalogId: internet.id });
    const eventsAsc = [...allEventsDesc].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));

    const eventsByContract = new Map<string, ContractServiceEventWithClient[]>();
    for (const e of eventsAsc) {
      const list = eventsByContract.get(e.contractId);
      if (list) list.push(e);
      else eventsByContract.set(e.contractId, [e]);
    }

    // A contract belongs to `cohortYearMonth` when its FIRST activation falls in that calendar month.
    const cohortContractIds = [...eventsByContract.entries()]
      .filter(([, events]) => {
        const firstAlta = firstActivationDate(events);
        return firstAlta && arYearMonth(firstAlta) === cohortYearMonth;
      })
      .map(([contractId]) => contractId);

    const originalCount = cohortContractIds.length;
    const asOf = this.now();
    const rows: FinanceCohortSnapshot[] = [];

    for (const monthsElapsed of COHORT_AGES_MONTHS) {
      const cutoffYearMonth = addMonthsToYearMonth(cohortYearMonth, monthsElapsed);
      const cutoffEndExclusive = yearMonthToDateRange(cutoffYearMonth).endExclusive;
      if (cutoffEndExclusive > asOf) continue; // cohort not old enough yet — never invent this data point

      const cutoffInstant = new Date(cutoffEndExclusive.getTime() - 1);
      const survivingCount = cohortContractIds.filter((id) => isContractActiveAt(eventsByContract.get(id) ?? [], cutoffInstant)).length;

      const row = await this.cohortRepo.upsert(cohortYearMonth, monthsElapsed, { originalCount, survivingCount });
      rows.push(row);
    }

    return rows;
  }
}
