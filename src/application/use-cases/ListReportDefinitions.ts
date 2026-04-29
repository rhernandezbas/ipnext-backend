import { ReportDefinition } from '@domain/entities/report';
import { InMemoryReportRepository } from '@infrastructure/adapters/in-memory/InMemoryReportRepository';

export class ListReportDefinitions {
  constructor(private readonly repo: InMemoryReportRepository) {}

  execute(): ReportDefinition[] {
    return this.repo.getDefinitions();
  }
}
