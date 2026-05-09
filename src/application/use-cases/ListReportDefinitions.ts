import { ReportDefinition } from '@domain/entities/report';
import { ReportRepository } from '@domain/ports/ReportRepository';

export class ListReportDefinitions {
  constructor(private readonly repo: ReportRepository) {}

  execute(): ReportDefinition[] {
    return this.repo.getDefinitions();
  }
}
