import { ReportType, ReportResult } from '@domain/entities/report';
import { InMemoryReportRepository } from '@infrastructure/adapters/in-memory/InMemoryReportRepository';

export class GenerateReport {
  constructor(private readonly repo: InMemoryReportRepository) {}

  execute(type: ReportType, filters: Record<string, string>): ReportResult {
    return this.repo.generateReport(type, filters);
  }
}
